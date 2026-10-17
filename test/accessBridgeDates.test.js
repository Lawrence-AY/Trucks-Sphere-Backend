const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeCaptureDates } = require('../src/integrations/access-bridge/captureDates');
const { parseCapture } = require('../src/integrations/access-bridge/loading');
const reference = '2026-10-17T12:00:00Z';

test('both November weighs become July 11 without changing clocks or input', () => {
  const row = { TARIH1: '2026-11-07T00:00:00', TARIH2: '2026-11-07T00:00:00', SAAT1: '08:33:56' };
  const fixed = normalizeCaptureDates(row, reference);
  assert.equal(fixed.TARIH1, '2026-07-11T00:00:00');
  assert.equal(fixed.TARIH2, fixed.TARIH1);
  assert.equal(fixed.SAAT1, row.SAAT1);
  assert.equal(row.TARIH1, '2026-11-07T00:00:00');
});

test('valid past, invalid calendar, and unswappable dates remain unchanged', () => {
  for (const date of ['2026-08-10', '2026-06-13', '2026-02-30', '2026-12-25', '1899-12-30']) {
    assert.equal(normalizeCaptureDates({ TARIH1: date }, reference).TARIH1, date);
  }
  assert.equal(normalizeCaptureDates({ TARIH1: '2026-11-07' }, '2026-12-01T00:00:00Z').TARIH1, '2026-11-07');
});

test('reference uses source local day at UTC midnight boundary', () => {
  assert.equal(normalizeCaptureDates({ TARIH1: '2026-11-07' }, '2026-11-06T22:00:00Z').TARIH1, '2026-11-07');
});

test('loading tickets use corrected local date and stable identity', () => {
  const row = { PLAKA: 'KAA123A', TARTIM1: 6100, TARTIM2: 16750, NET: 10650,
    TARIH1: '2026-12-06T00:00:00', TARIH2: '2026-06-13T00:00:00', SAAT1: '16:19:59', SAAT2: '11:08:12' };
  const event = { table_name: 'KAYITLAR', observed_utc: reference, payload: JSON.stringify(row) };
  const config = { sourceId: 'bridge', utcOffset: '+03:00' };
  const parsed = parseCapture(event, config);
  assert.equal(parsed.firstAt, '2026-06-12T13:19:59.000Z');
  assert.equal(parsed.secondAt, '2026-06-13T08:08:12.000Z');
  assert.equal(parsed.date, '2026-06-12');
  assert.equal(parsed.key, parseCapture({ ...event, payload: JSON.stringify({ ...row, TARIH1: '2026-06-12T00:00:00' }) }, config).key);
});
