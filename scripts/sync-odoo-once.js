require('dotenv').config();
const { db } = require('../config/firebase');
const { startOdooSync } = require('../src/integrations/odooSync');
const worker = startOdooSync({ db, watch:false, env:{...process.env, ODOO_ENABLED:'true', ODOO_MAPPING_PROFILE:'spadestest'} });
(async () => {
  const counts = await worker.ready;
  worker.stop();
  await db.terminate();
  process.exitCode = !counts || counts.failed ? 1 : 0;
})().catch(() => { worker.stop(); console.error('Odoo outbound pass failed'); process.exitCode = 1; });
