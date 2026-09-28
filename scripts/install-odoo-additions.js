require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const { createClient } = require('../src/integrations/odooSync');
const call = createClient();
(async () => {
  for (const name of ['trucksphere_stocks', 'trucksphere_sync_bridge']) {
    const data = fs.readFileSync(path.join(__dirname, '../../Odoo', `${name}.zip`)).toString('base64');
    const ids = await call('base.import.module', 'create', { vals_list: [{ module_file: data, force: false, with_demo: false }] });
    await call('base.import.module', 'import_module', { ids });
    const result = await call('ir.module.module', 'search_read', { domain: [['name', '=', name]], fields: ['name','state'], limit: 1 });
    if (result[0]?.state !== 'installed') throw new Error('ODOO_MODULE_NOT_INSTALLED');
    console.log(`${name}: installed using additive update mode`);
  }
})().catch(error => { console.error(error.message.startsWith('ODOO_') ? error.message : 'Odoo module installation failed'); process.exitCode = 1; });
