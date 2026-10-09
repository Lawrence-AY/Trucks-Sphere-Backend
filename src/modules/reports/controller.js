/**
 * Reports Controller
 *
 * Handles admin reporting dashboard data, CSV exports, and Excel export requests.
 * Supports per-category live summaries, CSV downloads, and master Excel export.
 */

const reportsService = require('./service');
const excelBuilder = require('./excelBuilder');
const csvBuilder = require('./csvBuilder');
const snapshotStore = require('../../utils/snapshotStore');

/**
 * Parse filter options from query params.
 */
function parseOptions(query) {
  const { filter, start_date, end_date } = query;
  const options = {};
  if (filter && filter !== 'all') options.filter = filter;
  if (start_date) options.startDate = start_date;
  if (end_date) options.endDate = end_date;
  if ((start_date || end_date) && !options.filter) options.filter = 'custom';
  if (typeof query.material === 'string' && query.material.trim()) options.material = query.material.trim();
  return options;
}

/**
 * GET /api/admin/reports/export
 *
 * Download a multi-sheet Master Audit Excel (.xlsx) file.
 * Query params: ?filter=day|week|month|all&start_date=YYYY-MM-DD&end_date=YYYY-MM-DD
 */
exports.exportExcel = async (req, res, next) => {
  try {
    const options = parseOptions(req.query);
    const { start_date, end_date, filter } = req.query;

    // Build all report data
    const data = {      masterAudit: reportsService.buildMasterAudit(options),
      materialInspections: reportsService.buildMaterialInspectionReport(options),
      storeActivity: reportsService.buildStoreActivityReport(options),
      warehouse: reportsService.buildMasterAudit(options).filter((r) => r.origin === 'Warehouse'),
      flagged: reportsService.buildFlaggedReport(options),
      drivers: reportsService.buildDriverReport(),
      fuel: reportsService.buildFuelReport(options),
      trucks: reportsService.buildTruckReport(),
      materials: reportsService.buildMaterialReport(options),
      vendors: reportsService.buildVendorReport(options),
      purchaseOrders: reportsService.buildPOReport(options),
    };

    let suffix = '';
    if (options.filter === 'day') suffix = 'Today';
    else if (options.filter === 'week') suffix = 'This Week';
    else if (options.filter === 'month') suffix = 'This Month';
    else if (options.filter === 'custom') suffix = `${start_date || 'start'} to ${end_date || 'end'}`;

    const buffer = await excelBuilder.buildExcelWorkbook(data, suffix);

    const filename = `TruckSphere_Audit_${new Date().toISOString().slice(0, 10)}.xlsx`;

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', buffer.length);
    res.send(Buffer.from(buffer));
  } catch (err) {
    console.error('[Reports] Export error:', err.message);
    next(err);
  }
};

/**
 * GET /api/admin/reports/summary
 *
 * Returns JSON summary metrics for all categories.
 */
exports.getSummary = async (req, res, next) => {
  try {
    const options = parseOptions(req.query);
    const summary = reportsService.buildSummary(options);
    res.json(summary);
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/admin/reports/summary/:category
 *
 * Returns per-category live preview data for the tabbed dashboard.
 * @param category - deliveries|fuel|vendors|trucks|drivers|materials|purchase-orders
 */
exports.getCategorySummary = async (req, res, next) => {
  try {
    const { category } = req.params;
    const options = parseOptions(req.query);

    let data;
    switch (category) {
      case 'stocks':
        return res.status(404).json({ error: 'Report unavailable' });
      case 'deliveries': {
        const deliveries = reportsService.buildMasterAudit(options);
        data = {
          ...reportsService.buildSummary(options).deliveries,
          preview: deliveries.slice(0, 5),
        };
        break;
      }
      case 'fuel': {
        const fuel = reportsService.buildFuelReport(options);
        data = {
          totalLitres: fuel.reduce((s, f) => s + (Number(f.litres) || 0), 0),
          transactions: fuel.length,
          preview: fuel.slice(0, 5),
        };
        break;
      }
      case 'vendors': {
        const vendors = reportsService.buildVendorReport(options);
        data = {
          total: vendors.length,
          active: vendors.filter(v => v.status === 'active').length,
          totalDelivered: vendors.reduce((s, v) => s + (Number(v.totalDelivered) || 0), 0),
          preview: vendors.slice(0, 5),
        };
        break;
      }
      case 'trucks': {
        const trucks = reportsService.buildTruckReport();
        data = {
          total: trucks.length,
          active: trucks.filter(t => t.status === 'active').length,
          expiredInsurance: trucks.filter(t => t.insuranceStatus === 'expired').length,
          preview: trucks.slice(0, 5),
        };
        break;
      }
      case 'drivers': {
        const drivers = reportsService.buildDriverReport();
        data = {
          total: drivers.length,
          active: drivers.filter(d => d.status === 'active').length,
          expiredInsurance: drivers.filter(d => d.insuranceStatus === 'expired').length,
          preview: drivers.slice(0, 5),
        };
        break;
      }
      case 'materials': {
        const materials = reportsService.buildMaterialReport(options);
        data = {
          total: materials.length,
          types: materials.map(m => m.materialName).filter(Boolean),
          totalDelivered: materials.reduce((s, m) => s + (Number(m.totalDelivered) || 0), 0),
          preview: materials.slice(0, 5),
        };
        break;
      }
      case 'purchase-orders': {
        const poRows = reportsService.buildPOReport(options);
        const pos = [...new Map(poRows.map(row => [row.purchaseOrderId || row.poNumber, row])).values()];
        data = {
          total: pos.length,
          open: pos.filter(p => ['approved', 'pending', 'in_progress'].includes(p.status)).length,
          fulfilled: pos.filter(p => ['completed', 'delivered'].includes(p.status)).length,
          preview: pos.slice(0, 5),
        };
        break;
      }
      default:
        return res.status(400).json({ error: `Unknown category: ${category}` });
    }

    res.json(data);
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/admin/reports/export/csv/:category
 *
 * Download a CSV file for a specific category.
 * @param category - deliveries|fuel|vendors|trucks|drivers|materials|purchase-orders
 */
exports.exportCategoryCSV = async (req, res, next) => {
  try {
    const { category } = req.params;
    const options = parseOptions(req.query);

    let rows = [];
    let filename = '';

    switch (category) {
      case 'stocks':
        return res.status(404).json({ error: 'Report unavailable' });
      case 'deliveries':
        rows = reportsService.buildMasterAudit(options);
        filename = `Deliveries_${new Date().toISOString().slice(0, 10)}.csv`;
        break;
      case 'fuel':
        rows = reportsService.buildFuelReport(options);
        filename = `Fuel_${new Date().toISOString().slice(0, 10)}.csv`;
        break;
      case 'vendors':
        rows = reportsService.buildVendorReport(options);
        filename = `Vendors_${new Date().toISOString().slice(0, 10)}.csv`;
        break;
      case 'trucks':
        rows = reportsService.buildTruckReport();
        filename = `Trucks_${new Date().toISOString().slice(0, 10)}.csv`;
        break;
      case 'drivers':
        rows = reportsService.buildDriverReport();
        filename = `Drivers_${new Date().toISOString().slice(0, 10)}.csv`;
        break;
      case 'materials':
        rows = reportsService.buildMaterialReport(options);
        filename = `Materials_${new Date().toISOString().slice(0, 10)}.csv`;
        break;
      case 'purchase-orders':
        rows = reportsService.buildPOReport(options);
        filename = `PurchaseOrders_${new Date().toISOString().slice(0, 10)}.csv`;
        break;
      case 'fulfilled-purchase-orders':
        rows = reportsService.buildPOReport({ ...options, fulfilledOnly: true });
        filename = `Fulfilled_PurchaseOrders_${new Date().toISOString().slice(0, 10)}.csv`;
        break;
      case 'quarry-ops':
        rows = reportsService.buildMasterAudit(options).filter(r => r.quarryInTimeEAT);
        filename = `QuarryOps_${new Date().toISOString().slice(0, 10)}.csv`;
        break;
      case 'site-ops':
        rows = reportsService.buildMasterAudit(options).filter(r => r.siteInTimeEAT || r.warehouseAcceptedAt);
        filename = `SiteOps_${new Date().toISOString().slice(0, 10)}.csv`;
        break;
      case 'inspections':
        rows = reportsService.buildMaterialInspectionReport(options);
        filename = `Material_Inspections_${new Date().toISOString().slice(0, 10)}.csv`;
        break;
      case 'storeActivity':
      case 'store-activity':
        rows = reportsService.buildStoreActivityReport(options);
        filename = `Store_Activity_${new Date().toISOString().slice(0, 10)}.csv`;
        break;
      case 'warehouse':
        rows = reportsService.buildMasterAudit(options).filter(r => r.origin === 'Warehouse').map(r => ({
          jobId: r.jobId, poNumber: r.poNumber, vendorName: r.vendorName,
          driverName: r.driverName, plateNumber: r.plateNumber, trackingActivity: r.trackingActivity, trackingPhotos: r.trackingPhotos, 'MRF Source': r.mrfSource, 'MRF Number': r.warehouseMrf, dispatchedAt: r.dispatchedAt,
          items: r.warehouseItems, receiptStatus: r.warehouseReceiptStatus,
          acceptedAt: r.warehouseAcceptedAt, acceptedBy: r.warehouseAcceptedBy,
          receivedItems: r.warehouseReceivedItems, mifNumber: r.mrfNumber,
          inspector: r.inspectorName, inspectedAt: r.inspectionAtEAT,
          inspectionResult: r.inspectionResult,
          deniedAt: r.warehouseDeniedAt, denialReason: r.warehouseDenialReason,
        }));
        filename = `Warehouse_${new Date().toISOString().slice(0, 10)}.csv`;
        break;
      default:
        return res.status(400).json({ error: `Unknown category: ${category}` });
    }

    const csv = csvBuilder.buildCSV(rows);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csv);
  } catch (err) {
    console.error('[Reports] CSV export error:', err.message);
    next(err);
  }
};
