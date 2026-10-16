const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { assessPassword } = require('../src/utils/passwordPolicy');

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  if (args.some(arg => arg !== '--apply')) throw new Error('Usage: node scripts/provision-vendor-accounts.js [--apply]');
  const { db, admin } = require('../config/firebase');
  const service = require('../src/modules/vendors/service');
  try {
    const [vendors, users] = await Promise.all([db.collection('vendors').get(), db.collection('users').get()]);
    const linked = new Set(users.docs.map(doc => doc.data().vendorId).filter(Boolean));
    const existing = vendors.docs.filter(doc => doc.data().userId || linked.has(doc.id));
    const pending = vendors.docs.filter(doc => !doc.data().userId && !linked.has(doc.id) && !['inactive', 'suspended', 'archived'].includes(String(doc.data().status || '').toLowerCase()));
    console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', existing: existing.map(doc => doc.id), pending: pending.map(doc => ({ id: doc.id, company: doc.data().companyName || doc.data().name })) }));
    if (!apply || !pending.length) return;
    const directory = path.resolve('.po-repair-backups', 'vendor-accounts');
    fs.mkdirSync(directory, { recursive: true });
    const filename = path.join(directory, `logins-${Date.now()}.json`);
    const manifest = { createdAt: new Date().toISOString(), accounts: [] };
    fs.writeFileSync(filename, JSON.stringify(manifest, null, 2), { flag: 'wx', mode: 0o600 });
    function save() { fs.writeFileSync(filename, JSON.stringify(manifest, null, 2), { mode: 0o600 }); }
    for (const doc of pending) {
      let password;
      do { password = randomBytes(18).toString('base64url') + '!7aZ'; } while (!assessPassword(password).valid);
      const entry = { vendorId: doc.id, company: doc.data().companyName || doc.data().name, password, status: 'pending' };
      manifest.accounts.push(entry); save();
      try {
        const result = await service.createAccount(doc.id, { password, isActive: true });
        Object.assign(entry, { username: result.username, uid: result.user.uid, role: result.user.role, status: 'created' });
        save();
        console.log(JSON.stringify({ vendorId: doc.id, username: result.username, status: 'created' }));
      } catch (error) {
        entry.status = 'failed'; entry.error = error.code || error.message; delete entry.password; save();
        console.log(JSON.stringify({ vendorId: doc.id, status: 'failed', error: entry.error }));
      }
    }
    console.log(JSON.stringify({ created: manifest.accounts.filter(entry => entry.status === 'created').length, failed: manifest.accounts.filter(entry => entry.status === 'failed').length, credentialsFile: filename }));
    if (manifest.accounts.some(entry => entry.status === 'failed')) process.exitCode = 1;
  } finally { await Promise.all(admin.apps.map(app => app.delete())); }
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { main };
