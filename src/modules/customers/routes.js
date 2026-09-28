const createResourceRoutes = require('../../utils/resourceRoutesFactory');
const createResourceService = require('../../utils/resourceServiceFactory');

const service = createResourceService({
  collectionName: 'customers',
  searchableFields: ['name', 'companyName', 'contactPerson', 'email', 'phone'],
  defaultSortField: 'name',
  defaultSortDirection: 'asc',
});

module.exports = createResourceRoutes(service);
