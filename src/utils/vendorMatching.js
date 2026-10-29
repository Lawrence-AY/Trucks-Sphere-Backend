/**
 * Vendor name matching for the TruckSphere access bridge.
 *
 * Pure, dependency-free normalisation + fuzzy similarity so weighbridge
 * captures resolve to the correct existing vendor despite typing errors,
 * abbreviations, casing and punctuation differences.
 *
 * A similarity score is a matching aid only - it never proves two names
 * belong to the same business. High-confidence scores still flow through the
 * normal association rules; ambiguous or low-confidence results are parked for
 * authorised review rather than creating a new vendor.
 */

const DEFAULT_OPTIONS = {
  autoMatchThreshold: 0.90,   // >= this and unambiguous => confident auto-match
  reviewThreshold: 0.72,      // >= this (but < auto) => candidate for review
  ambiguityMargin: 0.05,      // 2nd-best within this margin of best => ambiguous
  candidateLimit: 5,
};

const SUFFIX_MAP = {
  ltd: 'limited',
  co: 'company',
  corp: 'corporation',
  inc: 'incorporated',
  llc: 'limited liability company',
  llp: 'limited liability partnership',
  plc: 'public limited company',
  pty: 'proprietary',
};

const STOP_WORDS = new Set(['the', 'of', 'and', 'a', 'an', 'at', 'for', 'to', 'in', 'on']);

// Confirmed business-name alias. The canonical vendor record remains the
// full East Africa name; the shorter Firebase/import spelling resolves to it.
const KNOWN_VENDOR_ALIASES = new Map([
  ['metro concepts ea limited', 'metro concepts east africa limited'],
]);

function tokenize(value) {
  return String(value == null ? '' : value)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .match(/[a-z0-9]+/g) || [];
}

function canonicalTokens(value) {
  return tokenize(value)
    .map(token => SUFFIX_MAP[token] || token)
    .filter(token => !STOP_WORDS.has(token))
    .sort();
}

function normalizeName(value) {
  return canonicalTokens(value).join(' ');
}

function jaro(a, b) {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  const range = Math.floor(Math.max(a.length, b.length) / 2) - 1;
  const aMatch = new Array(a.length).fill(false);
  const bMatch = new Array(b.length).fill(false);
  let matches = 0;
  for (let i = 0; i < a.length; i++) {
    const lo = Math.max(0, i - range);
    const hi = Math.min(i + range + 1, b.length);
    for (let j = lo; j < hi; j++) {
      if (bMatch[j] || a[i] !== b[j]) continue;
      aMatch[i] = true;
      bMatch[j] = true;
      matches++;
      break;
    }
  }
  if (!matches) return 0;
  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < a.length; i++) {
    if (!aMatch[i]) continue;
    while (!bMatch[k]) k++;
    if (a[i] !== b[k]) transpositions++;
    k++;
  }
  return (matches / a.length + matches / b.length + (matches - transpositions / 2) / matches) / 3;
}

function jaroWinkler(a, b, prefixScale = 0.1) {
  const j = jaro(a, b);
  let prefix = 0;
  const maxPrefix = Math.min(4, a.length, b.length);
  while (prefix < maxPrefix && a[prefix] === b[prefix]) prefix++;
  return j + prefix * prefixScale * (1 - j);
}

function tokenSimilarity(aTokens, bTokens) {
  if (!aTokens.length || !bTokens.length) return 0;
  const a = new Set(aTokens);
  const b = new Set(bTokens);
  let shared = 0;
  for (const token of a) if (b.has(token)) shared++;
  if (!shared) return 0;
  const dice = (2 * shared) / (a.size + b.size);
  const containment = shared >= 2 ? shared / Math.min(a.size, b.size) : 0;
  return Math.max(dice, containment);
}

function similarity(a, b) {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  return Math.max(jaroWinkler(na, nb), tokenSimilarity(canonicalTokens(a), canonicalTokens(b)));
}

function vendorNames(vendor) {
  return [vendor.name, vendor.companyName, vendor.vendorName, ...(Array.isArray(vendor.aliases) ? vendor.aliases : [])]
    .filter(v => typeof v === 'string' && v.trim());
}

// Returns one of: exact | auto | ambiguous | review | no_match.
// The match field is populated only for exact and auto (safe to associate).
function matchVendor(name, vendors = [], options = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const original = String(name == null ? '' : name).trim();
  const normalized = normalizeName(original);
  const knownName = KNOWN_VENDOR_ALIASES.get(normalized) || normalized;
  const aliases = Array.isArray(opts.aliases) ? opts.aliases : [];

  const aliasHit = aliases.find(a =>
    normalizeName(a.alias) === normalized || normalizeName(a.aliasNormalized || a.alias) === normalized);
  if (aliasHit) {
    const vendor = vendors.find(v => v.id === aliasHit.vendorId) || null;
    return { status: 'exact', method: 'alias', match: vendor, score: 1, originalName: original, candidates: [] };
  }

  const exact = vendors.find(v => vendorNames(v).some(vn => normalizeName(vn) === knownName));
  if (exact) {
    return { status: 'exact', method: 'normalized', match: exact, score: 1, originalName: original, candidates: [] };
  }

  const scored = vendors
    .map(vendor => {
      let best = 0;
      for (const vn of vendorNames(vendor)) best = Math.max(best, similarity(vn, original));
      return { vendor, score: best };
    })
    .filter(c => c.score > 0)
    .sort((a, b) => b.score - a.score);

  const candidates = scored.slice(0, opts.candidateLimit);

  if (!scored.length || scored[0].score < opts.reviewThreshold) {
    return { status: 'no_match', method: 'fuzzy', match: null, score: scored.length ? scored[0].score : 0, originalName: original, candidates };
  }
  const top = scored[0];
  const second = scored[1];
  if (second && top.score - second.score < opts.ambiguityMargin) {
    return { status: 'ambiguous', method: 'fuzzy', match: null, score: top.score, originalName: original, candidates };
  }
  if (top.score >= opts.autoMatchThreshold) {
    return { status: 'auto', method: 'fuzzy', match: top.vendor, score: top.score, originalName: original, candidates };
  }
  return { status: 'review', method: 'fuzzy', match: null, score: top.score, originalName: original, candidates };
}

module.exports = { DEFAULT_OPTIONS, normalizeName, similarity, matchVendor, tokenize, canonicalTokens, jaro, jaroWinkler, tokenSimilarity };
