const bcrypt = require('bcryptjs');
const {
  Role,
  Permission,
  User,
  UserProfile,
  Vendor,
  Driver,
  Vehicle,
  Material,
  PurchaseOrder,
} = require('./models');

const permissions = [
  'users.create', 'users.read', 'users.update', 'roles.manage', 'settings.manage',
  'vendors.manage', 'vendors.read', 'drivers.manage', 'vehicles.manage', 'materials.manage',
  'purchase_orders.create', 'purchase_orders.read', 'purchase_orders.update',
  'delivery_orders.create', 'delivery_orders.read', 'delivery_orders.update', 'delivery_orders.cancel',
  'dispatch.submit', 'weighbridge.capture_origin', 'weighbridge.capture_destination',
  'receipt_notes.submit', 'reconciliation.run', 'reconciliation.override',
  'reports.view', 'reports.export', 'compliance.view', 'audit_logs.view', 'notifications.read',
];

const rolePermissions = {
  administrator: permissions,
  management: permissions.filter((permission) => !['roles.manage', 'settings.manage'].includes(permission)),
  operator: [
    'vendors.read', 'drivers.manage', 'vehicles.manage', 'purchase_orders.read',
    'delivery_orders.create', 'delivery_orders.read', 'delivery_orders.update',
    'dispatch.submit', 'weighbridge.capture_origin', 'weighbridge.capture_destination',
    'receipt_notes.submit', 'compliance.view', 'notifications.read',
  ],
};

async function seedCore() {
  const permissionModels = {};
  for (const name of permissions) {
    const [permission] = await Permission.findOrCreate({ where: { name }, defaults: { description: name } });
    permissionModels[name] = permission;
  }

  for (const [roleName, names] of Object.entries(rolePermissions)) {
    const [role] = await Role.findOrCreate({
      where: { name: roleName },
      defaults: { description: `${roleName} role` },
    });
    await role.setPermissions(names.map((name) => permissionModels[name]));
  }

  const adminRole = await Role.findOne({ where: { name: 'administrator' } });
  const passwordHash = await bcrypt.hash(process.env.SEED_ADMIN_PASSWORD || 'password', 12);
  const [admin] = await User.findOrCreate({
    where: { username: 'admin' },
    defaults: {
      fullName: 'System Administrator',
      email: 'admin@trucksphere.local',
      passwordHash,
      role_id: adminRole.id,
      mustCompleteProfile: false,
    },
  });
  await UserProfile.findOrCreate({ where: { user_id: admin.id }, defaults: { department: 'Administration', position: 'Administrator' } });

  const [vendor] = await Vendor.findOrCreate({
    where: { vendorCode: 'VEN-001' },
    defaults: { name: 'Mwangi Transport Ltd', contactPerson: 'John Mwangi', phone: '+254700100200', email: 'ops@mwangi.example' },
  });
  const [material] = await Material.findOrCreate({
    where: { code: 'BALLAST-34' },
    defaults: { name: 'Ballast 3/4"', unit: 'tonnes' },
  });
  await Driver.findOrCreate({
    where: { licenseNumber: 'DL-001' },
    defaults: { fullName: 'David Mwangi', phone: '+254712345678', nationalId: 'ID-001', licenseExpiryDate: '2027-12-31', vendor_id: vendor.id },
  });
  await Vehicle.findOrCreate({
    where: { registrationNumber: 'KCA 123A' },
    defaults: { make: 'Volvo', model: 'FH 460', year: 2023, capacity: 40, vendor_id: vendor.id },
  });
  await PurchaseOrder.findOrCreate({
    where: { poNumber: 'PO-2026-001' },
    defaults: {
      vendor_id: vendor.id,
      material_id: material.id,
      orderedQuantity: 200,
      deliveredQuantity: 0,
      remainingQuantity: 200,
      status: 'open',
    },
  });
}

module.exports = seedCore;
