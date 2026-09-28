/**
 * Crypto Utilities — AES-256-GCM Encryption for Tokens & Sensitive Data
 *
 * Encrypts auth tokens, refresh tokens, and sensitive payloads in transit
 * using AES-256-GCM with a server-side secret key. Each encryption produces
 * a unique IV (initialization vector) prepended to the ciphertext.
 *
 * Also provides HMAC-SHA256 signing for data integrity verification.
 */

const crypto = require('crypto');

// Deployment-provided key material. There are intentionally no fallback
// values: a predictable default can compromise every misconfigured instance.
const KEY_LENGTH = 32; // AES-256
const IV_LENGTH = 16;  // AES-GCM recommended
const AUTH_TAG_LENGTH = 16; // 128-bit auth tag
const PBKDF2_ITERATIONS = 100000;

// ─── Derive AES-256 key from secret using PBKDF2 ───
let derivedKey = null;

function getRequiredEnvironmentValue(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) {
    const error = new Error(`${name} must be configured before cryptographic operations can run.`);
    error.code = 'SECURITY_CONFIGURATION_ERROR';
    throw error;
  }
  return value;
}

function assertCryptoConfiguration() {
  getRequiredEnvironmentValue('ENCRYPTION_SECRET');
  getRequiredEnvironmentValue('ENCRYPTION_SALT');
}

function getDerivedKey() {
  if (derivedKey) return derivedKey;
  const secret = getRequiredEnvironmentValue('ENCRYPTION_SECRET');
  const salt = getRequiredEnvironmentValue('ENCRYPTION_SALT');
  derivedKey = crypto.pbkdf2Sync(secret, salt, PBKDF2_ITERATIONS, KEY_LENGTH, 'sha256');
  return derivedKey;
}

/**
 * Encrypt plaintext using AES-256-GCM.
 * Returns: iv + authTag + ciphertext (all hex-encoded, concatenated)
 *
 * @param {string} plaintext - Data to encrypt
 * @returns {string} Encrypted payload (hex string)
 */
function encrypt(plaintext) {
  if (!plaintext) return '';
  const key = getDerivedKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv, { authTagLength: AUTH_TAG_LENGTH });

  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag();

  // Format: iv (hex) + authTag (hex) + ciphertext (hex)
  return iv.toString('hex') + authTag.toString('hex') + encrypted;
}

/**
 * Decrypt ciphertext produced by encrypt().
 *
 * @param {string} encryptedData - Hex string from encrypt()
 * @returns {string} Original plaintext
 */
function decrypt(encryptedData) {
  if (!encryptedData) return '';
  const key = getDerivedKey();

  // Extract IV, auth tag, and ciphertext from the concatenated hex string
  const ivHex = encryptedData.slice(0, IV_LENGTH * 2);
  const authTagHex = encryptedData.slice(IV_LENGTH * 2, (IV_LENGTH + AUTH_TAG_LENGTH) * 2);
  const ciphertextHex = encryptedData.slice((IV_LENGTH + AUTH_TAG_LENGTH) * 2);

  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv, { authTagLength: AUTH_TAG_LENGTH });
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(ciphertextHex, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

/**
 * Encrypt an object as a JSON string. Used for token payloads.
 *
 * @param {object} obj - Object to encrypt
 * @returns {string} Encrypted payload
 */
function encryptObject(obj) {
  return encrypt(JSON.stringify(obj));
}

/**
 * Decrypt an encrypted JSON string back to an object.
 *
 * @param {string} encryptedData - Encrypted payload
 * @returns {object|null} Decrypted object
 */
function decryptObject(encryptedData) {
  const decrypted = decrypt(encryptedData);
  if (!decrypted) return null;
  try {
    return JSON.parse(decrypted);
  } catch {
    return null;
  }
}

/**
 * Generate a cryptographically secure random token.
 * Suitable for refresh tokens, CSRF tokens, etc.
 *
 * @param {number} [bytes=32] - Number of random bytes
 * @returns {string} Hex-encoded random token
 */
function generateSecureToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

/**
 * HMAC-SHA256 signature for data integrity verification.
 *
 * @param {string} data - Data to sign
 * @param {string} [secret] - Optional secret (uses ENCRYPTION_SECRET by default)
 * @returns {string} Hex-encoded HMAC
 */
function sign(data, secret) {
  const key = secret || getRequiredEnvironmentValue('ENCRYPTION_SECRET');
  return crypto.createHmac('sha256', key).update(data, 'utf8').digest('hex');
}

/**
 * Verify HMAC-SHA256 signature.
 *
 * @param {string} data - Original data
 * @param {string} signature - Expected signature
 * @param {string} [secret] - Optional secret
 * @returns {boolean} True if valid
 */
function verifySignature(data, signature, secret) {
  const expected = Buffer.from(sign(data, secret), 'hex');
  const received = Buffer.from(String(signature || ''), 'hex');
  return expected.length === received.length && crypto.timingSafeEqual(expected, received);
}

/**
 * Generate a time-limited token (expires after ttlMs).
 * Format: base64(JSON({ data, exp })) + '.' + hmac
 *
 * @param {object} data - Payload data
 * @param {number} ttlMs - Time-to-live in milliseconds
 * @returns {string} Signed time-limited token
 */
function generateTimedToken(data, ttlMs = 300000) {
  const payload = {
    data,
    exp: Date.now() + ttlMs,
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = sign(encoded);
  return `${encoded}.${signature}`;
}

/**
 * Verify and decode a time-limited token.
 *
 * @param {string} token - Token from generateTimedToken()
 * @returns {object|null} Decoded payload data, or null if invalid/expired
 */
function verifyTimedToken(token) {
  try {
    const [encoded, signature] = token.split('.');
    if (!verifySignature(encoded, signature)) return null;

    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (Date.now() > payload.exp) return null; // Expired
    return payload.data;
  } catch {
    return null;
  }
}

module.exports = {
  assertCryptoConfiguration,
  encrypt,
  decrypt,
  encryptObject,
  decryptObject,
  generateSecureToken,
  sign,
  verifySignature,
  generateTimedToken,
  verifyTimedToken,
};
