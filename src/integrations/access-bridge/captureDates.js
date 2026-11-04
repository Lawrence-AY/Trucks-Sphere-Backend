// Access exports may use ISO order (yyyy/mm/dd or yyyy-mm-dd) or swap the
// month/day components. Anchor correction to upload time so retries produce
// the same capture identity.
function normalizeCaptureDates(row, observedAt, offset = '+03:00') {
  const reference = new Date(observedAt || Date.now());
  const match = offset.match(/^([+-])(\d{2}):(\d{2})$/);
  if (!Number.isFinite(reference.getTime()) || !match) throw new Error('INVALID_CAPTURE_REFERENCE');
  const minutes = (Number(match[2]) * 60 + Number(match[3])) * (match[1] === '-' ? -1 : 1);
  const localDay = new Date(reference.getTime() + minutes * 60000).toISOString().slice(0, 10);
  const dayDistance = date => (Date.parse(`${localDay}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`)) / 86400000;
  const result = { ...row };
  const valid = date => {
    const parsed = new Date(date + 'T00:00:00Z');
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
  };
  for (const field of ['TARIH1', 'TARIH2']) {
    const value = String(row[field] || '');
    const parts = value.match(/^(\d{4})[\/-](\d{2})[\/-](\d{2})(?=$|[T ])/);
    if (!parts) continue;
    const original = `${parts[1]}-${parts[2]}-${parts[3]}`;
    const swapped = `${parts[1]}-${parts[3]}-${parts[2]}`;
    const originalValid = valid(original);
    const swappedValid = valid(swapped);
    // Prefer whichever interpretation is the observed local day. This makes
    // 2026/11/03 resolve to 3 November when it was captured on that date,
    // while 2026/03/11 resolves to the same day when Access means dd/mm.
    const originalRecent = originalValid && dayDistance(original) >= 0 && dayDistance(original) <= 2;
    const swappedRecent = swappedValid && dayDistance(swapped) >= 0 && dayDistance(swapped) <= 2;
    const resolved = originalValid && original === localDay ? original
      : swappedValid && swapped === localDay ? swapped
      : originalRecent && !swappedRecent ? original
      : swappedRecent && !originalRecent ? swapped
      : originalValid && original > localDay && swappedValid && swapped <= localDay ? swapped
      : originalValid ? original
      : swappedValid ? swapped
      : null;
    if (resolved) result[field] = resolved + value.slice(parts[0].length);
  }
  return result;
}
module.exports = { normalizeCaptureDates };
