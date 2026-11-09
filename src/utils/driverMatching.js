const { similarity } = require('./vendorMatching');
const DEFAULT_OPTIONS = { autoMatchThreshold: 0.92, reviewThreshold: 0.70, ambiguityMargin: 0.05, candidateLimit: 5, surnameThreshold: 0.85 };
const text = value => String(value == null ? '' : value).trim();
function normalizeDriverName(value) { return text(value).normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim(); }
function nameParts(value) { const tokens = normalizeDriverName(value).split(' ').filter(Boolean); return { tokens, first: tokens[0] || '', surname: tokens.length > 1 ? tokens[tokens.length - 1] : '' }; }
function nameVariants(driver) { const first = driver.firstName || driver.first_name || ''; const last = driver.lastName || driver.last_name || driver.surname || ''; return [driver.name, driver.fullName, `${first} ${last}`, `${last} ${first}`, ...(Array.isArray(driver.aliases) ? driver.aliases : [])].filter(value => text(value)); }
function scoreName(source, candidate) {
  const a = nameParts(source), b = nameParts(candidate);
  if (!a.first || !a.surname || !b.first || !b.surname || a.first[0] !== b.first[0] || a.surname[0] !== b.surname[0]) return { score: 0, surnameScore: 0 };
  const fullScore = similarity(a.tokens.join(' '), b.tokens.join(' '));
  const surnameScore = similarity(a.surname, b.surname);
  const firstScore = similarity(a.first, b.first);
  return { score: fullScore * 0.60 + surnameScore * 0.25 + firstScore * 0.15, surnameScore };
}
function matchDriver(name, drivers = [], options = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...options }, originalName = text(name), normalized = normalizeDriverName(name);
  const out = (status, method, match, score, candidates = []) => ({ status, method, match, score, originalName, candidates });
  if (!normalized) return out('no_match', 'empty', null, 0);
  const aliases = Array.isArray(opts.aliases) ? opts.aliases : [];
  const aliasIds = [...new Set(aliases.filter(a => normalizeDriverName(a.alias || a.aliasNormalized) === normalized).map(a => a.driverId).filter(Boolean))];
  if (aliasIds.length === 1) { const match = drivers.find(d => d.id === aliasIds[0]); if (match) return out('exact', 'alias', match, 1); }
  const exact = drivers.filter(d => nameVariants(d).some(v => normalizeDriverName(v) === normalized));
  if (exact.length === 1) return out('exact', 'normalized', exact[0], 1);
  if (exact.length > 1) {
    // Duplicate bridge-created stubs may coexist with a registered profile.
    // Prefer the completed profile; never let duplicate names become fuzzy ambiguity.
    const registered = exact.filter(d => !d.registrationIncomplete && (d.nationalId || d.phone || d.userId));
    if (registered.length === 1) return out('exact', 'normalized-registered', registered[0], 1);
  }
  const scored = drivers.map(driver => { const best = nameVariants(driver).map(v => ({ value: v, ...scoreName(originalName, v) })).sort((a, b) => b.score - a.score)[0] || { score: 0, surnameScore: 0 }; return { driver, score: Math.min(1, best.score + (opts.vendorId && driver.vendorId === opts.vendorId ? 0.02 : 0)), surnameScore: best.surnameScore }; }).filter(c => c.score > 0).sort((a, b) => b.score - a.score);
  const candidates = scored.slice(0, opts.candidateLimit).map(c => ({ driverId: c.driver.id, name: c.driver.name || c.driver.fullName, score: c.score, surnameScore: c.surnameScore }));
  const top = scored[0];
  if (!top || top.score < opts.reviewThreshold) return out('no_match', 'fuzzy', null, top?.score || 0, candidates);
  if (scored[1] && top.score - scored[1].score < opts.ambiguityMargin) return out('ambiguous', 'fuzzy', null, top.score, candidates);
  if (top.score >= opts.autoMatchThreshold && top.surnameScore >= opts.surnameThreshold) return out('auto', 'fuzzy', top.driver, top.score, candidates);
  return out('review', 'fuzzy', null, top.score, candidates);
}
module.exports = { DEFAULT_OPTIONS, normalizeDriverName, matchDriver, nameParts, scoreName };
