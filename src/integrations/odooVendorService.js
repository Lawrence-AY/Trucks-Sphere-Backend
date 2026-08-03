const axios = require('axios');

const REQUEST_TIMEOUT_MS = 20_000;
const MIN_REQUEST_INTERVAL_MS = 400;

let nextOdooRequestAt = 0;

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

/**
 * Map an Odoo supplier Contact to the fields TruckSphere owns. Account
 * credentials and locally maintained compliance documents are deliberately
 * omitted, so an Odoo refresh cannot alter them.
 */
function odooPartnerToVendor(partner) {
  const companyName = textOrUndefined(partner?.name) || `Odoo Vendor ${partner?.id || ''}`.trim();
  const phone = textOrUndefined(partner?.phone) || textOrUndefined(partner?.mobile);

  return {
    odooPartnerId: Number.isInteger(partner?.id) ? partner.id : undefined,
    odooSyncedAt: new Date().toISOString(),
    companyName,
    contactPerson: companyName,
    email: textOrUndefined(partner?.email),
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
    fields: ['id', 'name', 'vat', 'email', 'phone', 'is_company', 'supplier_rank', 'active'],
    limit: 500,
  });
  return Array.isArray(records) ? records : [];
}

module.exports = {
  fetchOdooVendors,
  odooPartnerToVendor,
  __testables: { odooPartnerToVendor, textOrUndefined },
};
