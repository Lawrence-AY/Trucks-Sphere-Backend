const createResourceRoutes = require('../../utils/resourceRoutesFactory');
const createResourceService = require('../../utils/resourceServiceFactory');

const service = createResourceService({
  collectionName: 'fuelStations',
  cacheName: 'fuelStations',
  searchableFields: ['name', 'location', 'operatorName', 'phone'],
  defaultSortField: 'name',
  defaultSortDirection: 'asc',
});

module.exports = createResourceRoutes(service);
