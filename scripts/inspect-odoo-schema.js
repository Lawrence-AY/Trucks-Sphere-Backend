require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const { createClient } = require('../src/integrations/odooSync');
const call = createClient();
const models = ['x_trucksphere_vendors','x_trucksphere_driver','x_trucksphere_vehicles','x_trucksphere_fuel','x_trucksphere_materials','x_trucksphere_warehouse','purchase.order','purchase.order.line','product.product','uom.uom'];
(async () => {
  const schema = {};
  for (const model of models) {
    schema[model] = await call(model, 'fields_get', { attributes: ['type','selection','required'] });
    console.log(`${model}: ${Object.keys(schema[model]).length} fields verified`);
  }
  fs.writeFileSync(path.join(__dirname, '../../Odoo-source/live-schema.json'), JSON.stringify(schema, null, 2));
})().catch(error => { console.error(error.message.startsWith('ODOO_') ? error.message : 'Odoo schema inspection failed'); process.exitCode = 1; });
