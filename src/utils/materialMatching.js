// Match material names conservatively, retaining grades and numeric sizes.
const { jaroWinkler } = require('./vendorMatching');
const normalizeMaterial = value => String(value ?? '').normalize('NFKC').toLowerCase()
  .replace(/[^\p{L}\p{N}.]+/gu, ' ').trim().replace(/\s+/g, ' ');
const collapsed = value => normalizeMaterial(value).replace(/([a-z])\1+/g, '$1');
function materialNamesMatch(a, b) {
  const left = normalizeMaterial(a), right = normalizeMaterial(b);
  if (!left || !right) return false;
  if (left === right || collapsed(left) === collapsed(right)) return true;
  const aa = left.split(' '), bb = right.split(' ');
  if (aa.length !== bb.length) return false;
  return aa.every((token, i) => token === bb[i] ||
    (!/\d/.test(token + bb[i]) && Math.min(token.length, bb[i].length) >= 5
      && jaroWinkler(token, bb[i]) >= 0.94));
}
const names = material => [material.name, material.materialName, ...(material.aliases || [])];
function matchMaterial(name, code, materials = []) {
  const byCode = code && materials.filter(m => [m.id, m.code, m.materialCode, m.materialNumber, ...(m.codes || []), ...(m.mergedMaterialIds || [])]
    .some(value => normalizeMaterial(value) && normalizeMaterial(value) === normalizeMaterial(code)));
  const exact = materials.filter(m => names(m).some(value =>
    normalizeMaterial(value) && normalizeMaterial(value) === normalizeMaterial(name)));
  const matches = byCode?.length ? byCode : exact.length ? exact : materials.filter(m =>
    names(m).some(value => materialNamesMatch(value, name)));
  if (matches.length > 1) throw Object.assign(new Error('MATERIAL_REVIEW_REQUIRED'), { code: 'MATERIAL_REVIEW_REQUIRED' });
  return matches[0] || null;
}
module.exports = { normalizeMaterial, materialNamesMatch, matchMaterial };
