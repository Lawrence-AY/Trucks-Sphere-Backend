const assert = require('node:assert/strict');
const { matchDriver, normalizeDriverName } = require('../src/utils/driverMatching');

const drivers = [
  { id: 'D001', name: 'Ahmed  Salim', fullName: 'Ahmed Salim', vendorId: 'V001' },
  { id: 'D002', name: 'Abraham Mwale', vendorId: 'V002' },
];

assert.equal(normalizeDriverName('  Ahmed-Salim '), 'ahmed salim');
assert.equal(matchDriver('ahmed salim', drivers).match.id, 'D001');
assert.equal(matchDriver('Abraham Mwaleng', drivers).status, 'auto');
assert.equal(matchDriver('unknown driver', drivers).status, 'no_match');
assert.equal(matchDriver('A. Salim', drivers).status, 'no_match');
assert.equal(matchDriver('A. Salim', drivers, { aliases: [{ alias: 'A. Salim', driverId: 'D001' }] }).match.id, 'D001');
