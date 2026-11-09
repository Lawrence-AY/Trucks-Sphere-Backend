const { similarity } = require('./vendorMatching');

const DEFAULT_OPTIONS = {
  autoMatchThreshold: 0.92,
  reviewThreshold:    0.70,
  ambiguityMargin:    0.05,
  candidateLimit:     5,
  surnameThreshold:   0.85,   // legacy Jaro-Winkler gate for auto-match
  surnameDiceFloor:   0.65,   // NEW: reject surnames that share only a prefix
  firstScoreFloor:    0.75,   // NEW: reject clearly different first names
  duplicateThreshold: 0.95    // NEW: near-identical full names collapse
};

const text = value => String(value == null ? '' : value).trim();

function normalizeDriverName(value) {
  return text(value).normalize('NFKC').toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim();
}

function nameParts(value) {
  const tokens = normalizeDriverName(value).split(' ').filter(Boolean);
  return {
    tokens,
    first:   tokens[0] || '',
    surname: tokens.length > 1 ? tokens[tokens.length - 1] : ''
  };
}

function nameVariants(driver) {
  const first = driver.firstName || driver.first_name || '';
  const last  = driver.lastName  || driver.last_name  || driver.surname || '';
  return [
    driver.name,
    driver.fullName,
    `${first} ${last}`,
    `${last} ${first}`,
    ...(Array.isArray(driver.aliases) ? driver.aliases : [])
  ].filter(value => text(value));
}

// Character-bigram Dice coefficient.
// Complements the imported `similarity` (Jaro-Winkler-like), which over-rewards
// shared prefixes and lets KATANA/KARANJA, KAMANDE/KARANI, HASSAN/HAMISI
// score above 0.73 despite being different surnames.
function diceCoefficient(a, b) {
  if (!a || !b) return 0;
  if (a === b)  return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const bigrams = s => {
    const out = [];
    for (let i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2));
    return out;
  };
  const A = bigrams(a), B = bigrams(b);
  const counts = new Map();
  for (const g of A) counts.set(g, (counts.get(g) || 0) + 1);
  let overlap = 0;
  for (const g of B) {
    const c = counts.get(g) || 0;
    if (c > 0) { overlap++; counts.set(g, c - 1); }
  }
  return (2 * overlap) / (A.length + B.length);
}

function scoreName(source, candidate, options = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const a = nameParts(source), b = nameParts(candidate);
  const zero = (surnameScore = 0, firstScore = 0) => ({ score: 0, surnameScore, firstScore });

  if (!a.first || !a.surname || !b.first || !b.surname) return zero();
  if (a.first[0] !== b.first[0] || a.surname[0] !== b.surname[0]) return zero();

  const surnameScore = similarity(a.surname, b.surname);
  const firstScore   = similarity(a.first,   b.first);

  // Hard gates — a name is a *different person* until proven otherwise.
  if (diceCoefficient(a.surname, b.surname) < opts.surnameDiceFloor) {
    return zero(surnameScore, firstScore);
  }
  if (firstScore < opts.firstScoreFloor) {
    return zero(surnameScore, firstScore);
  }

  const fullScore = similarity(a.tokens.join(' '), b.tokens.join(' '));
  const score = fullScore * 0.60 + surnameScore * 0.25 + firstScore * 0.15;
  return { score, surnameScore, firstScore };
}

// True when two candidates are the same person with a typo (JJOSEPH/JOSEPH),
// NOT when they are two genuinely different people. Identical strings are
// intentionally NOT collapsed (they may be twins / common names).
function isDuplicateCandidate(a, b, options = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const na = normalizeDriverName(a), nb = normalizeDriverName(b);
  if (!na || !nb || na === nb) return false;
  return diceCoefficient(na, nb) >= 0.90 && similarity(na, nb) >= opts.duplicateThreshold;
}

function isRegisteredProfile(driver) {
  return !!driver && !driver.registrationIncomplete
    && !!(driver.nationalId || driver.phone || driver.userId);
}

function matchDriver(name, drivers = [], options = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const originalName = text(name);
  const normalized   = normalizeDriverName(name);
  const out = (status, method, match, score, candidates = []) =>
    ({ status, method, match, score, originalName, candidates });

  if (!normalized) return out('no_match', 'empty', null, 0);

  // 1) Alias table
  const aliases = Array.isArray(opts.aliases) ? opts.aliases : [];
  const aliasIds = [...new Set(aliases
    .filter(a => normalizeDriverName(a.alias || a.aliasNormalized) === normalized)
    .map(a => a.driverId).filter(Boolean))];
  if (aliasIds.length === 1) {
    const match = drivers.find(d => d.id === aliasIds[0]);
    if (match) return out('exact', 'alias', match, 1);
  }

  // 2) Exact normalized-name match
  const exact = drivers.filter(d => nameVariants(d).some(v => normalizeDriverName(v) === normalized));
  if (exact.length === 1) return out('exact', 'normalized', exact[0], 1);
  if (exact.length > 1) {
    // Duplicate bridge-created stubs may coexist with a registered profile.
    // Prefer the completed profile; do not let duplicate names become fuzzy ambiguity.
    const registered = exact.filter(isRegisteredProfile);
    if (registered.length === 1) return out('exact', 'normalized-registered', registered[0], 1);
    // 0 or 2+ registered profiles -> fall through so ambiguity is surfaced honestly.
  }

  // 3) Fuzzy scoring — each candidate scored by its best variant
  const scored = drivers
    .map(driver => {
      let best = { score: 0, surnameScore: 0 };
      for (const variant of nameVariants(driver)) {
        const s = scoreName(originalName, variant, opts);
        if (s.score > best.score) best = s;
      }
      if (best.score <= 0) return null;               // filtered by hard gates
      const bonus = opts.vendorId && driver.vendorId === opts.vendorId ? 0.02 : 0;
      return {
        driver,
        score: Math.min(1, best.score + bonus),
        surnameScore: best.surnameScore
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);

  // 4) Collapse near-identical typo stubs (JJOSEPH KARANI -> JOSEPH KARANI)
  const collapsed = [];
  for (const candidate of scored) {
    const candName = candidate.driver.name || candidate.driver.fullName || '';
    const existing = collapsed.find(c =>
      isDuplicateCandidate(candName, c.driver.name || c.driver.fullName || '', opts));
    if (!existing) { collapsed.push(candidate); continue; }
    if (candidate.score > existing.score) {
      collapsed[collapsed.indexOf(existing)] = candidate;
    } else if (Math.abs(candidate.score - existing.score) < 1e-9
               && isRegisteredProfile(candidate.driver)) {
      collapsed[collapsed.indexOf(existing)] = candidate;
    }
  }
  collapsed.sort((a, b) => b.score - a.score);

  const candidatePayload = collapsed.slice(0, opts.candidateLimit).map(c => ({
    driverId:     c.driver.id,
    name:         c.driver.name || c.driver.fullName,
    score:        c.score,
    surnameScore: c.surnameScore
  }));

  const top = collapsed[0];

  // 5) Nothing reaches the review threshold
  if (!top || top.score < opts.reviewThreshold) {
    return out('no_match', 'fuzzy', null, top ? top.score : 0, candidatePayload);
  }

  // 6) Ambiguity between two genuinely different people
  if (collapsed[1] && top.score - collapsed[1].score < opts.ambiguityMargin) {
    return out('ambiguous', 'fuzzy', null, top.score, candidatePayload);
  }

  // 7) Auto-match gate
  if (top.score >= opts.autoMatchThreshold && top.surnameScore >= opts.surnameThreshold) {
    return out('auto', 'fuzzy', top.driver, top.score, candidatePayload);
  }

  // 8) Manual review
  return out('review', 'fuzzy', null, top.score, candidatePayload);
}

module.exports = {
  DEFAULT_OPTIONS,
  normalizeDriverName,
  matchDriver,
  nameParts,
  scoreName,
  diceCoefficient   // exported for tests / diagnostics
};