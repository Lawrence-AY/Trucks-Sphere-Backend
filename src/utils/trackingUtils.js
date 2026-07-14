/**
 * Tracking ID Utility
 *
 * Generates secure, short-lived tracking IDs for public delivery tracking.
 * Format: SA- prefix followed by a 7-character Base-36 alphanumeric string.
 * Pool size: 36^7 ≈ 78 billion possibilities.
 */

const crypto = require('crypto');

/**
 * Generate a tracking ID in the format SA-XXXXXXX
 * Uses crypto.randomBytes for cryptographically secure randomness,
 * then encodes via Base-36 to produce a short, URL-friendly string.
 *
 * @returns {string} e.g., "SA-A1B3C5D"
 */
function generateTrackingId() {
  // Generate 5 random bytes (40 bits), which gives us up to ~1 trillion values
  // Base-36 encoding of that yields up to 8 chars; we slice to 7
  const bytes = crypto.randomBytes(5);
  // Convert to a big integer, then to base-36 string
  let num = BigInt(0);
  for (let i = 0; i < bytes.length; i++) {
    num = (num << BigInt(8)) | BigInt(bytes[i]);
  }
  const base36 = num.toString(36).toUpperCase();
  // Ensure exactly 7 characters; pad with random characters if needed
  let slug = base36.slice(0, 7).padStart(7, '0');
  // If the slug is shorter than 7 (edge case with very small numbers), fill from extra random bytes
  while (slug.length < 7) {
    const extra = crypto.randomBytes(1);
    slug += (extra[0] % 36).toString(36).toUpperCase();
  }
  return `SA-${slug.slice(0, 7)}`;
}

/**
 * Validates that a tracking ID matches the expected format.
 *
 * @param {string} trackingId
 * @returns {boolean}
 */
function isValidTrackingId(trackingId) {
  if (typeof trackingId !== 'string') return false;
  return /^SA-[0-9A-Z]{7}$/.test(trackingId);
}

/**
 * Encodes a Firestore document ID into a deterministic tracking ID.
 * This is an alternative to random generation — useful for idempotent creation
 * where the same job always yields the same tracking ID.
 *
 * Uses SHA-256 hash truncated and encoded to Base-36.
 *
 * @param {string} docId - The Firestore document ID of the delivery order
 * @returns {string} e.g., "SA-A1B3C5D"
 */
function generateDeterministicTrackingId(docId) {
  const hash = crypto.createHash('sha256').update(docId).digest();
  // Take first 5 bytes (40 bits) → Base-36
  let num = BigInt(0);
  for (let i = 0; i < 5; i++) {
    num = (num << BigInt(8)) | BigInt(hash[i]);
  }
  const base36 = num.toString(36).toUpperCase();
  return `SA-${base36.slice(0, 7).padStart(7, '0')}`;
}

module.exports = {
  generateTrackingId,
  isValidTrackingId,
  generateDeterministicTrackingId,
};