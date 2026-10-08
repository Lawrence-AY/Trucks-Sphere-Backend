const { db } = require('../../../config/firebase');
const { stockRows, balance, issue, validateInspection } = require('./model');
const stocks = db.collection('stocks');
const movements = db.collection('stockMovements');

// Read every stock document before writing: Firestore transactions require it.
async function prepare(transaction, delivery) {
  const rows = stockRows(delivery);
  const snapshots = await Promise.all(rows.map((row) => transaction.get(stocks.doc(row.id))));
  const updates = rows.map((row, i) => balance(row, snapshots[i].data() || {}))
    .filter((row, i) => Object.keys(row).some((key) => JSON.stringify(row[key]) !== JSON.stringify(snapshots[i].data()?.[key])));
  return () => updates.forEach((row) => transaction.set(stocks.doc(row.id), { ...row, updatedAt: new Date().toISOString() }, { merge: true }));
}
async function persistDelivery(ref, updates) {
  return db.runTransaction(async (tx) => {
    const doc = await tx.get(ref);
    if (!doc.exists) throw Object.assign(new Error('Delivery not found'), { statusCode: 404 });
    const source = doc.data();
    require('../delivery-orders/storeReceiving').assertGenericUpdate(source, updates);
    if (source.isWarehouseDelivery || source.deliveryOrigin === 'warehouse') {
      for (const key of ['materials', 'materialId', 'quantityOrdered', 'additionalItems', 'isWarehouseDelivery', 'deliveryOrigin']) {
        if (Object.prototype.hasOwnProperty.call(updates, key) && JSON.stringify(updates[key]) !== JSON.stringify(source[key])) {
          throw Object.assign(new Error('Warehouse dispatch products cannot be changed after submission. Record actual quantities through inspection.'), { statusCode: 409 });
        }
      }
    }
    if (updates.materialInspection) validateInspection(doc.data(), updates.materialInspection);
    const write = await prepare(tx, { ...doc.data(), ...updates, id: doc.id });
    write();
    tx.update(ref, updates);
  });
}
async function deleteDelivery(ref) {
  return db.runTransaction(async (tx) => {
    const doc = await tx.get(ref);
    if (!doc.exists) return;
    if (doc.data().receivingStatus) throw Object.assign(new Error('Receiving history must be retained.'), { statusCode: 409 });
    if (stockRows({ ...doc.data(), id: doc.id }).length) throw Object.assign(new Error('Deliveries tracked in stocks cannot be deleted. Their receipt history must be retained.'), { statusCode: 409 });
    tx.delete(ref);
  });
}
async function list() {
  const snapshot = await stocks.get();
  return snapshot.docs.map((d) => ({ ...d.data(), id: d.id })).sort((a, b) => `${a.siteName}${a.materialName}${a.jobId}`.localeCompare(`${b.siteName}${b.materialName}${b.jobId}`));
}
async function change(id, data, actor) {
  if (!/^[a-zA-Z0-9_-]{8,100}$/.test(String(data.requestId || ''))) throw Object.assign(new Error('A unique request ID is required.'), { statusCode: 400 });
  if (!String(data.reason || '').trim()) throw Object.assign(new Error('Enter an audit reason.'), { statusCode: 400 });
  return db.runTransaction(async (tx) => {
    const ref = stocks.doc(id), eventRef = movements.doc(`${id}_${data.requestId}`);
    const [doc, event] = await Promise.all([tx.get(ref), tx.get(eventRef)]);
    if (!doc.exists) throw Object.assign(new Error('Stock not found'), { statusCode: 404 });
    if (event.exists) return doc.data();
    const previous = doc.data();
    let next;
    if (data.type === 'usage') next = issue(previous, data.quantity);
    else if (data.type === 'receipt') {
      if (previous.deliveryOrderId) {
        const delivery = await tx.get(db.collection('deliveryOrders').doc(previous.deliveryOrderId));
        if (delivery.data()?.receivingStatus || !delivery.data()?.materialInspection?.materialReceipts?.length) {
          throw Object.assign(new Error('Receive and approve the delivery through quality inspection before adding inventory.'), { statusCode: 409 });
        }
      }
      const amount = Number(data.quantity);
      if (!Number.isFinite(amount) || amount <= 0) throw Object.assign(new Error('Enter a positive receipt quantity.'), { statusCode: 400 });
      next = balance({ ...previous, receivedQuantity: Number(previous.receivedQuantity || 0) + amount, usableQuantity: Number(previous.usableQuantity || 0) + amount }, previous);
    }
    else if (data.type === 'valuation') {
      const cost = Number(data.unitCost), currency = String(data.currency || '').trim().toUpperCase();
      if (data.unitCost === '' || data.unitCost == null || !Number.isFinite(cost) || cost < 0 || !/^[A-Z]{3}$/.test(currency)) throw Object.assign(new Error('Enter a non-negative unit cost and a three-letter currency.'), { statusCode: 400 });
      next = balance(previous, { ...previous, unitCost: cost, currency });
    } else throw Object.assign(new Error('Unsupported stock action'), { statusCode: 400 });
    const now = new Date().toISOString();
    tx.set(ref, { ...next, updatedAt: now });
    tx.set(eventRef, { stockId: id, jobId: previous.jobId, siteName: previous.siteName, materialName: previous.materialName, unit: previous.unit, type: data.type, quantity: data.type === 'usage' ? Number(data.quantity) : 0,
      previousUnitCost: previous.unitCost, unitCost: next.unitCost, currency: next.currency,
      remainingQuantity: next.remainingQuantity, reason: String(data.reason).trim(), actorUid: actor.uid || '',
      actorName: actor.displayName || actor.email || '', createdAt: now });
    return next;
  });
}
async function history(id) {
  const docs = await movements.where('stockId', '==', id).get();
  return docs.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
async function allMovements() {
  const docs = await movements.get();
  return docs.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
module.exports = { prepare, persistDelivery, deleteDelivery, list, change, history, allMovements };
