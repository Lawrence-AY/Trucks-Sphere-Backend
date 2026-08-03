const axios = require('axios');

const REQUEST_TIMEOUT_MS = 20_000;
const MIN_REQUEST_INTERVAL_MS = 400;

let nextOdooRequestAt = 0;

function integrationError(message, statusCode = 502) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = 'ODOO_DRIVER_SYNC_FAILED';
  return error;
}

function getConfig() {
  const baseUrl = String(process.env.ODOO_BASE_URL || '').trim().replace(/\/+$/, '');
  const apiKey = String(process.env.ODOO_API_KEY || '').trim();
  const database = String(process.env.ODOO_DATABASE || '').trim();
  if (!baseUrl || !apiKey) {
    throw integrationError('Odoo driver integration is not configured.', 503);
  }

  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    throw integrationError('Odoo driver integration has an invalid URL.', 503);
  }
  if (url.protocol !== 'https:') {
    throw integrationError('Odoo driver integration must use HTTPS.', 503);
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
    'User-Agent': 'TruckSphere Driver Integration/1.0',
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
      throw integrationError('Unable to synchronize drivers with Odoo.');
    }

    if (response.status === 429 && attempt < 2) {
      const retryAfter = Number(response.headers?.['retry-after']);
      await delay(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : (attempt + 1) * 1500);
      continue;
    }
    if (response.status < 200 || response.status >= 300) {
      // Response bodies can contain driver data, so only log the compact error.
      console.error(`[Odoo] ${model}.${method} failed (${response.status}): ${responseMessage(response)}`);
      throw integrationError('Unable to synchronize drivers with Odoo.');
    }
    return response.data;
  }

  throw integrationError('Unable to synchronize drivers with Odoo.');
}

function textOrUndefined(value) {
  const text = String(value || '').trim();
  return text || undefined;
}

function withoutUndefined(source) {
  return Object.fromEntries(Object.entries(source).filter(([, value]) => value !== undefined));
}

function many2oneId(value) {
  if (Number.isInteger(value)) return value;
  if (Array.isArray(value) && Number.isInteger(value[0])) return value[0];
  return undefined;
}

function driverStatus(value) {
  return String(value || '').trim().toLowerCase() === 'authorized' ? 'active' : 'inactive';
}

/**
 * The Odoo Authorized Driver model has a direct many2one Vendor field. The
 * fingerprint template is intentionally never requested or copied.
 */
function odooDriverToDriver(record) {
  const status = driverStatus(record?.x_studio_status);
  const name = textOrUndefined(record?.x_name) || `Odoo Driver ${record?.id || ''}`.trim();
  return withoutUndefined({
    odooDriverId: Number.isInteger(record?.id) ? record.id : undefined,
    odooVendorPartnerId: many2oneId(record?.x_studio_vendor),
    odooDriverStatus: textOrUndefined(record?.x_studio_status),
    odooSyncedAt: new Date().toISOString(),
    name,
    fullName: name,
    nationalId: textOrUndefined(record?.x_studio_national_id),
    licenseNumber: textOrUndefined(record?.x_studio_driving_licence),
    status,
    availability: status === 'active',
  });
}

async function fetchOdooDrivers() {
  const records = await callOdoo('x_authorized_driver', 'search_read', {
    domain: [],
    fields: [
      'id',
      'x_name',
      'x_studio_national_id',
      'x_studio_vendor',
      'x_studio_driving_licence',
      'x_studio_status',
    ],
    limit: 500,
  });
  return Array.isArray(records) ? records : [];
}

module.exports = {
  fetchOdooDrivers,
  odooDriverToDriver,
  __testables: { driverStatus, many2oneId, odooDriverToDriver, withoutUndefined },
};
