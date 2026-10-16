// Candidates have already matched vendor + material. Narrow commercial context
// before consistently reusing an existing duplicate; never merge/delete orders.
const normalize = value => String(value ?? '').trim().replace(/\s+/g, ' ').toUpperCase();
function selectBridgePurchaseOrder(candidates, context = {}) {
  let matches = candidates.slice();
  for (const [value, fields] of [[context.siteId, ['siteId']], [context.siteName, ['siteName']],
    [context.origin, ['quarryLocation', 'quarryName', 'materialSource']]]) {
    if (!normalize(value)) continue;
    const exact = matches.filter(order => fields.some(field => normalize(order[field]) === normalize(value)));
    if (exact.length) matches = exact;
  }
  if (matches.length <= 1) return matches[0] || null;
  // Without captured vendor/material identity there is no basis for reuse.
  if (!context.vendor || !context.material) return null;
  for (const fields of [['siteId', 'siteName'], ['quarryId', 'quarryLocation', 'quarryName']]) {
    for (const field of fields) {
      const values = new Set(matches.map(order => normalize(order[field])).filter(Boolean));
      if (values.size > 1) return null;
    }
  }
  return matches.sort((a, b) => {
    const manual = Number(!!a.bridgeCreated) - Number(!!b.bridgeCreated);
    const timestamp = order => typeof order.createdAt === 'string' ? Date.parse(order.createdAt)
      : typeof order.createdAt?.toMillis === 'function' ? order.createdAt.toMillis() : NaN;
    const oldest = (timestamp(a) || Infinity) - (timestamp(b) || Infinity);
    return manual || (Number.isNaN(oldest) ? 0 : oldest)
      || String(a.poNumber || a.id).localeCompare(String(b.poNumber || b.id), undefined, { numeric: true })
      || String(a.id).localeCompare(String(b.id));
  })[0];
}
module.exports = { selectBridgePurchaseOrder };
