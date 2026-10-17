// Some Access exports swap day/month only for dates whose day is <= 12.
// Anchor correction to upload time so retries produce the same capture identity.
function normalizeCaptureDates(row, observedAt, offset = '+03:00') {
  const reference = new Date(observedAt || Date.now());
  const match = offset.match(/^([+-])(\d{2}):(\d{2})$/);
  if (!Number.isFinite(reference.getTime()) || !match) throw new Error('INVALID_CAPTURE_REFERENCE');
  const minutes = (Number(match[2]) * 60 + Number(match[3])) * (match[1] === '-' ? -1 : 1);
  const localDay = new Date(reference.getTime() + minutes * 60000).toISOString().slice(0, 10);
  const result = { ...row };
  const valid = date => {
    const parsed = new Date(date + 'T00:00:00Z');
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
  };
  for (const field of ['TARIH1', 'TARIH2']) {
    const value = String(row[field] || '');
    const parts = value.match(/^(\d{4})-(\d{2})-(\d{2})(?=$|[T ])/);
    if (!parts) continue;
    const original = parts[0];
    const swapped = parts[1] + '-' + parts[3] + '-' + parts[2];
    if (valid(original) && original > localDay && valid(swapped) && swapped <= localDay) {
      result[field] = swapped + value.slice(10);
    }
  }
  return result;
}
module.exports = { normalizeCaptureDates };
