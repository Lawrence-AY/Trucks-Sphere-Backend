require('dotenv').config();
const { createClient } = require('../src/integrations/odooSync');
const mappings = require('../src/integrations/odoo-live-contract.json');
(async () => {
 const call = createClient();
 for (const [name, contract] of Object.entries(mappings)) {
  const key = contract.fields.find(field => field.source === 'id').name;
  const count = await call(contract.model, 'search_count', {domain:[[key,'!=',false]]});
  console.log(`${name}: ${count} source-linked records`);
  if (contract.fields.some(field => field.source === 'vendorContactPerson')) {
    const named = await call(contract.model, 'search_count', {domain:[[key,'!=',false],['x_vendor_name','!=',false]]});
    const contacts = await call(contract.model, 'search_count', {domain:[[key,'!=',false],['x_vendor_contact_person','!=',false]]});
    console.log(`Vendor details: ${named} names, ${contacts} contacts`);
  }
 }
 const orders = await call('purchase.order', 'search_read', {domain:[['x_trucksphere_source_id','!=',false]], fields:['state']});
 console.log(`Native purchase orders: ${orders.length}; drafts: ${orders.filter(order=>order.state==='draft').length}`);
})().catch(() => {console.error('Odoo verification failed');process.exitCode=1;});
