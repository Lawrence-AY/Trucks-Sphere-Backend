const { Op } = require('sequelize');
const asyncHandler = require('../../shared/asyncHandler');
const { ok, created, noContent } = require('../../shared/response');
const { getPagination, getPagingMeta, getSort } = require('../../shared/pagination');
const ApiError = require('../../shared/apiError');
const { writeAudit } = require('../../services/auditService');

function buildWhere(query, searchable = [], exactFilters = []) {
  const where = {};
  for (const field of exactFilters) {
    if (query[field]) where[field] = query[field];
  }
  if (query.search && searchable.length) {
    where[Op.or] = searchable.map((field) => ({ [field]: { [Op.iLike]: `%${query.search}%` } }));
  }
  return where;
}

function crudRouter({ express, model, entityName, searchable = [], exactFilters = [], auth, permissions = {} }) {
  const router = express.Router();
  const readPermission = permissions.read || `${entityName}.read`;
  const managePermission = permissions.manage || `${entityName}.manage`;

  router.get('/', auth.authenticate, auth.authorize(readPermission, managePermission), asyncHandler(async (req, res) => {
    const { page, limit, offset } = getPagination(req.query);
    const where = buildWhere(req.query, searchable, exactFilters);
    const result = await model.findAndCountAll({ where, limit, offset, order: getSort(req.query) });
    return ok(res, result.rows, getPagingMeta(result.count, page, limit));
  }));

  router.post('/', auth.authenticate, auth.authorize(managePermission), asyncHandler(async (req, res) => {
    const item = await model.create(req.body);
    await writeAudit({ req, action: `${entityName}.created`, entityType: entityName, entityId: item.id, metadata: req.body });
    return created(res, item);
  }));

  router.get('/:id', auth.authenticate, auth.authorize(readPermission, managePermission), asyncHandler(async (req, res) => {
    const item = await model.findByPk(req.params.id);
    if (!item) throw new ApiError(404, `${entityName} not found`, 'NOT_FOUND');
    return ok(res, item);
  }));

  router.patch('/:id', auth.authenticate, auth.authorize(managePermission), asyncHandler(async (req, res) => {
    const item = await model.findByPk(req.params.id);
    if (!item) throw new ApiError(404, `${entityName} not found`, 'NOT_FOUND');
    await item.update(req.body);
    await writeAudit({ req, action: `${entityName}.updated`, entityType: entityName, entityId: item.id, metadata: req.body });
    return ok(res, item);
  }));

  router.delete('/:id', auth.authenticate, auth.authorize(managePermission), asyncHandler(async (req, res) => {
    const item = await model.findByPk(req.params.id);
    if (!item) throw new ApiError(404, `${entityName} not found`, 'NOT_FOUND');
    if ('status' in item) await item.update({ status: 'inactive' });
    else await item.destroy();
    await writeAudit({ req, action: `${entityName}.deleted`, entityType: entityName, entityId: item.id });
    return noContent(res);
  }));

  return router;
}

module.exports = { crudRouter, buildWhere };
