const createResourceRoutes = require('../../utils/resourceRoutesFactory');
const createResourceService = require('../../utils/resourceServiceFactory');
const { requireManagementAccess } = require('../../middleware/authorizationMiddleware');

const service = createResourceService({
  collectionName: 'roles',
  searchableFields: ['name', 'description'],
  defaultSortField: 'name',
  defaultSortDirection: 'asc',
});

module.exports = createResourceRoutes(service, {
  middleware: [requireManagementAccess({ superAdminOnly: true })],
});
