const { createHash } = require('node:crypto');
const digest = value => createHash('sha256').update(value).digest('hex');
const canonical = row => JSON.stringify(Object.fromEntries(Object.keys(row).sort().map(key => [key, row[key] ?? null])));
function recordKey(table, row) {
  if (table === 'KAYITLAR') {
    if (!Number.isSafeInteger(Number(row.KAYIT_NO)) || Number(row.KAYIT_NO) < 1) throw new Error('INVALID_RECORD_NUMBER');
    return String(row.KAYIT_NO);
  }
  if (table !== 'ICERIDEKI_ARACLAR' || !String(row.PLAKA || '').trim() || !row.TARIH1 || !row.SAAT1) throw new Error('INVALID_WAITING_RECORD');
  return JSON.stringify([String(row.PLAKA).trim().toUpperCase(), row.TARIH1, row.SAAT1]);
}
function createStore(db, sourceId) {
  const source = db.collection('accessBridgeSources').doc(sourceId);
  const snapshots = source.collection('snapshots'), events = source.collection('events');
  return {
    async observe(records, complete = false) {
      const prepared = records.map(({ table, row }) => {
        if (!row || typeof row !== 'object' || Array.isArray(row) || Object.values(row).some(v => v !== null && !['string', 'number', 'boolean'].includes(typeof v))) throw new Error('INVALID_CAPTURE');
        const key = recordKey(table, row), payload = canonical(row);
        if (payload.length > 32000) throw new Error('CAPTURE_TOO_LARGE');
        return { table, key, payload, hash: digest(payload), ref: snapshots.doc(digest(`${table}:${key}`)) };
      });
      if (new Set(prepared.map(record => record.ref.path)).size !== prepared.length) throw new Error('DUPLICATE_CAPTURE');
      // Read the whole upload before writing, avoiding a network round trip
      // and transaction commit for every historical Access row.
      const changed = await db.runTransaction(async transaction => {
        const [sourceDoc, ...previousRows] = await Promise.all([
          transaction.get(source), ...prepared.map(record => transaction.get(record.ref)),
        ]);
        let count = 0;
        for (const [index, record] of prepared.entries()) {
          const previous = previousRows[index];
          if (previous.data()?.hash === record.hash) continue;
          const now = new Date().toISOString();
          transaction.set(record.ref, { hash: record.hash, payload: record.payload, table: record.table, updatedAt: now });
          transaction.set(events.doc(), {
            source_id: sourceId, table_name: record.table, record_key: record.key,
            event_type: previous.exists ? 'UPDATE' : sourceDoc.data()?.initialized ? 'INSERT' : 'BASELINE',
            observed_utc: now, payload: record.payload, status: 'pending', nextAttemptAt: now,
          });
          count++;
        }
        if (complete) transaction.set(source, { initialized: true, lastSuccess: new Date().toISOString() }, { merge: true });
        return count;
      });
      return { changed };
    },
    async claim(owner) {
      return db.runTransaction(async transaction => {
        const doc = await transaction.get(source), lease = doc.data()?.lease;
        if (lease && lease.owner !== owner && lease.expires > Date.now()) return false;
        transaction.set(source, { lease: { owner, expires: Date.now() + 120000 } }, { merge: true });
        return true;
      });
    },
    async release(owner) {
      await db.runTransaction(async transaction => {
        const doc = await transaction.get(source);
        if (doc.data()?.lease?.owner === owner) transaction.set(source, { lease: { owner, expires: 0 } }, { merge: true });
      });
    },
    async pending() {
      const result = await events.where('nextAttemptAt', '<=', new Date().toISOString()).orderBy('nextAttemptAt').limit(100).get();
      return result.docs.map(doc => ({ ...doc.data(), id: doc.id }));
    },
    async save(id, result) {
      await events.doc(id).update({ ...result, nextAttemptAt: result.status === 'blocked' ? new Date(Date.now() + 30000).toISOString() : '9999-12-31T00:00:00.000Z', processedAt: new Date().toISOString() });
    },
    async logs() {
      const [health, history] = await Promise.all([source.get(), events.orderBy('observed_utc', 'desc').limit(100).get()]);
      return { sourceId, lastSuccess: health.data()?.lastSuccess || null, events: history.docs.map(doc => ({ id: doc.id, ...doc.data() })) };
    },
  };
}
module.exports = { createStore, recordKey };
