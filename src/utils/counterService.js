/**
 * Counter Service — Auto-incrementing IDs for entities
 * Uses Firestore transactions for atomic increment guarantees.
 *
 * Prefixes:
 *   V   = Vendor            (V001, V002, ...)
 *   D   = Driver            (D001, D002, ...)
 *   T   = Truck/Vehicle     (T001, T002, ...)
 *   J   = Job               (J001, J002, ...)
 *   RN  = Receipt Note      (RN001, RN002, ...)
 *   DN  = Delivery Note     (DN001, DN002, ...)
 *   POMAT = Purchase Order  (POMAT001, POMAT002, ...)
 */
const { db } = require('../../config/firebase');

const COUNTER_COLLECTION = 'counters';
const COUNTER_DOC = 'auto_ids';

const PREFIX_MAP = {
  vendor: 'V',
  driver: 'D',
  truck: 'T',
  vehicle: 'T',
  job: 'J',
  receipt_note: 'RN',
  delivery_note: 'DN',
  purchase_order: 'POMAT',
};

/**
 * Atomically increment and return the next ID for a given entity type.
 * Returns e.g. "V005", "D012", "J001", "POMAT003"
 */
async function getNextId(entityType) {
  const prefix = PREFIX_MAP[entityType];
  if (!prefix) throw new Error(`Unknown entity type: ${entityType}`);

  const counterRef = db.collection(COUNTER_COLLECTION).doc(COUNTER_DOC);
  const fieldName = `${entityType}_counter`;

  let nextNumber;
  await db.runTransaction(async (transaction) => {
    const doc = await transaction.get(counterRef);
    let current = 0;
    if (doc.exists && doc.data()[fieldName] != null) {
      current = doc.data()[fieldName];
    }
    nextNumber = current + 1;
    transaction.set(counterRef, { [fieldName]: nextNumber }, { merge: true });
  });

  return `${prefix}${String(nextNumber).padStart(3, '0')}`;
}

async function resetAllCounters() {
  const counterRef = db.collection(COUNTER_COLLECTION).doc(COUNTER_DOC);
  const resetData = {};
  for (const type of Object.keys(PREFIX_MAP)) {
    resetData[`${type}_counter`] = 0;
  }
  await counterRef.set(resetData);
  console.log('[Counter] All counters reset to 0');
}

async function setCounter(entityType, value) {
  const counterRef = db.collection(COUNTER_COLLECTION).doc(COUNTER_DOC);
  await counterRef.set({ [`${entityType}_counter`]: value }, { merge: true });
}

module.exports = { getNextId, resetAllCounters, setCounter, PREFIX_MAP };