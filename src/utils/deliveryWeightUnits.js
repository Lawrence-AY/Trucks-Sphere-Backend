// Weighbridge fields are persisted in kg. Commercial quantities retain their PO unit.
// The existing accounting/services API uses tonnes; normalize explicitly at boundaries.
const WEIGHT_FIELDS = [
  'weighInWeight', 'weighOutWeight', 'netWeight', 'siteWeighInWeight',
  'siteWeighOutWeight', 'siteArrivalWeight', 'siteNetWeight', 'siteWeightDifference',
  'siteArrivalWeightVariance', 'siteArrivalWeightVarianceTolerance',
];

function convert(record, target) {
  if (!record) return record;
  const source = String(record.weightUnit || 'tonnes').toLowerCase();
  if (!['kg', 'tonnes'].includes(source)) {
    throw Object.assign(new Error('weightUnit must be kg or tonnes.'), { statusCode: 400 });
  }
  const result = { ...record, weightUnit: target };
  const factor = source === target ? 1 : target === 'kg' ? 1000 : 0.001;
  for (const field of WEIGHT_FIELDS) {
    if (record[field] == null || record[field] === '') continue;
    const value = Number(record[field]);
    if (!Number.isFinite(value)) {
      throw Object.assign(new Error(`${field} must be a finite weight.`), { statusCode: 400 });
    }
    result[field] = Math.round(value * factor * 1e9) / 1e9;
  }
  return result;
}

const toTonnes = record => convert(record, 'tonnes');
const toKilograms = record => convert(record, 'kg');

// Include untouched weight fields when a legacy record is first updated, so a
// partial weigh-out cannot leave a tonne weigh-in beside a kilogram weigh-out.
function storagePatch(existing, updates) {
  const merged = toKilograms({ ...toTonnes(existing), ...toTonnes(updates) });
  const patch = { ...updates, weightUnit: 'kg' };
  for (const field of WEIGHT_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(merged, field)) patch[field] = merged[field];
  }
  return patch;
}

module.exports = { WEIGHT_FIELDS, toTonnes, toKilograms, storagePatch };
