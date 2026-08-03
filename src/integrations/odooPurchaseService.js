const axios = require('axios');

const REQUEST_TIMEOUT_MS = 20_000;
const CLIENT_REFERENCE_PREFIX = 'TruckSphere:';

function integrationError(message, statusCode = 502) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = 'ODOO_SYNC_FAILED';
  return error;
}

function getConfig() {
  const baseUrl = String(process.env.ODOO_BASE_URL || '').trim().replace(/\/+$/, '');
  const apiKey = String(process.env.ODOO_API_KEY || '').trim();
  const database = String(process.env.ODOO_DATABASE || '').trim();

  if (!baseUrl || !apiKey) {
    throw integrationError('Odoo purchase-order integration is not configured.', 503);
  }

  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    throw integrationError('Odoo purchase-order integration has an invalid URL.', 503);
  }
  if (url.protocol !== 'https:') {
    throw integrationError('Odoo purchase-order integration must use HTTPS.', 503);
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

function odooErrorMessage(response) {
  const status = response?.status;
  const message = String(response?.data?.message || '').replace(/[\r\n]+/g, ' ').slice(0, 280);
  return message || `HTTP ${status || 'network error'}`;
}

async function callOdoo(model, method, body) {
  const config = getConfig();
  const headers = {
    Authorization: `Bearer ${config.apiKey}`,
    'Content-Type': 'application/json; charset=utf-8',
    'User-Agent': 'TruckSphere Purchase Integration/1.0',
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
    throw integrationError('Unable to synchronize the purchase order with Odoo.');
  }

  if (response.status < 200 || response.status >= 300) {
    // Deliberately exclude request headers/body so API credentials and supplier
    // data never reach application logs.
    console.error(`[Odoo] ${model}.${method} failed (${response.status}): ${odooErrorMessage(response)}`);
    throw integrationError('Unable to synchronize the purchase order with Odoo.');
  }

  return response.data;
}

async function findFirst(model, domain, fields) {
  const records = await callOdoo(model, 'search_read', { domain, fields, limit: 1 });
  return Array.isArray(records) && records.length ? records[0] : null;
}

async function createOne(model, values) {
  const result = await callOdoo(model, 'create', { vals_list: values });
  const id = extractId(result);
  if (!id) {
    console.error(`[Odoo] ${model}.create returned no record ID`);
    throw integrationError('Odoo did not return a purchase-order record ID.');
  }
  return id;
}

function supplierReference(vendor) {
  return `${CLIENT_REFERENCE_PREFIX}vendor:${vendor.id}`;
}

function productReference(material) {
  // Odoo's native Internal Reference holds the TruckSphere material code.
  // This lets the material catalogue and purchase-order flows use one product.
  return String(material.id || material.materialId || '').trim();
}

function purchaseOrderReference(purchaseOrder) {
  return `${CLIENT_REFERENCE_PREFIX}${purchaseOrder.poNumber}`;
}

function unitCandidates(unit) {
  const normalized = String(unit || '').trim().toLowerCase();
  const aliases = {
    tonnes: ['Ton(s)', 'Tonne', 'Tons', 'Ton'],
    tonne: ['Ton(s)', 'Tonne', 'Tons', 'Ton'],
    tons: ['Ton(s)', 'Tons', 'Ton', 'Tonne'],
    ton: ['Ton(s)', 'Tons', 'Ton', 'Tonne'],
    kilograms: ['kg', 'Kilogram'],
    kilogram: ['kg', 'Kilogram'],
    kgs: ['kg', 'Kilogram'],
    kg: ['kg', 'Kilogram'],
    litres: ['Litre(s)', 'Litres', 'Litre', 'Liters', 'Liter'],
    litre: ['Litre(s)', 'Litres', 'Litre', 'Liters', 'Liter'],
    liters: ['Litre(s)', 'Liters', 'Liter', 'Litres', 'Litre'],
    liter: ['Litre(s)', 'Liters', 'Liter', 'Litres', 'Litre'],
    metres: ['m', 'Meter'],
    metre: ['m', 'Meter'],
    meters: ['m', 'Meter'],
    meter: ['m', 'Meter'],
    millimetres: ['mm', 'Millimeter'],
    millimeters: ['mm', 'Millimeter'],
    millimeter: ['mm', 'Millimeter'],
    pieces: ['Units', 'Unit(s)', 'Piece'],
    piece: ['Units', 'Unit(s)', 'Piece'],
    bags: ['Units', 'Unit(s)', 'Bag'],
    bag: ['Units', 'Unit(s)', 'Bag'],
    units: ['Units', 'Unit(s)'],
    unit: ['Units', 'Unit(s)'],
  };
  return [...new Set([String(unit || '').trim(), ...(aliases[normalized] || []), 'Units', 'Unit(s)'].filter(Boolean))];
}

async function findUnitOfMeasure(unit) {
  for (const name of unitCandidates(unit)) {
    const record = await findFirst('uom.uom', [['name', '=ilike', name]], ['id', 'name']);
    if (record?.id) return record.id;
  }
  throw integrationError('No compatible Odoo unit of measure was found for this material.');
}

async function findOrCreateSupplier(vendor) {
  // Vendors imported from Odoo Contacts retain the partner ID. Reuse that
  // record for purchase orders instead of creating a duplicate supplier.
  if (Number.isInteger(vendor.odooPartnerId)) {
    const linkedPartner = await findFirst('res.partner', [['id', '=', vendor.odooPartnerId]], ['id']);
    if (linkedPartner?.id) return linkedPartner.id;
  }

  const reference = supplierReference(vendor);
  const existing = await findFirst('res.partner', [['ref', '=', reference]], ['id', 'name']);
  if (existing?.id) return existing.id;

  return createOne('res.partner', {
    name: vendor.companyName || vendor.name || vendor.id,
    is_company: true,
    supplier_rank: 1,
    ref: reference,
    phone: vendor.phone || false,
    email: vendor.email || false,
    vat: vendor.kraPin || false,
  });
}

async function findOrCreateProduct(material, unit) {
  const reference = productReference(material);
  if (Number.isInteger(material.odooProductTemplateId)) {
    const syncedProduct = await findFirst(
      'product.product',
      [['product_tmpl_id', '=', material.odooProductTemplateId]],
      ['id', 'uom_id'],
    );
    if (syncedProduct?.id) {
      return { id: syncedProduct.id, uomId: odooMany2oneId(syncedProduct.uom_id) };
    }
  }
  const existing = await findFirst('product.product', [['default_code', '=', reference]], ['id', 'uom_id']);
  if (existing?.id) {
    return { id: existing.id, uomId: odooMany2oneId(existing.uom_id) };
  }

  const uomId = await findUnitOfMeasure(unit);
  const templateId = await createOne('product.template', {
    name: material.name || material.id,
    default_code: reference,
    purchase_ok: true,
    sale_ok: false,
    uom_id: uomId,
  });
  const product = await findFirst('product.product', [['product_tmpl_id', '=', templateId]], ['id', 'uom_id']);
  if (!product?.id) {
    throw integrationError('Odoo did not create a product variant for this material.');
  }
  return { id: product.id, uomId: odooMany2oneId(product.uom_id) || uomId };
}

async function findExistingPurchaseOrder(reference) {
  return findFirst(
    'purchase.order',
    // `partner_ref` is Odoo Purchase's native Vendor Reference field. It is
    // the Purchase equivalent of Sales' `client_order_ref` and is available
    // on this Odoo instance.
    [['partner_ref', '=', reference]],
    ['id', 'name', 'state', 'partner_ref'],
  );
}

async function confirmPurchaseOrder(id) {
  const order = await callOdoo('purchase.order', 'read', { ids: [id], fields: ['id', 'name', 'state'] });
  const record = Array.isArray(order) ? order[0] : null;
  if (!record?.id) throw integrationError('Odoo did not return the purchase order it created.');

  if (record.state === 'draft' || record.state === 'sent') {
    await callOdoo('purchase.order', 'button_confirm', { ids: [id] });
  }

  const confirmed = await callOdoo('purchase.order', 'read', { ids: [id], fields: ['id', 'name', 'state'] });
  return Array.isArray(confirmed) && confirmed[0] ? confirmed[0] : record;
}

/**
 * Create the matching Odoo purchase order. Supplier and product references are
 * stable TruckSphere-owned keys, so retries reuse their prior Odoo records.
 */
async function syncPurchaseOrder({ purchaseOrder, vendor, material }) {
  const reference = purchaseOrderReference(purchaseOrder);
  let remoteOrder = await findExistingPurchaseOrder(reference);

  if (!remoteOrder?.id) {
    const [partnerId, product] = await Promise.all([
      findOrCreateSupplier(vendor),
      findOrCreateProduct(material, purchaseOrder.unit),
    ]);
    const unitPrice = Number(material.unitPrice);
    const orderId = await createOne('purchase.order', {
      partner_id: partnerId,
      partner_ref: reference,
      origin: purchaseOrder.poNumber,
      order_line: [[0, 0, {
        product_id: product.id,
        name: material.name || purchaseOrder.materialName || material.id,
        product_qty: Number(purchaseOrder.quantity),
        // This Odoo instance exposes the purchase-line UoM as `uom_id`.
        uom_id: product.uomId,
        price_unit: Number.isFinite(unitPrice) && unitPrice >= 0 ? unitPrice : 0,
      }]],
    });
    remoteOrder = { id: orderId };
  }

  const confirmed = await confirmPurchaseOrder(remoteOrder.id);
  return {
    odooPurchaseOrderId: confirmed.id,
    odooPurchaseOrderNumber: confirmed.name || '',
    odooPurchaseOrderState: confirmed.state || '',
    odooSyncedAt: new Date().toISOString(),
  };
}

module.exports = {
  syncPurchaseOrder,
  // Exported for focused unit tests without exposing configuration or secrets.
  __testables: { extractId, odooMany2oneId, unitCandidates },
};
