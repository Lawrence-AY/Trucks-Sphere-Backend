/* Read-only audit of the supplied default-vendor reference workbook. */
const path = require('node:path');
const ExcelJS = require('exceljs');
const { matchVendor, normalizeName } = require('../src/utils/vendorMatching');

function namesFromWorkbook(workbook) {
  const sheet = workbook.getWorksheet('ALL VENDORS') || workbook.worksheets[0];
  const names = [];
  sheet.eachRow((row, number) => {
    if (number === 1) return;
    const name = String(row.values?.[2] || '').trim();
    if (name && !names.some(existing => normalizeName(existing) === normalizeName(name))) names.push(name);
  });
  return names;
}

async function main() {
  const workbookPath = process.argv.find(arg => arg.toLowerCase().endsWith('.xlsx'));
  if (!workbookPath) throw new Error('Usage: node scripts/sync-vendor-registry.js <VENDORE.xlsx>');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(path.resolve(workbookPath));
  const names = namesFromWorkbook(workbook);
  const { db, admin } = require('../config/firebase');
  try {
    const snapshot = await db.collection('vendors').get();
    const vendors = snapshot.docs.map(doc => ({ ...doc.data(), id: doc.id }));
    const changes = [];
    for (const companyName of names) {
      const result = matchVendor(companyName, vendors);
      if (result.match) { changes.push({ action: 'retain', vendorId: result.match.id, companyName }); continue; }
      changes.push({ action: 'not_registered', vendorId: null, companyName });
    }
    console.log(JSON.stringify({ mode: 'read-only', vendors: names.length,
      retained: changes.filter(item => item.action === 'retain').length, created: changes.filter(item => item.action === 'create').length,
      notRegistered: changes.filter(item => item.action === 'not_registered').length,
      changes: changes.map(({ action, vendorId, companyName }) => ({ action, vendorId, companyName })) }, null, 2));
  } finally { await Promise.all(admin.apps.map(app => app.delete())); }
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
