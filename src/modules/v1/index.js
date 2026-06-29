const express = require('express');
const { authenticate, authorize } = require('../../middleware/v1AuthMiddleware');
const { crudRouter } = require('./crudFactory');
const {
  User,
  Role,
  Vendor,
  Driver,
  Vehicle,
  Material,
  WeighbridgeRecord,
  ReceiptNote,
  Reconciliation,
  Notification,
  AuditLog,
  SystemSetting,
} = require('../../database/models');

const router = express.Router();
const auth = { authenticate, authorize };

router.get('/', (req, res) => {
  res.json({
    success: true,
    data: {
      name: 'TruckSphere V1 API',
      stack: ['Express', 'Sequelize', 'PostgreSQL', 'JWT'],
      modules: [
        'auth',
        'users',
        'roles',
        'vendors',
        'drivers',
        'vehicles',
        'materials',
        'purchase-orders',
        'delivery-orders',
        'weighbridge',
        'receipt-notes',
        'reconciliation',
        'dashboard',
        'reports',
        'audit-logs',
      ],
    },
  });
});

router.use('/auth', require('./auth.routes'));
router.use('/users', crudRouter({ express, model: User, entityName: 'users', searchable: ['username', 'email', 'fullName'], exactFilters: ['status'], auth, permissions: { read: 'users.read', manage: 'users.update' } }));
router.use('/roles', crudRouter({ express, model: Role, entityName: 'roles', searchable: ['name'], auth, permissions: { read: 'roles.manage', manage: 'roles.manage' } }));
router.use('/vendors', crudRouter({ express, model: Vendor, entityName: 'vendors', searchable: ['vendorCode', 'name', 'contactPerson'], exactFilters: ['status'], auth, permissions: { read: 'vendors.read', manage: 'vendors.manage' } }));
router.use('/drivers', crudRouter({ express, model: Driver, entityName: 'drivers', searchable: ['fullName', 'licenseNumber', 'nationalId'], exactFilters: ['status', 'vendor_id'], auth, permissions: { read: 'drivers.manage', manage: 'drivers.manage' } }));
router.use('/vehicles', crudRouter({ express, model: Vehicle, entityName: 'vehicles', searchable: ['registrationNumber', 'make', 'model'], exactFilters: ['status', 'vendor_id'], auth, permissions: { read: 'vehicles.manage', manage: 'vehicles.manage' } }));
router.use('/materials', crudRouter({ express, model: Material, entityName: 'materials', searchable: ['code', 'name'], exactFilters: ['status'], auth, permissions: { read: 'materials.manage', manage: 'materials.manage' } }));
router.use('/purchase-orders', require('./purchaseOrder.routes'));
router.use('/delivery-orders', require('./delivery.routes'));
router.use('/weighbridge-records', crudRouter({ express, model: WeighbridgeRecord, entityName: 'weighbridge_records', exactFilters: ['type', 'delivery_order_id'], auth, permissions: { read: 'delivery_orders.read', manage: 'weighbridge.capture_origin' } }));
router.use('/receipt-notes', crudRouter({ express, model: ReceiptNote, entityName: 'receipt_notes', exactFilters: ['receiptStatus', 'delivery_order_id'], auth, permissions: { read: 'delivery_orders.read', manage: 'receipt_notes.submit' } }));
router.use('/reconciliations', crudRouter({ express, model: Reconciliation, entityName: 'reconciliations', exactFilters: ['status', 'hasDiscrepancy'], auth, permissions: { read: 'reconciliation.run', manage: 'reconciliation.override' } }));
router.use('/dashboard', require('./dashboard.routes'));
router.use('/reports', require('./reports.routes'));
router.use('/notifications', crudRouter({ express, model: Notification, entityName: 'notifications', searchable: ['title', 'message'], auth, permissions: { read: 'notifications.read', manage: 'notifications.read' } }));
router.use('/audit-logs', crudRouter({ express, model: AuditLog, entityName: 'audit_logs', searchable: ['action', 'entityType'], auth, permissions: { read: 'audit_logs.view', manage: 'audit_logs.view' } }));
router.use('/settings', crudRouter({ express, model: SystemSetting, entityName: 'settings', searchable: ['key'], auth, permissions: { read: 'settings.manage', manage: 'settings.manage' } }));
router.use('/public', require('./public.routes'));

module.exports = router;
