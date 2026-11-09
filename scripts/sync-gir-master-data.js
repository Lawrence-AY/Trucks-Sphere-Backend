require('dotenv').config();
const { admin } = require('../config/firebase');
const redis = require('../config/redis');
const snapshotStore = require('../src/utils/snapshotStore');
const { backfill } = require('../src/integrations/girMasterDataSync');

(async () => {
  const apply = process.argv.includes('--apply');
  await redis.init();
  await snapshotStore.init();
  const result = await backfill({ apply });
  console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', result }, null, 2));
  await Promise.all(admin.apps.map(app => app.delete()));
  process.exitCode = Object.values(result || {}).some(group => group && group.failed > 0) ? 1 : 0;
})().catch(async error => {
  console.error(`GIR/FMS master-data sync failed: ${error?.message || String(error)}`);
  await Promise.all(admin.apps.map(app => app.delete().catch(() => {})));
  process.exitCode = 1;
});
