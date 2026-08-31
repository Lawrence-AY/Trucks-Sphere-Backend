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
    throw integrationError(
      error.code === 'ECONNABORTED'
        ? 'Odoo is taking longer than expected. TruckSphere saved this delivery; its Odoo confirmation is pending and can be retried safely.'
        : 'TruckSphere saved this delivery, but it could not reach Odoo to confirm the receipt. Please retry the Odoo confirmation when the connection is available.',
    );
  }

  if (response.status < 200 || response.status >= 300) {
    // Do not log response bodies or headers: they can contain supplier data
    // and the authorization key.
    console.error(`[Odoo] ${model}.${method} failed (${response.status}): ${responseErrorMessage(response)}`);
    throw integrationError('TruckSphere saved this delivery, but Odoo could not confirm the receipt yet. Please retry the Odoo confirmation; no duplicate receipt will be created.');
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
  const linkedReceiptId = Number(deliveryOrder?.odooReceiptId);
  if (Number.isInteger(linkedReceiptId)) {
    const linkedReceipt = await readOne('stock.picking', linkedReceiptId, RECEIPT_FIELDS);
    if (linkedReceipt?.id && linkedReceipt.picking_type_code === 'incoming' && !['done', 'cancel'].includes(linkedReceipt.state)) {
      return linkedReceipt;
    }
  }

  const jobId = String(deliveryOrder?.jobId || '').trim();
  if (jobId) {
    const records = await searchRead('stock.picking', [
      ['origin', '=', jobId],
      ['picking_type_code', '=', 'incoming'],
      ['state', 'not in', ['done', 'cancel']],
    ], RECEIPT_FIELDS);
    if (records.length) return records[0];
  }

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

function plannedQuantity(deliveryOrder = {}, purchaseOrder = {}) {
  const quantity = Number(
    deliveryOrder.quantityOrdered ??
    deliveryOrder.quantity ??
    purchaseOrder.quantity ??
    0,
  );
  return Number.isFinite(quantity) && quantity > 0 ? quantity : null;
}

function withoutUndefined(values) {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined));
}

function numberOrUndefined(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

async function findFleetTruckId(deliveryOrder = {}, vehicle = {}) {
  const linkedId = Number(deliveryOrder.odooFleetVendorId || deliveryOrder.odooTruckId || vehicle.odooFleetVendorId || vehicle.odooTruckId);
  if (Number.isInteger(linkedId)) return linkedId;
  const registration = String(deliveryOrder.plateNumber || vehicle.registrationNumber || vehicle.plateNumber || '').trim();
  if (!registration) return undefined;
  const fields = ['id'];
  const byRegistration = await searchRead('x_fleet_vendors', [['x_studio_registration_number', '=', registration]], fields);
  if (byRegistration[0]?.id) return byRegistration[0].id;
  const byFleetRegistration = await searchRead('x_fleet_vendors', [['x_name', '=', registration]], fields);
  return byFleetRegistration[0]?.id;
}

async function ensureOdooDriverId(deliveryOrder = {}, driver = {}, vendorId) {
  const linkedId = Number(driver.odooDriverId || deliveryOrder.odooDriverId);
  if (Number.isInteger(linkedId)) return linkedId;

  const nationalId = String(driver.nationalId || deliveryOrder.driverNationalId || '').trim();
  const name = String(driver.fullName || driver.name || deliveryOrder.driverName || '').trim();
  if (!nationalId && !name) return undefined;

  const domain = nationalId
    ? [['x_studio_national_id', '=', nationalId]]
    : [['x_name', '=', name]];
  const existing = await searchRead('x_authorized_driver', domain, ['id']);
  if (existing[0]?.id) return existing[0].id;

  // A job must not leave an otherwise valid receipt without its driver just
  // because the driver was created first in TruckSphere. National ID is the
  // stable de-duplication key shared by both systems.
  return createOne('x_authorized_driver', withoutUndefined({
    x_name: name || nationalId,
    x_studio_national_id: nationalId || undefined,
    x_studio_driving_licence: String(driver.licenseNumber || driver.license || '').trim() || undefined,
    x_studio_vendor: Number.isInteger(vendorId) ? vendorId : undefined,
  }));
}

async function ensureOdooTruckId(deliveryOrder = {}, vehicle = {}, vendorId) {
  const foundId = await findFleetTruckId(deliveryOrder, vehicle);
  if (Number.isInteger(foundId)) return foundId;

  const registration = String(deliveryOrder.plateNumber || vehicle.registrationNumber || vehicle.plateNumber || '').trim();
  if (!registration) return undefined;

  // The Fleet Vendors model uses Fleet Registration as its required name;
  // retain the actual plate in its dedicated registration-number field too.
  return createOne('x_fleet_vendors', withoutUndefined({
    x_name: registration,
    x_studio_registration_number: registration,
    x_studio_vendor: Number.isInteger(vendorId) ? vendorId : undefined,
  }));
}

async function receiptContextValues({ deliveryOrder = {}, purchaseOrder = {}, vendor = {}, driver = {}, vehicle = {} }) {
  const vendorId = Number(vendor.odooPartnerId || deliveryOrder.odooVendorPartnerId);
  const purchaseOrderId = Number(purchaseOrder.odooPurchaseOrderId || deliveryOrder.odooPurchaseOrderId);
  const [driverId, truckId] = await Promise.all([
    ensureOdooDriverId(deliveryOrder, driver, vendorId),
    ensureOdooTruckId(deliveryOrder, vehicle, vendorId),
  ]);
  const originWeight = numberOrUndefined(
    deliveryOrder.originWeighbridgeReading ??
    deliveryOrder.weighOutWeight ??
    deliveryOrder.quarryWeighOutWeight ??
    deliveryOrder.weighInWeight,
  );
  return withoutUndefined({
    x_studio_purchase_order: Number.isInteger(purchaseOrderId) ? purchaseOrderId : undefined,
    x_studio_vendor: Number.isInteger(vendorId) ? vendorId : undefined,
    x_studio_driver: Number.isInteger(driverId) ? driverId : undefined,
    x_studio_truck: truckId,
    x_studio_origin_weighbridge_reading: originWeight,
  });
}

async function findIncomingPickingType() {
  const records = await searchRead(
    'stock.picking.type',
    [['code', '=', 'incoming'], ['active', '=', true]],
    ['id', 'default_location_src_id', 'default_location_dest_id'],
  );
  const pickingType = records[0];
  if (!pickingType?.id || !odooMany2oneId(pickingType.default_location_src_id) || !odooMany2oneId(pickingType.default_location_dest_id)) {
    throw integrationError('Odoo does not have an active incoming receipt operation type.', 409, 'ODOO_RECEIPT_TYPE_NOT_FOUND');
  }
  return pickingType;
}

/**
 * Create one incoming receipt per TruckSphere job. Purchase orders in this
 * Odoo database do not automatically generate stock pickings, so relying on
 * a PO-origin lookup leaves a completed site delivery with nothing to update.
 */
async function createJobReceipt({ deliveryOrder, purchaseOrder, material, vendor, driver, vehicle }) {
  const jobId = String(deliveryOrder?.jobId || deliveryOrder?.id || '').trim();
  const quantity = plannedQuantity(deliveryOrder, purchaseOrder);
  if (!jobId || quantity === null) {
    throw integrationError('A job ID and planned quantity are required to create the Odoo receipt.', 409, 'ODOO_JOB_RECEIPT_DATA_MISSING');
  }

  const existing = await searchRead('stock.picking', [
    ['origin', '=', jobId],
    ['picking_type_code', '=', 'incoming'],
  ], RECEIPT_FIELDS);

  const [pickingType, productId] = await Promise.all([
    findIncomingPickingType(),
    findProductVariantId(material, deliveryOrder),
  ]);
  if (!productId) {
    throw integrationError('The job material is not linked to an Odoo product.', 409, 'ODOO_RECEIPT_PRODUCT_NOT_FOUND');
  }
  const product = await readOne('product.product', productId, ['id', 'uom_id']);
  const uomId = odooMany2oneId(product?.uom_id);
  if (!uomId) {
    throw integrationError('The Odoo product has no usable unit of measure.', 409, 'ODOO_RECEIPT_UOM_NOT_FOUND');
  }

  const sourceLocationId = odooMany2oneId(pickingType.default_location_src_id);
  const destinationLocationId = odooMany2oneId(pickingType.default_location_dest_id);
  const contextValues = await receiptContextValues({ deliveryOrder, purchaseOrder, vendor, driver, vehicle });
  const receiptId = existing[0]?.id || await createOne('stock.picking', {
    picking_type_id: pickingType.id,
    location_id: sourceLocationId,
    location_dest_id: destinationLocationId,
    origin: jobId,
    ...contextValues,
  });
  if (existing[0]?.id && Object.keys(contextValues).length) await writeOne('stock.picking', receiptId, contextValues);
  const moves = await searchRead('stock.move', [['picking_id', '=', receiptId]], ['id'], 2);
  if (!moves.length) {
    await createOne('stock.move', {
      // Odoo 19 exposes the picking description field instead of the legacy
      // stock.move.name field used by older Odoo releases.
      description_picking: material?.name || deliveryOrder?.materialName || jobId,
      reference: jobId,
      picking_id: receiptId,
      product_id: productId,
      product_uom_qty: quantity,
      uom_id: uomId,
      location_id: sourceLocationId,
      location_dest_id: destinationLocationId,
    });
    await callOdoo('stock.picking', 'action_confirm', { ids: [receiptId] });
  }
  const receipt = await readOne('stock.picking', receiptId, RECEIPT_FIELDS);
  if (!receipt?.id) throw integrationError('Odoo did not return the job receipt after creation.');

  return {
    odooReceiptId: receipt.id,
    odooReceiptNumber: receipt.name || '',
    odooReceiptState: receipt.state || '',
    odooReceiptSyncStatus: 'synced',
    odooReceiptSyncedAt: new Date().toISOString(),
  };
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
async function syncSiteReceipt({ deliveryOrder, purchaseOrder, material, vendor, driver, vehicle }) {
  const quantity = deliveredQuantity(deliveryOrder);
  if (quantity === null) {
    throw integrationError('A positive delivered quantity is required to synchronize an Odoo receipt.', 409, 'ODOO_RECEIPT_QUANTITY_MISSING');
  }

  let receipt;
  try {
    receipt = await findOpenIncomingReceipt(purchaseOrder, deliveryOrder);
  } catch (error) {
    // Jobs created before the job-receipt integration have no Odoo receipt.
    // Create the same deterministic job receipt on retry, then continue with
    // the normal site-weight posting flow.
    if (error.code !== 'ODOO_RECEIPT_NOT_FOUND') throw error;
    const createdReceipt = await createJobReceipt({ deliveryOrder, purchaseOrder, material, vendor, driver, vehicle });
    receipt = await readOne('stock.picking', createdReceipt.odooReceiptId, RECEIPT_FIELDS);
    if (!receipt?.id) throw integrationError('Odoo did not return the created job receipt.');
  }
  const contextValues = await receiptContextValues({ deliveryOrder, purchaseOrder, vendor, driver, vehicle });
  if (Object.keys(contextValues).length) await writeOne('stock.picking', receipt.id, contextValues);
  // An earlier failed job receipt may exist without a move. Re-run the
  // idempotent setup before applying the final site quantity.
  await createJobReceipt({ deliveryOrder, purchaseOrder, material, vendor, driver, vehicle });
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
  createJobReceipt,
  __testables: {
    extractId,
    odooMany2oneId,
    deliveredQuantity,
    plannedQuantity,
    receiptContextValues,
    receiptReferences,
    isBackorderConfirmation,
    withDeliveryNote,
    ensureOdooDriverId,
    ensureOdooTruckId,
  },
};
