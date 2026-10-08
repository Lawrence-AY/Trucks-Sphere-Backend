/**
 * Vendor Reports Routes
 *
 * Protected: requires valid auth token + vendor role.
 * Vendors can download their own reports scoped to their vendorId.
 */

const express = require('express');
const router = express.Router();
const vendorReportService = require('./vendorReportService');
const { db } = require('../../../config/firebase');
const { verifyToken } = require('../../middleware/authMiddleware');
const csvBuilder = require('./csvBuilder');
const excelBuilder = require('./excelBuilder');

/**
 * Custom verifyToken that also accepts token as query param (for mobile download links).
 */
async function flexibleAuth(req, res, next) {
  // Try Authorization header first
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const idToken = authHeader.split('Bearer ')[1];
    try {
      const { auth } = require('../../../config/firebase');
      const decodedToken = await auth.verifyIdToken(idToken);
      req.user = decodedToken;
      return next();
    } catch (e) {
      // fall through to query param
    }
  }
  // Try token query param
  if (req.query.token) {
    try {
      const { auth } = require('../../../config/firebase');
      const decodedToken = await auth.verifyIdToken(req.query.token);
      req.user = decodedToken;
      return next();
    } catch (e) {
      return res.status(401).json({ error: 'Unauthorized: Invalid token' });
    }
  }
  return res.status(401).json({ error: 'Unauthorized: No token provided' });
}

router.use(flexibleAuth);

/**
 * Resolve the vendorId for the authenticated user.
 * Looks up the user's vendorId from Firestore users collection,
 * then falls back to vendors collection by email.
 */
async function resolveVendorId(req) {
  const { uid, email } = req.user;

  // Try users collection first
  const userSnap = await db.collection('users').doc(uid).get();
  if (userSnap.exists) {
    const userDoc = userSnap.data();
    if (userDoc.vendorId) {
      return userDoc.vendorId;
    }
  }

  // Fallback: look up vendor by email in vendors collection
  if (email) {
    const vendorsSnap = await db
      .collection('vendors')
      .where('email', '==', email)
      .limit(1)
      .get();
    if (!vendorsSnap.empty) {
      return vendorsSnap.docs[0].id;
    }
  }

  return null;
}

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
  return options;
}

/**
 * GET /api/vendor/reports — list available vendor report types
 */
router.get('/', async (req, res, next) => {
  try {
    const vendorId = await resolveVendorId(req);
    if (!vendorId) {
      return res.status(403).json({ error: 'No vendor profile found for this account.' });
    }

    const vendorSnap = await db.collection('vendors').doc(vendorId).get();
    const vendorName = vendorSnap.exists
      ? (vendorSnap.data().companyName || '')
      : '';

    const reports = [
      {
        id: 'master-audit',
        name: 'Master Audit (Deliveries)',
        category: 'Operations',
        description: 'All deliveries for your company with weights, fuel, and timestamps.',
      },
      {
        id: 'drivers',
        name: 'Drivers',
        category: 'Fleet',
        description: 'Your drivers with license, insurance, and NTSA status.',
      },
      {
        id: 'trucks',
        name: 'Trucks',
        category: 'Fleet',
        description: 'Your trucks with insurance and NTSA status.',
      },
      {
        id: 'fuel',
        name: 'Fuel Consumption',
        category: 'Fleet',
        description: 'Fuel transactions for your vehicles.',
      },
      {
        id: 'purchase-orders',
        name: 'Purchase Orders',
        category: 'Procurement',
        description: 'Your purchase orders with delivery progress.',
      },
    ];

    res.json({
      vendorId,
      vendorName,
      data: reports,
      total: reports.length,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/vendor/reports/export
 * Download a multi-sheet Vendor Excel (.xlsx) file.
 */
router.get('/export', async (req, res, next) => {
  try {
    const vendorId = await resolveVendorId(req);
    if (!vendorId) {
      return res.status(403).json({ error: 'No vendor profile found for this account.' });
    }

    const options = parseOptions(req.query);

    const data = {
      masterAudit: vendorReportService.buildVendorMasterAudit(vendorId, options),
      drivers: vendorReportService.buildVendorDriverReport(vendorId),
      materials: [],
      trucks: vendorReportService.buildVendorTruckReport(vendorId),
      fuel: vendorReportService.buildVendorFuelReport(vendorId, options),
      vendors: [],
      purchaseOrders: vendorReportService.buildVendorPOReport(vendorId, options),
    };

    let suffix = '';
    if (options.filter === 'day') suffix = 'Today';
    else if (options.filter === 'week') suffix = 'This Week';
    else if (options.filter === 'month') suffix = 'This Month';
    else if (options.filter === 'custom')
      suffix = `${req.query.start_date || 'start'} to ${req.query.end_date || 'end'}`;

    const buffer = await excelBuilder.buildExcelWorkbook(data, suffix);

    const filename = `TruckSphere_Vendor_Audit_${new Date().toISOString().slice(0, 10)}.xlsx`;

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', buffer.length);
    res.send(Buffer.from(buffer));
  } catch (err) {
    console.error('[Vendor Reports] Export error:', err.message);
    next(err);
  }
});

/**
 * GET /api/vendor/reports/export/csv/:category
 * Download a CSV file for a specific category (vendor-scoped).
 */
router.get('/export/csv/:category', async (req, res, next) => {
  try {
    const vendorId = await resolveVendorId(req);
    if (!vendorId) {
      return res.status(403).json({ error: 'No vendor profile found for this account.' });
    }

    const { category } = req.params;
    const options = parseOptions(req.query);

    let rows = [];
    let filename = '';

    switch (category) {
      case 'deliveries':
        rows = vendorReportService.buildVendorMasterAudit(vendorId, options);
        filename = `Vendor_Deliveries_${new Date().toISOString().slice(0, 10)}.csv`;
        break;
      case 'drivers':
        rows = vendorReportService.buildVendorDriverReport(vendorId);
        filename = `Vendor_Drivers_${new Date().toISOString().slice(0, 10)}.csv`;
        break;
      case 'trucks':
        rows = vendorReportService.buildVendorTruckReport(vendorId);
        filename = `Vendor_Trucks_${new Date().toISOString().slice(0, 10)}.csv`;
        break;
      case 'fuel':
        rows = vendorReportService.buildVendorFuelReport(vendorId, options);
        filename = `Vendor_Fuel_${new Date().toISOString().slice(0, 10)}.csv`;
        break;
      case 'purchase-orders':
        rows = vendorReportService.buildVendorPOReport(vendorId, options);
        filename = `Vendor_PurchaseOrders_${new Date().toISOString().slice(0, 10)}.csv`;
        break;
      case 'fulfilled-purchase-orders':
        rows = vendorReportService.buildVendorPOReport(vendorId, { ...options, fulfilledOnly: true });
        filename = `Vendor_FulfilledPurchaseOrders_${new Date().toISOString().slice(0, 10)}.csv`;
        break;
      default:
        return res.status(400).json({ error: `Unknown category: ${category}` });
    }

    const csv = csvBuilder.buildCSV(rows);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csv);
  } catch (err) {
    console.error('[Vendor Reports] CSV export error:', err.message);
    next(err);
  }
});

/**
 * GET /api/vendor/reports/summary — JSON summary for vendor dashboard
 */
router.get('/summary', async (req, res, next) => {
  try {
    const vendorId = await resolveVendorId(req);
    if (!vendorId) {
      return res.status(403).json({ error: 'No vendor profile found for this account.' });
    }

    const options = parseOptions(req.query);

    const deliveries = vendorReportService.buildVendorMasterAudit(vendorId, options);
    const fuel = vendorReportService.buildVendorFuelReport(vendorId, options);
    const drivers = vendorReportService.buildVendorDriverReport(vendorId);
    const trucks = vendorReportService.buildVendorTruckReport(vendorId);
    const poRows = vendorReportService.buildVendorPOReport(vendorId, options);
        const pos = [...new Map(poRows.map(row => [row.purchaseOrderId || row.poNumber, row])).values()];

    const totalTonnage = deliveries.reduce(
      (sum, d) => sum + (Number(d.quantityDelivered) || 0),
      0
    );
    const totalFuelLitres = fuel.reduce(
      (sum, f) => sum + (Number(f.litres) || 0),
      0
    );

    res.json({
      deliveries: {
        total: deliveries.length,
        completed: deliveries.filter((d) =>
          ['completed', 'delivered'].includes(String(d.jobStatusCode || '').toLowerCase())
        ).length,
        inTransit: deliveries.filter((d) =>
          ['loaded', 'dispatched', 'in_transit', 'en_route'].includes(String(d.jobStatusCode || '').toLowerCase())
        ).length,
        totalTonnage,
      },
      fuel: {
        totalLitres: totalFuelLitres,
        transactions: fuel.length,
      },
      drivers: {
        total: drivers.length,
        active: drivers.filter((d) => d.status === 'active').length,
        expiredInsurance: drivers.filter(
          (d) => d.insuranceStatus === 'expired'
        ).length,
      },
      trucks: {
        total: trucks.length,
        active: trucks.filter((t) => t.status === 'active').length,
        expiredInsurance: trucks.filter(
          (t) => t.insuranceStatus === 'expired'
        ).length,
      },
      purchaseOrders: {
        total: pos.length,
        open: pos.filter((p) =>
          ['approved', 'pending', 'in_progress'].includes(p.status)
        ).length,
        fulfilled: pos.filter((p) =>
          ['completed', 'delivered'].includes(p.status)
        ).length,
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/vendor/reports/summary/:category
 * Per-category live preview data.
 */
router.get('/summary/:category', async (req, res, next) => {
  try {
    const vendorId = await resolveVendorId(req);
    if (!vendorId) {
      return res.status(403).json({ error: 'No vendor profile found for this account.' });
    }

    const { category } = req.params;
    const options = parseOptions(req.query);

    let data;
    switch (category) {
      case 'deliveries': {
        const deliveries = vendorReportService.buildVendorMasterAudit(vendorId, options);
        data = {
          total: deliveries.length,
          totalTonnage: deliveries.reduce((s, d) => s + (Number(d.quantityDelivered) || 0), 0),
          completed: deliveries.filter((d) =>
            ['completed', 'delivered'].includes(String(d.jobStatusCode || '').toLowerCase())
          ).length,
          inTransit: deliveries.filter((d) =>
            ['loaded', 'dispatched', 'in_transit', 'en_route'].includes(String(d.jobStatusCode || '').toLowerCase())
          ).length,
          preview: deliveries.slice(0, 5),
        };
        break;
      }
      case 'fuel': {
        const fuel = vendorReportService.buildVendorFuelReport(vendorId, options);
        data = {
          totalLitres: fuel.reduce((s, f) => s + (Number(f.litres) || 0), 0),
          transactions: fuel.length,
          preview: fuel.slice(0, 5),
        };
        break;
      }
      case 'drivers': {
        const drivers = vendorReportService.buildVendorDriverReport(vendorId);
        data = {
          total: drivers.length,
          active: drivers.filter((d) => d.status === 'active').length,
          expiredInsurance: drivers.filter((d) => d.insuranceStatus === 'expired').length,
          preview: drivers.slice(0, 5),
        };
        break;
      }
      case 'trucks': {
        const trucks = vendorReportService.buildVendorTruckReport(vendorId);
        data = {
          total: trucks.length,
          active: trucks.filter((t) => t.status === 'active').length,
          expiredInsurance: trucks.filter((t) => t.insuranceStatus === 'expired').length,
          preview: trucks.slice(0, 5),
        };
        break;
      }
      case 'purchase-orders': {
        const poRows = vendorReportService.buildVendorPOReport(vendorId, options);
        const pos = [...new Map(poRows.map(row => [row.purchaseOrderId || row.poNumber, row])).values()];
        data = {
          total: pos.length,
          open: pos.filter((p) =>
            ['approved', 'pending', 'in_progress'].includes(p.status)
          ).length,
          fulfilled: pos.filter((p) =>
            ['completed', 'delivered'].includes(p.status)
          ).length,
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
});

module.exports = router;
