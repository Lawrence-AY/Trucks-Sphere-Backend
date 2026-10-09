const test = require('node:test');
const assert = require('node:assert/strict');
const { isFuelReady } = require('../src/utils/fuelEligibility');
const job = { id: 'delivery-1', jobId: 'JOB-1', status: 'SITE_WEIGHED_OUT' };

test('fuel-ready list excludes saved fuel records under either job identifier', () => {
  for (const record of [{ jobId: 'JOB-1' }, { jobId: 'delivery-1' }, { deliveryOrderId: 'delivery-1' }]) {
    assert.equal(isFuelReady(job, [job], [record]), false);
  }
});
test('unfueled finalized jobs remain eligible and incomplete jobs remain excluded', () => {
  assert.equal(isFuelReady(job, [job], [{ jobId: 'OTHER' }, {}]), true);
  assert.equal(isFuelReady({ ...job, status: 'DISPATCHED' }, [], []), false);
});
