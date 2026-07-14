const createResourceRoutes = require('../../utils/resourceRoutesFactory');
const createResourceService = require('../../utils/resourceServiceFactory');

const service = createResourceService({
  collectionName: 'users',
  searchableFields: ['displayName', 'name', 'email', 'username', 'role'],
  defaultSortField: 'displayName',
  defaultSortDirection: 'asc',
});

module.exports = createResourceRoutes(service);
