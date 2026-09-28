const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function setup(location) {
  const record = { token: 'secret', status: 'active', securityLocation: location };
  const session = { exists: true, id: 'session1', data: () => record, ref: { update: async value => Object.assign(record, value) } };
  const exports = {};
  const mocks = {
    './service': { findByPlate: () => ({ id: 'delivery1' }) },
    '../../utils/trackingUtils': {},
    '../../../config/firebase': { db: { collection: () => ({ doc: () => ({ get: async () => session }) }) } },
    crypto: require('node:crypto'),
    '../sms/service': {},
    './siteFlags': {},
    '../../utils/cloudStorage': { uploadFile: async () => ({ url: 'https://storage.example/driver.jpg' }) },
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../src/modules/tracking/controller'), 'utf8'), { exports, require: name => mocks[name], console });
  const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
  const req = { params: { sessionId: session.id }, body: { token: 'secret', plateNumber: 'KAA123B', photosCaptured: true } };
  return { controller: exports, req, res, record };
}

test('gate vehicle search proceeds without requiring a photo', async () => {
  const { controller, req, res } = setup('Gate');
  await controller.attachSecuritySessionVehicle(req, res, error => { throw error; });
  assert.equal(res.statusCode, 200);
});

test('gate saves photo evidence linked to the session and delivery', async () => {
  const { controller, req, res, record } = setup(' Gate ');
  req.file = { buffer: Buffer.from('photo'), originalname: 'driver.jpg', mimetype: 'image/jpeg' };
  await controller.attachSecuritySessionVehicle(req, res, error => { throw error; });
  assert.equal(res.statusCode, 200);
  assert.equal(record.driverPhotoURL, 'https://storage.example/driver.jpg');
  assert.equal(record.orderId, 'delivery1');
  assert.equal(record.photosCaptured, true);
});

test('checkpoint vehicle selection does not require a driver photo', async () => {
  const { controller, req, res, record } = setup('Checkpoint 1');
  await controller.attachSecuritySessionVehicle(req, res, error => { throw error; });
  assert.equal(res.statusCode, 200);
  assert.equal(record.photosCaptured, false);
});

test('gate decision cannot bypass photo capture', async () => {
  const { controller, req, res } = setup('Gate');
  req.body.outcome = 'verified';
  await controller.recordSecurityDecision(req, res, error => { throw error; });
  assert.equal(res.statusCode, 400);
});
