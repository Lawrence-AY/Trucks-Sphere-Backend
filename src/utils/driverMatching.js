const { similarity } = require('./vendorMatching');

const DEFAULT_OPTIONS = { autoMatchThreshold: 0.92, reviewThreshold: 0.76, ambiguityMargin: 0.05, candidateLimit: 5 };
const text = value => String(value == null ? '' : value).trim();

function normalizeDriverName(value) {
  return text(value).normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim();
}

function nameVariants(driver) {
  const first = driver.firstName || driver.first_name || '';
  const last = driver.lastName || driver.last_name || driver.surname || '';
  return [driver.name, driver.fullName, `${first} ${last}`, `${last} ${first}`, ...(Array.isArray(driver.aliases) ? driver.aliases : [])]
    .filter(value => text(value));
}

function matchDriver(name, drivers = [], options = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const originalName = text(name);
  const normalized = normalizeDriverName(originalName);
  if (!normalized) return { status: 'no_match', method: 'empty', match: null, score: 0, originalName, candidates: [] };
  const aliases = Array.isArray(opts.aliases) ? opts.aliases : [];
  const aliasHits = aliases.filter(alias => normalizeDriverName(alias.alias || alias.aliasNormalized) === normalized);
  const aliasDriverIds = [...new Set(aliasHits.map(alias => alias.driverId).filter(Boolean))];
  if (aliasDriverIds.length === 1) {
    const match = drivers.find(driver => driver.id === aliasDriverIds[0]);
    if (match) return { status: 'exact', method: 'alias', match, score: 1, originalName, candidates: [] };
  }
  const exact = drivers.filter(driver => nameVariants(driver).some(value =>
    normalizeDriverName(value) === normalized,
  ));
  if (exact.length === 1) return { status: 'exact', method: 'normalized', match: exact[0], score: 1, originalName, candidates: [] };
  const scored = drivers.map(driver => {
    const score = Math.max(0, ...nameVariants(driver).map(value => similarity(value, originalName)));
    const context = opts.vendorId && driver.vendorId === opts.vendorId ? 0.02 : 0;
    return { driver, score: Math.min(1, score + context) };
  }).filter(candidate => candidate.score > 0).sort((a, b) => b.score - a.score);
  const candidates = scored.slice(0, opts.candidateLimit).map(candidate => ({ driverId: candidate.driver.id, name: candidate.driver.name || candidate.driver.fullName, score: candidate.score }));
  if (!scored.length || scored[0].score < opts.reviewThreshold) return { status: 'no_match', method: 'fuzzy', match: null, score: scored[0]?.score || 0, originalName, candidates };
  if (scored[1] && scored[0].score - scored[1].score < opts.ambiguityMargin) return { status: 'ambiguous', method: 'fuzzy', match: null, score: scored[0].score, originalName, candidates };
  if (scored[0].score >= opts.autoMatchThreshold) return { status: 'auto', method: 'fuzzy', match: scored[0].driver, score: scored[0].score, originalName, candidates };
  return { status: 'review', method: 'fuzzy', match: null, score: scored[0].score, originalName, candidates };
}

module.exports = { DEFAULT_OPTIONS, normalizeDriverName, matchDriver };
