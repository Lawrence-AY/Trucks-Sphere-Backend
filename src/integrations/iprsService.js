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
  for (const key of keys) if (object[key] !== undefined && object[key] !== null && String(object[key]).trim()) return object[key];
  return undefined;
}

function responseObjects(value) {
  const queue = [value];
  const results = [];
  while (queue.length) {
    const item = queue.shift();
    if (!item || typeof item !== 'object') continue;
    results.push(item);
    for (const key of ['data', 'result', 'identity', 'person', 'record']) if (item[key] && typeof item[key] === 'object') queue.push(item[key]);
  }
  return results;
}

function extractToken(data) {
  for (const object of responseObjects(data)) {
    const token = pick(object, ['token', 'access_token', 'accessToken', 'session_token', 'sessionToken']);
    if (token) return String(token).trim();
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

function identityMatches(data, expected) {
  for (const object of responseObjects(data)) {
    const nationalId = pick(object, ['id_number', 'idNumber', 'national_id', 'nationalId', 'id_no', 'idNo']);
    const firstName = pick(object, ['first_name', 'firstName', 'firstname', 'given_name', 'givenName']);
    const surname = pick(object, ['surname', 'last_name', 'lastName', 'family_name', 'familyName']);
    if (nationalId || firstName || surname) {
      return String(nationalId || '').replace(/\s+/g, '') === expected.nationalId
        && normalizeName(firstName) === normalizeName(expected.firstName)
        && normalizeName(surname) === normalizeName(expected.surname);
    }
  }
  return false;
}

async function createSession(config) {
  let response;
  try {
    response = await axios.post(`${config.baseUrl}${config.sessionPath}`, { username: config.username, password: config.password }, {
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'TruckSphere IPRS Integration/1.0' }, timeout: REQUEST_TIMEOUT_MS, validateStatus: () => true,
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
      id_number: normalizedNationalId, first_name: cleanFirstName, surname: cleanSurname,
    }, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': 'TruckSphere IPRS Integration/1.0' }, timeout: REQUEST_TIMEOUT_MS, validateStatus: () => true,
    });
  } catch { throw iprsError('IPRS_UNAVAILABLE', 503); }
  // Cowrie IPRS returns the matching record in some 400 responses, together
  // with a false wrapper flag. The record is the authoritative result: accept
  // it only when all three requested identity values match exactly.
  if (identityMatches(response.data, { nationalId: normalizedNationalId, firstName: cleanFirstName, surname: cleanSurname })) {
    return { verified: true, skipped: false };
  }
  if (response.status === 404 || response.status === 422 || responseIndicatesRejected(response.data)) throw iprsError('IPRS_IDENTITY_MISMATCH');
  if (response.status < 200 || response.status >= 300) throw iprsError('IPRS_VERIFICATION_FAILED', 503);
  throw iprsError('IPRS_IDENTITY_MISMATCH');
}

module.exports = { isIprsEnabled, verifyDriverIdentity, __testables: { extractToken, identityMatches, normalizeName, responseIndicatesRejected } };
