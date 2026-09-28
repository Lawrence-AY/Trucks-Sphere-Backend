const axios = require('axios');

const REQUEST_TIMEOUT_MS = 20_000;

function iprsError(code, statusCode = 422) {
  return Object.assign(new Error(code), { code, statusCode });
}

function isIprsEnabled() {
  return String(process.env.IPRS_ENABLED || '').trim().toLowerCase() === 'true';
}

function requiredText(value) {
  return String(value || '').trim();
}

function normalizeName(value) {
  return requiredText(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/gi, '').toUpperCase();
}

function getConfig() {
  const baseUrl = requiredText(process.env.IPRS_URL).replace(/\/+$/, '');
  const username = requiredText(process.env.IPRS_USERNAME);
  const password = requiredText(process.env.IPRS_PASSWORD);
  const sessionPath = requiredText(process.env.IPRS_SESSION) || '/api/v1/auth/session';
  const verifyIdPath = requiredText(process.env.IPRS_VERIFY_ID) || '/api/v1/iprs/verify/id';
  if (!baseUrl || !username || !password) throw iprsError('IPRS_NOT_CONFIGURED', 503);
  let url;
  try { url = new URL(baseUrl); } catch { throw iprsError('IPRS_NOT_CONFIGURED', 503); }
  if (url.protocol !== 'https:' || !sessionPath.startsWith('/') || !verifyIdPath.startsWith('/')) {
    throw iprsError('IPRS_NOT_CONFIGURED', 503);
  }
  return { baseUrl: url.toString().replace(/\/$/, ''), username, password, sessionPath, verifyIdPath };
}

function pick(object, keys) {
  if (!object || typeof object !== 'object') return undefined;
  const normalized = new Map(Object.entries(object).map(([key, value]) => [key.replace(/[^a-z0-9]/gi, '').toLowerCase(), value]));
  for (const key of keys) {
    const value = normalized.get(key.replace(/[^a-z0-9]/gi, '').toLowerCase());
    if (value !== undefined && value !== null && String(value).trim()) return value;
  }
  return undefined;
}

function responseObjects(value) {
  const queue = [value];
  const results = [];
  const visited = new Set();
  while (queue.length) {
    const item = queue.shift();
    if (!item || typeof item !== 'object' || visited.has(item)) continue;
    visited.add(item);
    if (Array.isArray(item)) { queue.push(...item); continue; }
    results.push(item);
    for (const key of ['data', 'result', 'results', 'identity', 'person', 'record', 'records', 'session']) {
      const nested = pick(item, [key]);
      if (nested && typeof nested === 'object') queue.push(nested);
    }
  }
  return results;
}

function extractToken(data) {
  for (const object of responseObjects(data)) {
    const token = pick(object, ['token', 'access_token', 'accessToken', 'session_token', 'sessionToken']);
    if (token) return String(token).trim().replace(/^Bearer\s+/i, '');
  }
  return '';
}

function responseIndicatesRejected(data) {
  for (const object of responseObjects(data)) {
    const value = pick(object, ['verified', 'match', 'matched', 'valid', 'success']);
    if (typeof value === 'boolean') return value === false;
    if (typeof value === 'string' && ['false', 'failed', 'invalid', 'not_found', 'not found', 'no_match', 'no match'].includes(value.trim().toLowerCase())) return true;
  }
  return false;
}

function identityComparisons(data, expected) {
  const comparisons = [];
  for (const object of responseObjects(data)) {
    const nationalId = pick(object, ['id_number', 'idNumber', 'national_id', 'nationalId', 'id_no', 'idNo']);
    const firstName = pick(object, ['first_name', 'firstName', 'firstname', 'given_name', 'givenName']);
    const surname = pick(object, ['surname', 'last_name', 'lastName', 'family_name', 'familyName']);
    if (nationalId || firstName || surname) comparisons.push({
      nationalId: nationalId ? String(nationalId).replace(/\s+/g, '') === expected.nationalId : null,
      firstName: firstName ? normalizeName(firstName) === normalizeName(expected.firstName) : null,
      surname: surname ? normalizeName(surname) === normalizeName(expected.surname) : null,
    });
  }
  return comparisons;
}
function identityMatches(data, expected) {
  return identityComparisons(data, expected).some((r) => r.nationalId !== false && r.firstName === true && r.surname === true);
}

async function createSession(config) {
  let response;
  try {
    response = await axios.post(`${config.baseUrl}${config.sessionPath}`, { username: config.username, password: config.password }, {
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'TruckSphere IPRS Integration/1.0', 'Cache-Control': 'no-store, no-cache', Pragma: 'no-cache' }, timeout: REQUEST_TIMEOUT_MS, validateStatus: () => true,
    });
  } catch { throw iprsError('IPRS_UNAVAILABLE', 503); }
  if (response.status < 200 || response.status >= 300) throw iprsError('IPRS_SESSION_FAILED', 503);
  const token = extractToken(response.data);
  if (!token) throw iprsError('IPRS_SESSION_FAILED', 503);
  return token;
}

async function verifyDriverIdentity({ nationalId, firstName, surname }) {
  if (!isIprsEnabled()) return { verified: false, skipped: true };
  const normalizedNationalId = requiredText(nationalId).replace(/\s+/g, '');
  const cleanFirstName = requiredText(firstName);
  const cleanSurname = requiredText(surname);
  if (!normalizedNationalId || !cleanFirstName || !cleanSurname) throw iprsError('IPRS_IDENTITY_DETAILS_REQUIRED', 400);
  const config = getConfig();
  const token = await createSession(config);
  let response;
  try {
    response = await axios.post(`${config.baseUrl}${config.verifyIdPath}`, {
      idNumber: normalizedNationalId,
    }, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': 'TruckSphere IPRS Integration/1.0', 'Cache-Control': 'no-store, no-cache', Pragma: 'no-cache' }, timeout: REQUEST_TIMEOUT_MS, validateStatus: () => true,
    });
  } catch { throw iprsError('IPRS_UNAVAILABLE', 503); }
  // Cowrie IPRS returns the matching record in some 400 responses, together
  // with a false wrapper flag. The record is the authoritative result: accept
  // it when both names match, and the ID matches if the provider returns it.
  if ((response.status >= 200 && response.status < 300 || response.status === 400 || response.status === 422) && identityMatches(response.data, { nationalId: normalizedNationalId, firstName: cleanFirstName, surname: cleanSurname })) {
    return { verified: true, skipped: false };
  }
  const comparisons = identityComparisons(response.data, { nationalId: normalizedNationalId, firstName: cleanFirstName, surname: cleanSurname });
  // Log match booleans only. Never log identity values, response bodies or tokens.
  console.warn('[IPRS] verification diagnostic', JSON.stringify({ providerStatus: response.status, comparisons, recognizedIdentity: comparisons.some((r) => Object.values(r).every((v) => v !== null)) }));
  if (response.status === 404 || ((response.status >= 200 && response.status < 300 || response.status === 400 || response.status === 422) && comparisons.some((r) => r.firstName !== null && r.surname !== null))) throw iprsError('IPRS_IDENTITY_MISMATCH');
  if (response.status < 200 || response.status >= 300) throw iprsError('IPRS_VERIFICATION_FAILED', 503);
  throw iprsError('IPRS_RESPONSE_UNRECOGNIZED', 503);
}

async function lookupDriverIdentity({ nationalId }) {
  if (!isIprsEnabled()) return { verified: false, skipped: true };
  const normalizedNationalId = requiredText(nationalId).replace(/\s+/g, '');
  if (!normalizedNationalId) throw iprsError('IPRS_IDENTITY_DETAILS_REQUIRED', 400);
  const config = getConfig();
  const token = await createSession(config);
  let response;
  try {
    response = await axios.post(`${config.baseUrl}${config.verifyIdPath}`, { idNumber: normalizedNationalId }, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': 'TruckSphere IPRS Integration/1.0', 'Cache-Control': 'no-store, no-cache', Pragma: 'no-cache' }, timeout: REQUEST_TIMEOUT_MS, validateStatus: () => true,
    });
  } catch { throw iprsError('IPRS_UNAVAILABLE', 503); }
  if (response.status < 200 || response.status >= 300) throw iprsError('IPRS_VERIFICATION_FAILED', 503);
  for (const object of responseObjects(response.data)) {
    const firstName = pick(object, ['first_name', 'firstName', 'firstname', 'given_name', 'givenName']);
    const surname = pick(object, ['surname', 'last_name', 'lastName', 'family_name', 'familyName']);
    if (firstName && surname) return { verified: true, firstName: String(firstName).trim(), surname: String(surname).trim() };
  }
  throw iprsError('IPRS_RESPONSE_UNRECOGNIZED', 503);
}

module.exports = { isIprsEnabled, verifyDriverIdentity, lookupDriverIdentity, __testables: { extractToken, identityMatches, identityComparisons, normalizeName, responseIndicatesRejected } };
