const QUARRY_LOCATIONS = Object.freeze([
  'Hindi',
  'Ngomeni',
  'Jaribuni',
  'Mjanaheri Malindi',
  'Kilifi',
  'Malindi',
  'Local Borrow pit',
  'Witu',
  'Baragoni',
]);

function normalizeQuarryLocation(value) {
  const location = String(value || '').trim();
  return QUARRY_LOCATIONS.includes(location) ? location : '';
}

module.exports = { QUARRY_LOCATIONS, normalizeQuarryLocation };
