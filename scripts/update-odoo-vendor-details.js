require('dotenv').config();
const {createClient}=require('../src/integrations/odooSync');
(async()=>{const call=createClient();const model='x_trucksphere_vendors';const rows=await call(model,'search_read',{domain:[['x_id','!=',false]],fields:['x_company_name','x_contact_person']});for(const row of rows)await call(model,'write',{ids:[row.id],vals:{x_vendor_name:row.x_company_name,x_vendor_contact_person:row.x_contact_person}});console.log(`Vendor details updated on ${rows.length} vendor records.`);})().catch(()=>{console.error('Vendor details update failed');process.exitCode=1;});
