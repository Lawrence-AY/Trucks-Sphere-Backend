/* Import the supplied default-vendor workbook into the canonical vendors collection. */
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
  if (!workbookPath) throw new Error('Usage: node scripts/sync-vendor-registry.js <VENDORE.xlsx> [--apply]');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(path.resolve(workbookPath));
  const names = namesFromWorkbook(workbook);
  const { db, admin } = require('../config/firebase');
  try {
    const snapshot = await db.collection('vendors').get();
    const vendors = snapshot.docs.map(doc => ({ ...doc.data(), id: doc.id }));
    const usedIds = new Set(vendors.map(vendor => vendor.id));
    const changes = [];
    for (const companyName of names) {
      const result = matchVendor(companyName, vendors);
      if (result.match) { changes.push({ action: 'retain', vendorId: result.match.id, companyName }); continue; }
      let number = vendors.length + 1;
      let vendorId = `V${String(number).padStart(3, '0')}`;
      while (usedIds.has(vendorId)) vendorId = `V${String(++number).padStart(3, '0')}`;
      const record = { id: vendorId, name: companyName, companyName, status: 'active', defaultVendor: true, registrySource: 'VENDORE.xlsx' };
      changes.push({ action: 'create', vendorId, companyName, record });
      vendors.push(record);
      usedIds.add(vendorId);
    }
    if (process.argv.includes('--apply')) {
      for (const change of changes.filter(item => item.action === 'create')) await db.collection('vendors').doc(change.vendorId).create(change.record);
    }
    console.log(JSON.stringify({ mode: process.argv.includes('--apply') ? 'apply' : 'dry-run', vendors: names.length,
      retained: changes.filter(item => item.action === 'retain').length, created: changes.filter(item => item.action === 'create').length,
      changes: changes.map(({ action, vendorId, companyName }) => ({ action, vendorId, companyName })) }, null, 2));
  } finally { await Promise.all(admin.apps.map(app => app.delete())); }
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
