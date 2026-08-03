const axios = require('axios');

const REQUEST_TIMEOUT_MS = 20_000;
const TRUCKSPHERE_NOTE_PREFIX = '[TruckSphere';

function integrationError(message, statusCode = 502, code = 'ODOO_RECEIPT_SYNC_FAILED') {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function getConfig() {
  const baseUrl = String(process.env.ODOO_BASE_URL || '').trim().replace(/\/+$/, '');
  const apiKey = String(process.env.ODOO_API_KEY || '').trim();
  const database = String(process.env.ODOO_DATABASE || '').trim();

  if (!baseUrl || !apiKey) {
    throw integrationError('Odoo receipt integration is not configured.', 503);
  }

  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    throw integrationError('Odoo receipt integration has an invalid URL.', 503);
  }
  if (url.protocol !== 'https:') {
    throw integrationError('Odoo receipt integration must use HTTPS.', 503);
  }

  return { baseUrl: url.toString().replace(/\/$/, ''), apiKey, database };
}

function extractId(value) {
  if (Number.isInteger(value)) return value;
  if (Array.isArray(value)) return extractId(value[0]);
  if (value && typeof value === 'object' && Number.isInteger(value.id)) return value.id;
  return null;
}

function odooMany2oneId(value) {
  if (Number.isInteger(value)) return value;
  if (Array.isArray(value) && Number.isInteger(value[0])) return value[0];
  return null;
}

function responseErrorMessage(response) {
  const status = response?.status;
  const message = String(response?.data?.message || '').replace(/[\r\n]+/g, ' ').slice(0, 280);
  return message || `HTTP ${status || 'network error'}`;
}

async function callOdoo(model, method, body) {
  const config = getConfig();
  const headers = {
    Authorization: `Bearer ${config.apiKey}`,
    'Content-Type': 'application/json; charset=utf-8',
    'User-Agent': 'TruckSphere Receipt Integration/1.0',
  };
  if (config.database) headers['X-Odoo-Database'] = config.database;

  let response;
  try {
    response = await axios.post(`${config.baseUrl}/json/2/${model}/${method}`, body, {
      headers,
      timeout: REQUEST_TIMEOUT_MS,
      validateStatus: () => true,
    });
  } catch (error) {
    const cause = error.code === 'ECONNABORTED' ? 'request timed out' : 'network request failed';
    console.error(`[Odoo] ${model}.${method} ${cause}`);
    throw integrationError('Unable to synchronize the site receipt with Odoo.');
  }

  if (response.status < 200 || response.status >= 300) {
    // Do not log response bodies or headers: they can contain supplier data
    // and the authorization key.
    console.error(`[Odoo] ${model}.${method} failed (${response.status}): ${responseErrorMessage(response)}`);
    throw integrationError('Unable to synchronize the site receipt with Odoo.');
  }

  return response.data;
}

async function searchRead(model, domain, fields, limit = 1) {
  const records = await callOdoo(model, 'search_read', { domain, fields, limit });
  return Array.isArray(records) ? records : [];
}

async function readOne(model, id, fields) {
  const records = await callOdoo(model, 'read', { ids: [id], fields });
  return Array.isArray(records) && records.length ? records[0] : null;
}

async function writeOne(model, id, values) {
  await callOdoo(model, 'write', { ids: [id], vals: values });
}

async function createOne(model, values) {
  const result = await callOdoo(model, 'create', { vals_list: values });
  const id = extractId(result);
  if (!id) throw integrationError(`Odoo did not return an ID for ${model}.`);
  return id;
}

function deliveredQuantity(deliveryOrder = {}) {
  const candidates = [
    deliveryOrder.quantityDelivered,
    deliveryOrder.siteNetWeight,
    deliveryOrder.netWeight,
  ];
  for (const candidate of candidates) {
    const quantity = Number(candidate);
    if (Number.isFinite(quantity) && quantity > 0) return quantity;
  }
  return null;
}

function receiptReferences(purchaseOrder = {}, deliveryOrder = {}) {
  return [...new Set([
    purchaseOrder.odooPurchaseOrderNumber,
    deliveryOrder.odooPurchaseOrderNumber,
    purchaseOrder.poNumber,
    deliveryOrder.poNumber,
  ].map((value) => String(value || '').trim()).filter(Boolean))];
}

const RECEIPT_FIELDS = [
  'id', 'name', 'origin', 'state', 'picking_type_code', 'backorder_id', 'note',
];

async function findOpenIncomingReceipt(purchaseOrder, deliveryOrder) {
  const odooPurchaseOrderId = Number(purchaseOrder?.odooPurchaseOrderId);
  if (Number.isInteger(odooPurchaseOrderId)) {
    // Purchase Stock links an incoming picking to its purchase order. This is
    // the strongest match and prevents similarly named receipts being used.
    try {
      const records = await searchRead('stock.picking', [
        ['purchase_id', '=', odooPurchaseOrderId],
        ['picking_type_code', '=', 'incoming'],
        ['state', 'not in', ['done', 'cancel']],
      ], RECEIPT_FIELDS);
      if (records.length) return records[0];
    } catch (error) {
      // Some Odoo editions do not expose purchase_id through the API. The
      // confirmed PO number is a safe, deterministic fallback below.
      console.warn('[Odoo] Receipt lookup by purchase_id failed; trying receipt origin.');
    }
  }

  for (const origin of receiptReferences(purchaseOrder, deliveryOrder)) {
    const records = await searchRead('stock.picking', [
      ['origin', '=', origin],
      ['picking_type_code', '=', 'incoming'],
      ['state', 'not in', ['done', 'cancel']],
    ], RECEIPT_FIELDS);
    if (records.length) return records[0];
  }

  throw integrationError(
    'No open Odoo receipt was found for this purchase order.',
    409,
    'ODOO_RECEIPT_NOT_FOUND',
  );
}

async function findProductVariantId(material = {}, deliveryOrder = {}) {
  const linkedId = Number(material.odooProductVariantId || deliveryOrder.odooProductVariantId);
  if (Number.isInteger(linkedId)) return linkedId;

  const reference = String(material.id || material.materialId || deliveryOrder.materialId || '').trim();
  if (!reference) return null;

  const records = await searchRead(
    'product.product',
    [['default_code', '=', reference]],
    ['id'],
  );
  return records[0]?.id || null;
}

async function findReceiptMove(receiptId, material, deliveryOrder) {
  const moves = await searchRead(
    'stock.move',
    [['picking_id', '=', receiptId], ['state', 'not in', ['done', 'cancel']]],
    ['id', 'product_id', 'product_uom_qty', 'quantity', 'state'],
    100,
  );
  if (!moves.length) {
    throw integrationError('The open Odoo receipt has no receivable product line.', 409, 'ODOO_RECEIPT_MOVE_NOT_FOUND');
  }

  const productId = await findProductVariantId(material, deliveryOrder);
  if (productId) {
    const matchingMove = moves.find((move) => odooMany2oneId(move.product_id) === productId);
    if (matchingMove) return matchingMove;
  }

  // TruckSphere currently creates one material line per PO. Retain this
  // guarded fallback for older orders that predate the product ID mapping.
  if (moves.length === 1) return moves[0];
  throw integrationError(
    'Unable to match this delivery material to an Odoo receipt line.',
    409,
    'ODOO_RECEIPT_MOVE_MISMATCH',
  );
}

function isBackorderConfirmation(action) {
  return Boolean(action && typeof action === 'object' && action.res_model === 'stock.backorder.confirmation');
}

async function validateReceipt(receiptId) {
  const validationResult = await callOdoo('stock.picking', 'button_validate', { ids: [receiptId] });
  if (!isBackorderConfirmation(validationResult)) return;

  // JSON-2 cannot interact with the UI wizard. Recreate the wizard's picked
  // receipt programmatically, then process it exactly as Odoo's Confirm
  // button would. Odoo creates the native linked backorder in this step.
  const wizardId = await createOne('stock.backorder.confirmation', {
    pick_ids: [[6, 0, [receiptId]]],
  });
  await callOdoo('stock.backorder.confirmation', 'process', { ids: [wizardId] });
}

async function findCreatedBackorder(receiptId) {
  const records = await searchRead('stock.picking', [
    ['backorder_id', '=', receiptId],
  ], RECEIPT_FIELDS);
  return records[0] || null;
}

function deliveryNoteUrl(deliveryOrder = {}) {
  return String(deliveryOrder.deliveryNoteURL || deliveryOrder.photoURL || '').trim();
}

function withDeliveryNote(existingNote, deliveryOrder) {
  const noteUrl = deliveryNoteUrl(deliveryOrder);
  const jobId = String(deliveryOrder.jobId || deliveryOrder.id || '').trim();
  if (!noteUrl || !jobId) return existingNote || '';

  const marker = `${TRUCKSPHERE_NOTE_PREFIX} ${jobId}]`;
  if (String(existingNote || '').includes(marker)) return existingNote || '';
  return [
    String(existingNote || '').trim(),
    `${marker} delivery note: ${noteUrl}`,
  ].filter(Boolean).join('\n');
}

/**
 * Record a completed site receipt in Odoo. A short delivery sets the Odoo
 * receipt's actual quantity and validates it; Odoo then creates its native
 * stock.picking backorder, visible directly under Inventory > Receipts.
 */
async function syncSiteReceipt({ deliveryOrder, purchaseOrder, material }) {
  const quantity = deliveredQuantity(deliveryOrder);
  if (quantity === null) {
    throw integrationError('A positive delivered quantity is required to synchronize an Odoo receipt.', 409, 'ODOO_RECEIPT_QUANTITY_MISSING');
  }

  const receipt = await findOpenIncomingReceipt(purchaseOrder, deliveryOrder);
  const move = await findReceiptMove(receipt.id, material, deliveryOrder);
  await writeOne('stock.move', move.id, { quantity });

  const note = withDeliveryNote(receipt.note, deliveryOrder);
  if (note && note !== receipt.note) {
    await writeOne('stock.picking', receipt.id, { note });
  }

  await validateReceipt(receipt.id);

  const completedReceipt = await readOne('stock.picking', receipt.id, RECEIPT_FIELDS);
  if (!completedReceipt?.id) {
    throw integrationError('Odoo did not return the receipt after validation.');
  }
  const odooBackorder = await findCreatedBackorder(receipt.id);
  const now = new Date().toISOString();

  return {
    source: {
      odooReceiptId: completedReceipt.id,
      odooReceiptNumber: completedReceipt.name || '',
      odooReceiptState: completedReceipt.state || '',
      odooReceiptSyncStatus: 'synced',
      odooReceiptSyncedAt: now,
      ...(odooBackorder ? {
        odooBackorderReceiptId: odooBackorder.id,
        odooBackorderReceiptNumber: odooBackorder.name || '',
        odooBackorderReceiptState: odooBackorder.state || '',
      } : {}),
    },
    backorder: odooBackorder ? {
      odooReceiptId: odooBackorder.id,
      odooReceiptNumber: odooBackorder.name || '',
      odooReceiptState: odooBackorder.state || '',
      odooReceiptSyncStatus: 'synced',
      odooReceiptSyncedAt: now,
      odooSourceReceiptId: completedReceipt.id,
      odooSourceReceiptNumber: completedReceipt.name || '',
    } : null,
  };
}

module.exports = {
  syncSiteReceipt,
  __testables: {
    extractId,
    odooMany2oneId,
    deliveredQuantity,
    receiptReferences,
    isBackorderConfirmation,
    withDeliveryNote,
  },
};
