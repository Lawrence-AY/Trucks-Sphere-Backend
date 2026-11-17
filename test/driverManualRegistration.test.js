const test = require('node:test');
const assert = require('node:assert/strict');

function loadController(service) {
  const servicePath = require.resolve('../src/modules/drivers/service');
  const controllerPath = require.resolve('../src/modules/drivers/controller');
  require.cache[servicePath] = { id: servicePath, filename: servicePath, loaded: true, exports: service };
  delete require.cache[controllerPath];
  const controller = require(controllerPath);
  return () => {
    delete require.cache[controllerPath];
    delete require.cache[servicePath];
  };
}

function response() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

test('manual driver create preserves the selected vendor and does not verify through IPRS', async () => {
  let created;
  const restore = loadController({
    findByNationalId: async () => null,
    create: async (data) => { created = data; return { id: 'D901', ...data }; },
  });
  try {
    const res = response();
    await require('../src/modules/drivers/controller').create({
      body: { vendorId: 'V083', nationalId: '12345678', firstName: 'Amina', surname: 'Wanjiku', phone: '0712345678', licenseNumber: 'DL901' },
      user: { id: 'U001' },
    }, res, (err) => { throw err; });
    assert.equal(res.statusCode, 201);
    assert.equal(created.vendorId, 'V083');
    assert.equal(created.registrationSource, 'MANUAL');
    assert.equal(created.iprsVerified, false);
    assert.equal(created.registeredBy, 'U001');
  } finally { restore(); }
});

test('manual driver create rejects missing required vendor, phone, and license values', async () => {
  for (const [field, code] of [['vendorId', 'VENDOR_REQUIRED'], ['phone', 'DRIVER_PHONE_REQUIRED'], ['licenseNumber', 'DRIVER_LICENSE_REQUIRED']]) {
    const restore = loadController({ findByNationalId: async () => null, create: async () => assert.fail('invalid driver must not be created') });
    try {
      const body = { vendorId: 'V083', nationalId: '12345678', firstName: 'Amina', surname: 'Wanjiku', phone: '0712345678', licenseNumber: 'DL901' };
      body[field] = '';
      const res = response();
      await require('../src/modules/drivers/controller').create({ body, user: { id: 'U001' } }, res, (err) => { throw err; });
      assert.equal(res.statusCode, 400);
      assert.equal(res.body.code, code);
    } finally { restore(); }
  }
});

test('manual driver create rejects a National ID associated with another vendor', async () => {
  const existing = { id: 'D001', nationalId: '12345678', vendorId: 'V001' };
  const restore = loadController({ findByNationalId: async () => existing, create: async () => assert.fail('duplicate driver must not be created') });
  try {
    const res = response();
    await require('../src/modules/drivers/controller').create({
      body: { vendorId: 'V083', nationalId: '12345678', firstName: 'Amina', surname: 'Wanjiku', phone: '0712345678', licenseNumber: 'DL901' },
    }, res, (err) => { throw err; });
    assert.equal(res.statusCode, 409);
    assert.equal(res.body.code, 'DRIVER_ALREADY_ASSIGNED');
    assert.equal(res.body.driver.id, 'D001');
  } finally { restore(); }
});
