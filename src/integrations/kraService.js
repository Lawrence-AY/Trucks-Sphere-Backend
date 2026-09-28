const BASE_URL = String(process.env.KRA_API_BASE_URL || '').trim().replace(/\/$/, '');
const API_KEY = String(process.env.KRA_API_KEY || '').trim();
const API_SECRET = String(process.env.KRA_API_SECRET || '').trim();
const VALIDATE_PATH = String(process.env.KRA_PIN_VALIDATE_PATH || '/api/kra/pin').trim();
const SESSION_PATH = String(process.env.KRA_SESSION_PATH || '/api/kra/session').trim();
let sessionToken = '';
let sessionExpiresAt = 0;
let sessionTokenType = 'Bearer';

function enabled() { return String(process.env.KRA_ENABLE || '').toLowerCase() === 'true'; }

function cleanName(value) {
  return String(value || '').replace(/\s+NA(?:\s+NA)+\s*$/i, '').trim();
}

async function getSessionToken() {
  if (sessionToken && Date.now() < sessionExpiresAt - 30_000) return sessionToken;
  const response = await fetch(`${BASE_URL}${SESSION_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ key: API_KEY, secret: API_SECRET }),
  });
  const raw = await response.text();
  const body = raw ? JSON.parse(raw) : {};
  const token = body?.token || body?.data?.token || body?.result?.token;
  if (!response.ok || !token) throw Object.assign(new Error(body?.Message || body?.message || `KRA session creation failed (HTTP ${response.status})`), { statusCode: 503, code: 'KRA_SESSION_FAILED' });
  sessionToken = String(token);
  sessionTokenType = String(body.tokenType || body.data?.tokenType || body.result?.tokenType || 'Bearer');
  sessionExpiresAt = Date.now() + Number(body.expiresIn || body.data?.expiresIn || body.result?.expiresIn || 3600) * 1000;
  console.info('[KRA] Session created', { url: `${BASE_URL}${SESSION_PATH}`, tokenType: sessionTokenType, tokenPrefix: `${sessionToken.slice(0, 12)}…`, tokenLength: sessionToken.length, expiresInSeconds: Math.round((sessionExpiresAt - Date.now()) / 1000) });
  return sessionToken;
}

async function validatePin(kraPin) {
  const pin = String(kraPin || '').trim().toUpperCase();
  if (!pin) throw Object.assign(new Error('KRA PIN is required'), { statusCode: 400, code: 'KRA_PIN_REQUIRED' });
  if (!enabled()) return { skipped: true, KRAPIN: pin };
  if (!BASE_URL || !API_KEY || !API_SECRET) throw Object.assign(new Error('KRA validation is enabled but its credentials are not configured'), { statusCode: 503, code: 'KRA_NOT_CONFIGURED' });

  const token = await getSessionToken();
  const response = await fetch(`${BASE_URL}${VALIDATE_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `${sessionTokenType} ${token}` },
    body: JSON.stringify({ KRAPIN: pin }),
  });
  const raw = await response.text();
  let body = {};
  try {
    body = raw ? JSON.parse(raw) : {};
    if (typeof body === 'string') body = JSON.parse(body);
  } catch { body = { raw }; }
  if (typeof body?.data === 'string') { try { body.data = JSON.parse(body.data); } catch {} }
  if (typeof body?.result === 'string') { try { body.result = JSON.parse(body.result); } catch {} }
  console.info('[KRA] PIN request response', { url: `${BASE_URL}${VALIDATE_PATH}`, httpStatus: response.status, tokenType: sessionTokenType, tokenPrefix: `${token.slice(0, 12)}…`, tokenLength: token.length, responseBytes: raw.length, contentType: response.headers.get('content-type') || '', responsePreview: raw.slice(0, 500) });
  const result = body?.data || body?.result || body?.response || body;
  const pinData = body?.PINDATA || body?.pinData || result?.PINDATA || result?.pinData || {};
  const responseCode = String(body?.ResponseCode ?? body?.responseCode ?? result?.ResponseCode ?? result?.responseCode ?? '').trim();
  const status = String(body?.Status ?? body?.status ?? result?.Status ?? result?.status ?? '').toUpperCase();
  const message = String(body?.Message ?? body?.message ?? result?.Message ?? result?.message ?? '').toLowerCase();
  const pinStatus = String(pinData.StatusOfPIN ?? pinData.statusOfPin ?? '').toLowerCase();
  const valid = response.ok && (responseCode === '23000' || message === 'valid pin') && (status === 'OK' || status === 'SUCCESS' || message === 'valid pin') && (pinStatus === 'active' || !pinStatus);
  if (!valid) {
    console.error('[KRA] PIN request rejected', { url: `${BASE_URL}${VALIDATE_PATH}`, httpStatus: response.status, responseCode, status, message: result?.Message || body?.Message || body?.message || '' });
    const upstreamFailure = !response.ok || !responseCode;
    throw Object.assign(new Error(result?.Message || body?.Message || body?.message || `KRA rejected the PIN (HTTP ${response.status}, code ${responseCode || 'unknown'})`), { statusCode: upstreamFailure ? 502 : 422, code: upstreamFailure ? 'KRA_UPSTREAM_ERROR' : 'KRA_PIN_INVALID', kraResponse: body });
  }
  return { valid: true, kraPin: pinData.KRAPIN || pinData.kraPin || pin, companyName: cleanName(pinData.Name || pinData.name), typeOfTaxpayer: pinData.TypeOfTaxpayer || pinData.typeOfTaxpayer, statusOfPin: pinData.StatusOfPIN || pinData.statusOfPin || 'Active' };
}

module.exports = { enabled, validatePin };
