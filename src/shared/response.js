function ok(res, data, meta = {}) {
  return res.json({ success: true, data, meta });
}

function created(res, data, meta = {}) {
  return res.status(201).json({ success: true, data, meta });
}

function noContent(res) {
  return res.status(204).send();
}

module.exports = { ok, created, noContent };
