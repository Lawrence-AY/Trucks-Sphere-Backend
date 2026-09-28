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
 *   PO    = Purchase Order  (PO0001, PO0002, ...)
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
  purchase_order: 'PO',
  purchase_order_v2: 'PO',
  fuel: 'FUEL',
  material: 'MAT',
};

/**
 * Atomically increment and return the next ID for a given entity type.
 * Returns e.g. "V005", "D012", "J001", "PO0003"
 *
 * Auto-detects existing collection max IDs to prevent overwriting
 * seeded or manually-inserted documents.
 */
async function getNextId(entityType) {
  const prefix = PREFIX_MAP[entityType];
  if (!prefix) throw new Error(`Unknown entity type: ${entityType}`);

  const counterRef = db.collection(COUNTER_COLLECTION).doc(COUNTER_DOC);
  const fieldName = `${entityType}_counter`;

  // Determine the Firestore collection name for this entity type
  const collectionNameMap = {
    vendor: 'vendors',
    driver: 'drivers',
    truck: 'vehicles',
    vehicle: 'vehicles',
    job: 'deliveryOrders',
    receipt_note: 'receiptNotes',
    delivery_note: 'deliveryNotes',
    purchase_order: 'purchaseOrders',
    purchase_order_v2: 'purchaseOrders',
    fuel: 'fuelRecords',
    material: 'materials',
  };
  const collectionName = collectionNameMap[entityType];

  let nextNumber;
  await db.runTransaction(async (transaction) => {
    const doc = await transaction.get(counterRef);
    let current = 0;
    if (doc.exists && doc.data()[fieldName] != null) {
      current = doc.data()[fieldName];
    }

    // Auto-detect max existing ID number from the collection
    // Query with uppercase prefix to capture both V001 and v1 (U+0046 < U+0066)
    const queryPrefix = prefix.toUpperCase();
    let maxExistingNum = 0;
    if (collectionName) {
      try {
        const snapshot = await transaction.get(
          db.collection(collectionName)
            .where('id', '>=', queryPrefix)
            .where('id', '<=', queryPrefix + '\uf8ff')
            .limit(100)
        );
        snapshot.forEach((existingDoc) => {
          const existingId = existingDoc.data().id || existingDoc.id;
          const match = existingId.match(new RegExp(`^${prefix}(\\d+)$`, 'i'));
          if (match) {
            const num = parseInt(match[1], 10);
            if (num > maxExistingNum) maxExistingNum = num;
          }
        });
      } catch (_) {
        // If query fails (e.g., missing composite index), fall back to counter value
      }
    }

    // Use whichever is higher: counter or existing max
    const effectiveCurrent = Math.max(current, maxExistingNum);
    nextNumber = effectiveCurrent + 1;
    transaction.set(counterRef, { [fieldName]: nextNumber }, { merge: true });
  });

  return `${prefix}${String(nextNumber).padStart(entityType.startsWith('purchase_order') ? 4 : 3, '0')}`;
}

/**
 * Peek at the next counter value without incrementing it.
 * Used for previews — does NOT burn a counter.
 */
async function peekNextId(entityType) {
  const prefix = PREFIX_MAP[entityType];
  if (!prefix) throw new Error(`Unknown entity type: ${entityType}`);

  const counterRef = db.collection(COUNTER_COLLECTION).doc(COUNTER_DOC);
  const fieldName = `${entityType}_counter`;

  const doc = await counterRef.get();
  let current = 0;
  if (doc.exists && doc.data()[fieldName] != null) {
    current = doc.data()[fieldName];
  }
  const next = current + 1;
  return `${prefix}${String(next).padStart(entityType.startsWith('purchase_order') ? 4 : 3, '0')}`;
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

module.exports = { getNextId, peekNextId, resetAllCounters, setCounter, PREFIX_MAP };
