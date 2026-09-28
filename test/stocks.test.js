const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const model = require('../src/modules/stocks/model');
const delivery = {
  id: 'dispatch1', jobId: 'PO1/J1', siteId: 'SITE1', isWarehouseDelivery: true,
  materials: [{ materialId: 'line1', materialName: 'Bolts', quantity: 10, unit: 'Pieces' }, { materialId: 'line2', materialName: 'Paint', quantity: 5, unit: 'Litres' }],
  warehouseAcceptedAt: '2026-09-05', materialInspection: { mrfNumber: 'MIF1', materialReceipts: [
    { materialId: 'line1', receivedQuantity: 12, initialVisualInspection: 'Pass' },
    { materialId: 'line2', receivedQuantity: 4, initialVisualInspection: 'Failed', failureReason: 'Damaged' },
  ] },
};
test('site stocks retain separate units, flag excess and shortage, quarantine failed receipts', () => {
  const rows = model.stockRows(delivery).map((r) => model.balance(r));
  assert.equal(rows[0].excessQuantity, 2);
  assert.equal(rows[0].remainingQuantity, 12);
  assert.equal(rows[0].unitCost, null);
  assert.equal(rows[0].remainingValue, null);
  assert.equal(rows[1].unit, 'Litres');
  assert.equal(rows[1].shortageQuantity, 1);
  assert.equal(rows[1].quarantinedQuantity, 4);
  assert.equal(rows[1].remainingQuantity, 0);
});
test('acceptance alone does not release stock; receipt IDs remain stable', () => {
  const before = model.stockRows({ ...delivery, materialInspection: null });
  assert.equal(before[0].usableQuantity, 0);
  assert.equal(before[0].shortageQuantity, 0);
  assert.equal(before[0].id, model.stockRows(delivery)[0].id);
});
test('usage, valuation and receipt corrections preserve balances without overdrafts', () => {
  const row = model.balance(model.stockRows(delivery)[0], { unitCost: 2.5, currency: 'KES' });
  const used = model.issue(row, 3);
  assert.equal(used.remainingQuantity, 9);
  assert.equal(used.remainingValue, 22.5);
  assert.equal(model.balance(model.stockRows(delivery)[0], used).remainingQuantity, 9);
  assert.throws(() => model.issue(used, 10), /exceeds/);
  assert.throws(() => model.issue(used, -1), /positive/);
  assert.throws(() => model.balance({ ...row, usableQuantity: 2 }, used), /already recorded usage/);
});
test('warehouse inspection rejects missing, duplicate, unknown and invalid lines', () => {
  model.validateInspection(delivery, delivery.materialInspection);
  for (const receipts of [[], [delivery.materialInspection.materialReceipts[0], delivery.materialInspection.materialReceipts[0]],
    [{ materialId: 'unknown', receivedQuantity: 0 }, delivery.materialInspection.materialReceipts[1]],
    [{ ...delivery.materialInspection.materialReceipts[0], receivedQuantity: -1 }, delivery.materialInspection.materialReceipts[1]]]) {
    assert.throws(() => model.validateInspection(delivery, { materialReceipts: receipts }));
  }
});

function fixture() {
  const records = new Map();
  let queue = Promise.resolve();
  const ref = (collection, id) => ({ id, key: `${collection}/${id}` });
  const db = {
    collection: (name) => ({ doc: (id) => ref(name, id) }),
    runTransaction: (fn) => {
      const run = queue.then(async () => {
        const writes = [];
        let written = false;
        const result = await fn({
          get: async (r) => { assert.equal(written, false, 'all reads must precede writes'); const value = records.get(r.key); return { id: r.id, exists: Boolean(value), data: () => value ? structuredClone(value) : undefined }; },
          set: (r, data, options) => { written = true; writes.push(() => records.set(r.key, { ...(options?.merge ? records.get(r.key) : {}), ...structuredClone(data) })); },
          update: (r, data) => { written = true; writes.push(() => records.set(r.key, { ...records.get(r.key), ...structuredClone(data) })); },
        });
        writes.forEach((write) => write());
        return result;
      });
      queue = run.catch(() => {});
      return run;
    },
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(require.resolve('../src/modules/stocks/service'), 'utf8'), { module, require: (name) => name === './model' ? model : { db } });
  return { service: module.exports, records, ref };
}
test('delivery update and stock write are atomic; retries preserve used quantities', async () => {
  const { service, records, ref } = fixture();
  records.set('deliveryOrders/dispatch1', delivery);
  await service.persistDelivery(ref('deliveryOrders', 'dispatch1'), {});
  const id = model.stockRows(delivery)[0].id;
  await service.change(id, { type: 'usage', quantity: 3, reason: 'Site installation', requestId: 'request_12345' }, { uid: 'admin' });
  await service.persistDelivery(ref('deliveryOrders', 'dispatch1'), {});
  assert.equal(records.get(`stocks/${id}`).remainingQuantity, 9);
  await assert.rejects(service.persistDelivery(ref('deliveryOrders', 'dispatch1'), { materialInspection: { ...delivery.materialInspection, materialReceipts: [{ ...delivery.materialInspection.materialReceipts[0], receivedQuantity: 2 }, delivery.materialInspection.materialReceipts[1]] } }));
  assert.equal(records.get('deliveryOrders/dispatch1').materialInspection.materialReceipts[0].receivedQuantity, 12);
});
test('duplicate usage requests post once and competing requests cannot overdraw stock', async () => {
  const { service, records, ref } = fixture();
  records.set('deliveryOrders/dispatch1', delivery);
  await service.persistDelivery(ref('deliveryOrders', 'dispatch1'), {});
  const id = model.stockRows(delivery)[0].id;
  const request = { type: 'usage', quantity: 8, reason: 'Work order 12', requestId: 'request_12345' };
  await Promise.all([service.change(id, request, {}), service.change(id, request, {})]);
  assert.equal(records.get(`stocks/${id}`).remainingQuantity, 4);
  const results = await Promise.allSettled([service.change(id, { ...request, quantity: 3, requestId: 'request_second' }, {}), service.change(id, { ...request, quantity: 3, requestId: 'request_third' }, {})]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(records.get(`stocks/${id}`).remainingQuantity, 1);
  assert.equal([...records.keys()].filter((key) => key.startsWith('stockMovements/')).length, 2);
});
test('stocked deliveries cannot be deleted or have warehouse products replaced', async () => {
  const { service, records, ref } = fixture();
  records.set('deliveryOrders/dispatch1', delivery);
  await assert.rejects(service.deleteDelivery(ref('deliveryOrders', 'dispatch1')), /cannot be deleted/);
  await assert.rejects(service.persistDelivery(ref('deliveryOrders', 'dispatch1'), { materials: [] }), /cannot be changed/);
  assert.equal(records.get('deliveryOrders/dispatch1').materials.length, 2);
});
test('management Excel contains current stock and movement sheets', async () => {
  const { buildExcelWorkbook } = require('../src/modules/reports/excelBuilder');
  const ExcelJS = require('exceljs');
  const data = Object.fromEntries(['masterAudit', 'materialInspections', 'flagged', 'drivers', 'fuel', 'trucks', 'materials', 'vendors', 'purchaseOrders', 'stockMovements'].map((key) => [key, []]));
  data.stocks = model.stockRows(delivery).map((row) => model.balance(row));
  const buffer = await buildExcelWorkbook(data);
  const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(buffer);
  assert.equal(workbook.getWorksheet('Stocks - Current Balances').rowCount, 3);
  assert.ok(workbook.getWorksheet('Stock Movements - All Time'));
});

test('quarry excess receipts retain the purchase order reference', () => {
 const [row] = model.stockRows({ id: 'quarry1', status: 'COMPLETED', purchaseOrderId: 'po1', purchaseOrderNumber: 'PO1/V1', materialId: 'sand', quantityOrdered: 10, siteNetWeight: 12 });
 assert.equal(row.excessQuantity, 2);
 assert.equal(row.purchaseOrderId, 'po1');
 assert.equal(row.poNumber, 'PO1/V1');
});

test('partial warehouse damage releases good units and later shipments accumulate without duplication', async () => {
  const { service, records, ref } = fixture();
  const first = { ...delivery, materials: [delivery.materials[0]], materialInspection: { mrfNumber: 'MIF1', materialReceipts: [{ materialId: 'line1', receivedQuantity: 10, damagedQuantity: 1, initialVisualInspection: 'Failed', failureReason: 'One broken unit' }] } };
  const second = { ...first, id: 'dispatch2', materialInspection: { mrfNumber: 'MIF2', materialReceipts: [{ materialId: 'line1', receivedQuantity: 5, damagedQuantity: 0, initialVisualInspection: 'Pass' }] } };
  for (const job of [first, second]) {
    records.set('deliveryOrders/' + job.id, job);
    await service.persistDelivery(ref('deliveryOrders', job.id), { materialInspection: job.materialInspection });
  }
  await service.persistDelivery(ref('deliveryOrders', first.id), {});
  const rows = [...records.entries()].filter(([key]) => key.startsWith('stocks/')).map(([, row]) => row);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].remainingQuantity, 9);
  assert.equal(rows[0].quarantinedQuantity, 1);
  assert.equal(rows.reduce((sum, row) => sum + row.remainingQuantity, 0), 14);
  await service.change(rows[0].id, { type: 'usage', quantity: 2, reason: 'Installed', requestId: 'partial_usage_1' }, {});
  await service.persistDelivery(ref('deliveryOrders', first.id), {});
  assert.equal(records.get('stocks/' + rows[0].id).remainingQuantity, 7);
});
test('warehouse damage validation rejects invalid splits and preserves historical failures', () => {
  const receipt = { materialId: 'line1', receivedQuantity: 10, initialVisualInspection: 'Failed', failureReason: 'Damage' };
  const job = { ...delivery, materials: [delivery.materials[0]] };
  for (const damagedQuantity of [-1, 11, '', 'abc', 0]) assert.throws(() => model.validateInspection(job, { materialReceipts: [{ ...receipt, damagedQuantity }] }));
  assert.throws(() => model.validateInspection(job, { materialReceipts: [{ ...receipt, initialVisualInspection: 'Pass', damagedQuantity: 1 }] }));
  model.validateInspection(job, { materialReceipts: [{ ...receipt, damagedQuantity: 10 }] });
  const legacy = model.stockRows({ ...job, materialInspection: { mrfNumber: 'old', materialReceipts: [receipt] } })[0];
  assert.equal(legacy.usableQuantity, 0);
  assert.equal(legacy.quarantinedQuantity, 10);
});
