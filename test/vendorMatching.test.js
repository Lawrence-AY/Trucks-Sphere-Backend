const test = require('node:test');
const assert = require('node:assert');
const { matchVendor, normalizeName } = require('../src/utils/vendorMatching');

const VENDORS = [
  { id: 'V001', name: 'Spades Atlas Company Limited', companyName: 'Spades Atlas Company Limited' },
  { id: 'V002', name: 'Basuba Limited', companyName: 'Basuba Limited' },
  { id: 'V003', name: 'Hindi General Agencies Limited', companyName: 'Hindi General Agencies Limited' },
  { id: 'V004', name: 'Wellselect Enterprises Limited', companyName: 'Wellselect Enterprises Limited' },
  { id: 'V005', name: 'Tononoka Rolling Mills Limited', companyName: 'Tononoka Rolling Mills Limited' },
];

function topVendorId(result) {
  if (result.match) return result.match.id;
  return result.candidates.length ? result.candidates[0].vendor.id : null;
}

test('exact match resolves to the vendor', () => {
  const r = matchVendor('Spades Atlas Company Limited', VENDORS);
  assert.strictEqual(r.status, 'exact');
  assert.strictEqual(r.match.id, 'V001');
});

test('case and whitespace differences resolve', () => {
  const r = matchVendor('  spades atlas company LIMITED  ', VENDORS);
  assert.strictEqual(topVendorId(r), 'V001');
});

test('LTD abbreviation resolves to Limited', () => {
  const r = matchVendor('Spades Atlas Company Ltd', VENDORS);
  assert.strictEqual(topVendorId(r), 'V001');
});

test('missing S typo (SPADE) resolves to SPADES', () => {
  const r = matchVendor('Spade Atlas Company Ltd', VENDORS);
  assert.strictEqual(topVendorId(r), 'V001');
});

test('ATALAS typo resolves to ATLAS', () => {
  const r = matchVendor('Spade Atalas Company', VENDORS);
  assert.strictEqual(topVendorId(r), 'V001');
});

test('all six production Spades Atlas variants rank V001 first', () => {
  const variants = [
    'SPADES ATLAS LIMITED',
    'SPADES ATLAS',
    'SPADES ATLAS COMPANY LTD',
    'SPADE ATLAS COMPANY LTD',
    'SPADES ATLAS COMPANY',
    'SPADE ATALAS COMPANY',
  ];
  for (const v of variants) {
    const r = matchVendor(v, VENDORS);
    assert.strictEqual(topVendorId(r), 'V001', 'variant "' + v + '" should resolve to V001 (status=' + r.status + ', score=' + r.score + ')');
  }
});

test('unknown name does not match', () => {
  const r = matchVendor('Totally Unknown Vendor XYZ', VENDORS);
  assert.strictEqual(r.match, null);
  assert.strictEqual(r.status, 'no_match');
});

test('two near-identical vendors are ambiguous, not auto-matched', () => {
  const vendors = [
    { id: 'V001', name: 'Atlas Cement Limited', companyName: 'Atlas Cement Limited' },
    { id: 'V002', name: 'Atlas Cement Company', companyName: 'Atlas Cement Company' },
  ];
  const r = matchVendor('Atlas Cement', vendors);
  assert.strictEqual(r.status, 'ambiguous');
  assert.strictEqual(r.match, null);
});

test('normalizeName strips punctuation and normalises suffixes', () => {
  assert.strictEqual(normalizeName('ABC Construction Ltd.'), 'abc construction limited');
  assert.strictEqual(normalizeName('ABC & Co'), 'abc company');
});

test('approved alias resolves to the vendor', () => {
  const vendors = [
    { id: 'V100', name: 'Nairobi Cement Suppliers', companyName: 'Nairobi Cement Suppliers' },
    { id: 'V101', name: 'Other Vendor Ltd', companyName: 'Other Vendor Ltd' },
  ];
  const aliases = [{ vendorId: 'V100', alias: 'NBI CEM SUP' }];
  const r = matchVendor('NBI CEM SUP', vendors, { aliases });
  assert.strictEqual(r.status, 'exact');
  assert.strictEqual(r.match.id, 'V100');
});
