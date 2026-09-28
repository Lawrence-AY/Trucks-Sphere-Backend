require('dotenv').config();
const { createClient, syncRecord } = require('../src/integrations/odooSync');
const contract = require('../src/integrations/odoo-live-contract.json').fuels;
const { db } = require('../config/firebase');

async function main() {
  const call = createClient();
  const models = await call('ir.model', 'search_read', { domain: [['model', '=', contract.model]], fields: ['id'], limit: 1 });
  if (!models.length) throw new Error('ODOO_FUEL_MODEL_MISSING');
  const fields = contract.fields.filter(field => ['driverId', 'driverCode', 'girDriverCode'].includes(field.source));
  const existing = await call(contract.model, 'fields_get', { allfields: fields.map(field => field.name), attributes: ['type'] });
  for (const field of fields) {
    if (existing[field.name] && existing[field.name].type !== 'char') throw new Error('ODOO_DRIVER_FIELD_TYPE_MISMATCH');
    if (!existing[field.name]) await call('ir.model.fields', 'create', { vals_list: [{ name: field.name, field_description: field.label, model_id: models[0].id, ttype: 'char', state: 'manual' }] });
  }
  const primary = await call('ir.ui.view', 'search_read', { domain: [['model', '=', contract.model], ['type', '=', 'form'], ['mode', '=', 'primary']], fields: ['id'], limit: 1 });
  if (!primary.length) throw new Error('ODOO_FUEL_VIEW_MISSING');
  const name = 'x_trucksphere_fuel.driver.details';
  const views = await call('ir.ui.view', 'search_read', { domain: [['name', '=', name], ['model', '=', contract.model]], fields: ['id'], limit: 1 });
  const vals = { name, model: contract.model, inherit_id: primary[0].id, arch_db: '<xpath expr="//sheet" position="inside"><group string="Driver references"><field name="x_driver_id"/><field name="x_driver_code"/><field name="x_gir_driver_code"/></group></xpath>' };
  if (views.length) await call('ir.ui.view', 'write', { ids: [views[0].id], vals });
  else await call('ir.ui.view', 'create', { vals_list: [vals] });
  const records = await db.collection('fuelRecords').get();
  let updated = 0;
  for (const doc of records.docs) {
    const record = { ...doc.data(), id: doc.id };
    if (!record.driverId) continue;
    const driver = (await db.collection('drivers').doc(record.driverId).get()).data() || {};
    record.driverCode ||= driver.baseDriverCode || driver.driverCode || driver.code || record.driverId;
    const result = await syncRecord(call, 'fuels', record, { ...contract, preserveMissing: true });
    if (result !== 'skipped') updated++;
  }
  console.log(`Odoo driver reference fields verified; ${updated} completed fuel records synchronized.`);
}
main().catch(() => { console.error('Odoo fuel driver update failed.'); process.exitCode = 1; }).finally(() => db.terminate());
