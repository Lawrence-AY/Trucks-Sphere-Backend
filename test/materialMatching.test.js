const test = require('node:test');
const assert = require('node:assert/strict');
const { matchMaterial, materialNamesMatch } = require('../src/utils/materialMatching');
test('material typos reuse canonical materials', () => {
  for (const name of ['MURRAM', 'MUURRRAAM', 'MUURRAM', 'MURRRAM', 'BALAST']) {
    const expected = name === 'BALAST' ? 'BALLAST' : 'MURRAM';
    assert.equal(matchMaterial(name, '', [{ id: 'M1', name: expected }]).id, 'M1');
  }
});
test('material grades and ambiguous names stay distinct', () => {
  assert.equal(materialNamesMatch('BALLAST 20MM', 'BALLAST 40MM'), false);
  assert.equal(materialNamesMatch('SAND', 'STONE'), false);
  assert.throws(() => matchMaterial('MUURRAM', '', [{ id: 'M1', name: 'MURRAM' }, { id: 'M2', name: 'MURRRAM' }]), { code: 'MATERIAL_REVIEW_REQUIRED' });
});
