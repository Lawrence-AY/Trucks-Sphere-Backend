const axios = require('axios');

const REQUEST_TIMEOUT_MS = 20_000;
const MIN_REQUEST_INTERVAL_MS = 400;

let nextOdooRequestAt = 0;
const TRUCKSPHERE_VENDOR_REFERENCE_PREFIX = 'TruckSphere:vendor:';

function integrationError(message, statusCode = 502) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = 'ODOO_VENDOR_SYNC_FAILED';
  return error;
}

function getConfig() {
  const baseUrl = String(process.env.ODOO_BASE_URL || '').trim().replace(/\/+$/, '');
  const apiKey = String(process.env.ODOO_API_KEY || '').trim();
  const database = String(process.env.ODOO_DATABASE || '').trim();
  if (!baseUrl || !apiKey) {
    throw integrationError('Odoo vendor integration is not configured.', 503);
  }

  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    throw integrationError('Odoo vendor integration has an invalid URL.', 503);
  }
  if (url.protocol !== 'https:') {
    throw integrationError('Odoo vendor integration must use HTTPS.', 503);
  }
  return { baseUrl: url.toString().replace(/\/$/, ''), apiKey, database };
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForOdooRequestSlot() {
  const now = Date.now();
  const scheduledAt = Math.max(now, nextOdooRequestAt);
  nextOdooRequestAt = scheduledAt + MIN_REQUEST_INTERVAL_MS;
  if (scheduledAt > now) await delay(scheduledAt - now);
}

function responseMessage(response) {
  const message = String(response?.data?.message || '').replace(/[\r\n]+/g, ' ').slice(0, 280);
  return message || `HTTP ${response?.status || 'network error'}`;
}

async function callOdoo(model, method, body) {
  const config = getConfig();
  const headers = {
    Authorization: `Bearer ${config.apiKey}`,
    'Content-Type': 'application/json; charset=utf-8',
    'User-Agent': 'TruckSphere Vendor Integration/1.0',
  };
  if (config.database) headers['X-Odoo-Database'] = config.database;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    let response;
    try {
      await waitForOdooRequestSlot();
      response = await axios.post(`${config.baseUrl}/json/2/${model}/${method}`, body, {
        headers,
        timeout: REQUEST_TIMEOUT_MS,
        validateStatus: () => true,
      });
    } catch (error) {
      const cause = error.code === 'ECONNABORTED' ? 'request timed out' : 'network request failed';
      console.error(`[Odoo] ${model}.${method} ${cause}`);
      throw integrationError('Unable to synchronize vendors with Odoo.');
    }

    if (response.status === 429 && attempt < 2) {
      const retryAfter = Number(response.headers?.['retry-after']);
      await delay(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : (attempt + 1) * 1500);
      continue;
    }
    if (response.status < 200 || response.status >= 300) {
      // Do not log the response body: it may contain supplier information.
      console.error(`[Odoo] ${model}.${method} failed (${response.status}): ${responseMessage(response)}`);
      throw integrationError('Unable to synchronize vendors with Odoo.');
    }
    return response.data;
  }

  throw integrationError('Unable to synchronize vendors with Odoo.');
}

function textOrUndefined(value) {
  const text = String(value || '').trim();
  return text || undefined;
}

function extractId(value) {
  if (Number.isInteger(value)) return value;
  if (Array.isArray(value)) return extractId(value[0]);
  if (value && typeof value === 'object' && Number.isInteger(value.id)) return value.id;
  return null;
}

async function findFirst(model, domain, fields) {
  const records = await callOdoo(model, 'search_read', { domain, fields, limit: 1 });
  return Array.isArray(records) && records.length ? records[0] : null;
}

async function createOne(model, values) {
  const id = extractId(await callOdoo(model, 'create', { vals_list: values }));
  if (!id) throw integrationError(`Odoo did not return an ID after creating ${model}.`);
  return id;
}

async function writeOne(model, id, values) {
  const result = await callOdoo(model, 'write', { ids: [id], vals: values });
  if (result !== true) throw integrationError(`Odoo did not confirm the ${model} update.`);
}

function vendorReference(vendor) {
  return `${TRUCKSPHERE_VENDOR_REFERENCE_PREFIX}${String(vendor?.id || vendor?.vendorId || '').trim()}`;
}

function vendorToPartnerValues(vendor) {
  return {
    name: String(vendor?.companyName || vendor?.name || vendor?.id || '').trim(),
    is_company: true,
    supplier_rank: 1,
    ref: vendorReference(vendor),
    active: String(vendor?.status || 'active').toLowerCase() !== 'inactive',
    phone: textOrUndefined(vendor?.phone) || false,
    email: textOrUndefined(vendor?.email) || false,
    vat: textOrUndefined(vendor?.kraPin) || false,
  };
}

function contactToPartnerValues(vendor, companyPartnerId) {
  return {
    name: String(vendor?.contactPerson || '').trim(),
    parent_id: companyPartnerId,
    type: 'contact',
    active: String(vendor?.status || 'active').toLowerCase() !== 'inactive',
    phone: textOrUndefined(vendor?.phone) || false,
    email: textOrUndefined(vendor?.email) || false,
  };
}

/**
 * Odoo Fleet selects its vendors from supplier Contacts (res.partner). Keep
 * every TruckSphere vendor linked to that native record so it is available in
 * both Purchase and Fleet without creating a separate custom Fleet entity.
 */
async function syncVendor(vendor) {
  if (!vendor?.id || !(vendor.companyName || vendor.name)) {
    throw integrationError('A vendor ID and company name are required for Odoo synchronization.', 400);
  }

  let partner = null;
  if (Number.isInteger(vendor.odooPartnerId)) {
    partner = await findFirst('res.partner', [['id', '=', vendor.odooPartnerId]], ['id']);
  }
  if (!partner?.id) {
    partner = await findFirst('res.partner', [['ref', '=', vendorReference(vendor)]], ['id']);
  }

  const values = vendorToPartnerValues(vendor);
  const partnerId = partner?.id || await createOne('res.partner', values);
  if (partner?.id) await writeOne('res.partner', partnerId, values);

  // A vendor company and its named contact are separate Contact records in
  // Odoo. Avoid a redundant child record when the submitted contact name is
  // simply the company name (the format used by imported Odoo suppliers).
  const contactName = String(vendor.contactPerson || '').trim();
  const companyName = String(vendor.companyName || vendor.name || '').trim();
  let contactPartnerId;
  if (contactName && contactName.toLowerCase() !== companyName.toLowerCase()) {
    let contact = null;
    if (Number.isInteger(vendor.odooContactPartnerId)) {
      contact = await findFirst('res.partner', [['id', '=', vendor.odooContactPartnerId]], ['id']);
    }
    if (!contact?.id) {
      contact = await findFirst('res.partner', [
        ['parent_id', '=', partnerId],
        ['name', '=', contactName],
      ], ['id']);
    }
    const contactValues = contactToPartnerValues(vendor, partnerId);
    contactPartnerId = contact?.id || await createOne('res.partner', contactValues);
    if (contact?.id) await writeOne('res.partner', contactPartnerId, contactValues);
  }

  return {
    odooPartnerId: partnerId,
    ...(contactPartnerId ? { odooContactPartnerId: contactPartnerId } : {}),
    odooSyncedAt: new Date().toISOString(),
  };
}

/**
 * Map an Odoo supplier Contact to the fields TruckSphere owns. Account
 * credentials and locally maintained compliance documents are deliberately
 * omitted, so an Odoo refresh cannot alter them.
 */
function odooPartnerToVendor(partner) {
  const companyName = textOrUndefined(partner?.name) || `Odoo Vendor ${partner?.id || ''}`.trim();
  const contact = partner?.trucksphereContact;
  const phone = textOrUndefined(partner?.phone) || textOrUndefined(partner?.mobile) || textOrUndefined(contact?.phone) || textOrUndefined(contact?.mobile);

  return {
    odooPartnerId: Number.isInteger(partner?.id) ? partner.id : undefined,
    odooContactPartnerId: Number.isInteger(contact?.id) ? contact.id : undefined,
    odooSyncedAt: new Date().toISOString(),
    companyName,
    contactPerson: textOrUndefined(contact?.name) || companyName,
    email: textOrUndefined(partner?.email) || textOrUndefined(contact?.email),
    phone,
    kraPin: textOrUndefined(partner?.vat),
    status: partner?.active === false ? 'inactive' : 'active',
  };
}

async function fetchOdooVendors({ partnerIds = [] } = {}) {
  const ids = [...new Set(partnerIds.filter(Number.isInteger))];
  const records = await callOdoo('res.partner', 'search_read', {
    // In Odoo, a Contact becomes a vendor/supplier when supplier_rank is
    // positive. Driver imports also request their explicitly linked Contacts
    // because not every Vendor relation is marked with supplier_rank.
    domain: ids.length ? [['id', 'in', ids]] : [['supplier_rank', '>', 0]],
    fields: ['id', 'name', 'vat', 'email', 'phone', 'mobile', 'is_company', 'supplier_rank', 'active', 'child_ids'],
    limit: 500,
  });
  if (!Array.isArray(records) || !records.length) return [];

  const childIds = [...new Set(records.flatMap((partner) => Array.isArray(partner.child_ids) ? partner.child_ids : []).filter(Number.isInteger))];
  if (!childIds.length) return records;
  const contacts = await callOdoo('res.partner', 'search_read', {
    domain: [['id', 'in', childIds], ['active', '=', true]],
    fields: ['id', 'name', 'email', 'phone', 'mobile', 'parent_id', 'active'],
    limit: 500,
  });
  const contactsByParentId = new Map();
  (Array.isArray(contacts) ? contacts : []).forEach((contact) => {
    const parentId = Array.isArray(contact.parent_id) ? contact.parent_id[0] : contact.parent_id;
    if (Number.isInteger(parentId) && !contactsByParentId.has(parentId)) contactsByParentId.set(parentId, contact);
  });
  return records.map((partner) => ({ ...partner, trucksphereContact: contactsByParentId.get(partner.id) }));
}

module.exports = {
  fetchOdooVendors,
  syncVendor,
  odooPartnerToVendor,
  __testables: { odooPartnerToVendor, textOrUndefined, vendorReference, vendorToPartnerValues, contactToPartnerValues },
};
