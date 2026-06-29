const { DataTypes } = require('sequelize');
const sequelize = require('../../config/database');

const common = {
  id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
};

const Role = sequelize.define('Role', {
  ...common,
  name: { type: DataTypes.STRING(80), allowNull: false, unique: true },
  description: DataTypes.TEXT,
}, { tableName: 'roles', underscored: true });

const Permission = sequelize.define('Permission', {
  ...common,
  name: { type: DataTypes.STRING(120), allowNull: false, unique: true },
  description: DataTypes.TEXT,
}, { tableName: 'permissions', underscored: true });

const RolePermission = sequelize.define('RolePermission', {
  ...common,
}, { tableName: 'role_permissions', underscored: true });

const User = sequelize.define('User', {
  ...common,
  username: { type: DataTypes.STRING(80), allowNull: false, unique: true },
  email: { type: DataTypes.STRING(160), allowNull: false, unique: true, validate: { isEmail: true } },
  passwordHash: { type: DataTypes.TEXT, allowNull: false, field: 'password_hash' },
  fullName: { type: DataTypes.STRING(160), allowNull: false, field: 'full_name' },
  phone: DataTypes.STRING(40),
  status: { type: DataTypes.ENUM('active', 'inactive', 'suspended'), defaultValue: 'active' },
  mustCompleteProfile: { type: DataTypes.BOOLEAN, defaultValue: true, field: 'must_complete_profile' },
  lastLoginAt: { type: DataTypes.DATE, field: 'last_login_at' },
}, {
  tableName: 'users',
  underscored: true,
  indexes: [{ fields: ['username'] }, { fields: ['email'] }, { fields: ['status'] }],
});

const UserProfile = sequelize.define('UserProfile', {
  ...common,
  profilePictureUrl: { type: DataTypes.TEXT, field: 'profile_picture_url' },
  nationalId: { type: DataTypes.STRING(80), field: 'national_id' },
  department: DataTypes.STRING(120),
  position: DataTypes.STRING(120),
  emergencyContactName: { type: DataTypes.STRING(160), field: 'emergency_contact_name' },
  emergencyContactPhone: { type: DataTypes.STRING(40), field: 'emergency_contact_phone' },
}, { tableName: 'user_profiles', underscored: true });

const RefreshToken = sequelize.define('RefreshToken', {
  ...common,
  tokenHash: { type: DataTypes.TEXT, allowNull: false, field: 'token_hash' },
  expiresAt: { type: DataTypes.DATE, allowNull: false, field: 'expires_at' },
  revokedAt: { type: DataTypes.DATE, field: 'revoked_at' },
}, { tableName: 'refresh_tokens', underscored: true });

const Vendor = sequelize.define('Vendor', {
  ...common,
  vendorCode: { type: DataTypes.STRING(80), allowNull: false, unique: true, field: 'vendor_code' },
  name: { type: DataTypes.STRING(180), allowNull: false },
  contactPerson: { type: DataTypes.STRING(160), field: 'contact_person' },
  phone: DataTypes.STRING(40),
  email: { type: DataTypes.STRING(160), validate: { isEmail: true } },
  address: DataTypes.TEXT,
  status: { type: DataTypes.ENUM('active', 'inactive'), defaultValue: 'active' },
}, { tableName: 'vendors', underscored: true, indexes: [{ fields: ['vendor_code'] }, { fields: ['status'] }] });

const Driver = sequelize.define('Driver', {
  ...common,
  fullName: { type: DataTypes.STRING(160), allowNull: false, field: 'full_name' },
  phone: DataTypes.STRING(40),
  email: { type: DataTypes.STRING(160), validate: { isEmail: true } },
  nationalId: { type: DataTypes.STRING(80), unique: true, field: 'national_id' },
  licenseNumber: { type: DataTypes.STRING(100), allowNull: false, field: 'license_number' },
  licenseExpiryDate: { type: DataTypes.DATEONLY, allowNull: false, field: 'license_expiry_date' },
  status: { type: DataTypes.ENUM('active', 'inactive', 'suspended'), defaultValue: 'active' },
}, { tableName: 'drivers', underscored: true, indexes: [{ fields: ['national_id'] }, { fields: ['license_expiry_date'] }] });

const DriverDocument = sequelize.define('DriverDocument', {
  ...common,
  documentType: { type: DataTypes.STRING(100), allowNull: false, field: 'document_type' },
  documentUrl: { type: DataTypes.TEXT, field: 'document_url' },
  expiresAt: { type: DataTypes.DATEONLY, field: 'expires_at' },
}, { tableName: 'driver_documents', underscored: true });

const Vehicle = sequelize.define('Vehicle', {
  ...common,
  registrationNumber: { type: DataTypes.STRING(80), allowNull: false, unique: true, field: 'registration_number' },
  make: DataTypes.STRING(100),
  model: DataTypes.STRING(100),
  year: DataTypes.INTEGER,
  capacity: { type: DataTypes.INTEGER, allowNull: false, validate: { min: 1 } },
  status: { type: DataTypes.ENUM('active', 'inactive', 'maintenance', 'out_of_service'), defaultValue: 'active' },
}, { tableName: 'vehicles', underscored: true, indexes: [{ fields: ['registration_number'] }, { fields: ['status'] }] });

const VehicleDocument = sequelize.define('VehicleDocument', {
  ...common,
  documentType: { type: DataTypes.STRING(100), allowNull: false, field: 'document_type' },
  documentUrl: { type: DataTypes.TEXT, field: 'document_url' },
  expiresAt: { type: DataTypes.DATEONLY, field: 'expires_at' },
}, { tableName: 'vehicle_documents', underscored: true });

const Material = sequelize.define('Material', {
  ...common,
  code: { type: DataTypes.STRING(80), allowNull: false, unique: true },
  name: { type: DataTypes.STRING(160), allowNull: false },
  unit: { type: DataTypes.STRING(40), defaultValue: 'tonnes' },
  status: { type: DataTypes.ENUM('active', 'inactive'), defaultValue: 'active' },
}, { tableName: 'materials', underscored: true });

const PurchaseOrder = sequelize.define('PurchaseOrder', {
  ...common,
  poNumber: { type: DataTypes.STRING(80), allowNull: false, unique: true, field: 'po_number' },
  orderedQuantity: { type: DataTypes.INTEGER, allowNull: false, field: 'ordered_quantity', validate: { min: 1 } },
  deliveredQuantity: { type: DataTypes.INTEGER, defaultValue: 0, field: 'delivered_quantity' },
  remainingQuantity: { type: DataTypes.INTEGER, defaultValue: 0, field: 'remaining_quantity' },
  status: {
    type: DataTypes.ENUM('draft', 'open', 'partially_delivered', 'completed', 'cancelled'),
    defaultValue: 'open',
  },
}, { tableName: 'purchase_orders', underscored: true, indexes: [{ fields: ['po_number'] }, { fields: ['status'] }] });

const DeliveryOrder = sequelize.define('DeliveryOrder', {
  ...common,
  deliveryNumber: { type: DataTypes.STRING(80), allowNull: false, unique: true, field: 'delivery_number' },
  quantity: { type: DataTypes.INTEGER, allowNull: false, validate: { min: 1 } },
  origin: DataTypes.STRING(180),
  destination: DataTypes.STRING(180),
  status: {
    type: DataTypes.ENUM('draft', 'scheduled', 'dispatched', 'origin_weighbridge', 'in_transit', 'destination_weighbridge', 'delivered', 'reconciled', 'completed', 'cancelled'),
    defaultValue: 'draft',
  },
  scheduledAt: { type: DataTypes.DATE, field: 'scheduled_at' },
  dispatchedAt: { type: DataTypes.DATE, field: 'dispatched_at' },
  completedAt: { type: DataTypes.DATE, field: 'completed_at' },
}, { tableName: 'delivery_orders', underscored: true, indexes: [{ fields: ['delivery_number'] }, { fields: ['status'] }, { fields: ['scheduled_at'] }] });

const Dispatch = sequelize.define('Dispatch', {
  ...common,
  notes: DataTypes.TEXT,
  submittedAt: { type: DataTypes.DATE, defaultValue: DataTypes.NOW, field: 'submitted_at' },
}, { tableName: 'dispatches', underscored: true });

const WeighbridgeRecord = sequelize.define('WeighbridgeRecord', {
  ...common,
  type: { type: DataTypes.ENUM('origin', 'destination'), allowNull: false },
  weight: { type: DataTypes.DECIMAL(12, 2), allowNull: false },
  ticketNumber: { type: DataTypes.STRING(100), allowNull: false, unique: true, field: 'ticket_number' },
  stationName: { type: DataTypes.STRING(160), allowNull: false, field: 'station_name' },
  capturedAt: { type: DataTypes.DATE, defaultValue: DataTypes.NOW, field: 'captured_at' },
}, { tableName: 'weighbridge_records', underscored: true, indexes: [{ fields: ['delivery_order_id', 'type'] }] });

const ReceiptNote = sequelize.define('ReceiptNote', {
  ...common,
  receiptStatus: { type: DataTypes.ENUM('accepted', 'accepted_with_remarks', 'rejected'), allowNull: false, field: 'receipt_status' },
  receiptNote: { type: DataTypes.TEXT, field: 'receipt_note' },
  receivedAt: { type: DataTypes.DATE, defaultValue: DataTypes.NOW, field: 'received_at' },
}, { tableName: 'receipt_notes', underscored: true });

const Attachment = sequelize.define('Attachment', {
  ...common,
  fileName: { type: DataTypes.STRING(240), allowNull: false, field: 'file_name' },
  fileType: { type: DataTypes.STRING(120), field: 'file_type' },
  fileUrl: { type: DataTypes.TEXT, allowNull: false, field: 'file_url' },
  attachmentType: { type: DataTypes.STRING(80), field: 'attachment_type' },
}, { tableName: 'attachments', underscored: true });

const Reconciliation = sequelize.define('Reconciliation', {
  ...common,
  originWeight: { type: DataTypes.DECIMAL(12, 2), allowNull: false, field: 'origin_weight' },
  destinationWeight: { type: DataTypes.DECIMAL(12, 2), allowNull: false, field: 'destination_weight' },
  difference: { type: DataTypes.DECIMAL(12, 2), allowNull: false },
  tolerance: { type: DataTypes.DECIMAL(12, 2), allowNull: false },
  hasDiscrepancy: { type: DataTypes.BOOLEAN, defaultValue: false, field: 'has_discrepancy' },
  status: { type: DataTypes.ENUM('matched', 'discrepancy', 'overridden'), allowNull: false },
  reconciledAt: { type: DataTypes.DATE, defaultValue: DataTypes.NOW, field: 'reconciled_at' },
}, { tableName: 'reconciliations', underscored: true, indexes: [{ fields: ['status'] }, { fields: ['has_discrepancy'] }] });

const ReconciliationHistory = sequelize.define('ReconciliationHistory', {
  ...common,
  action: { type: DataTypes.STRING(100), allowNull: false },
  reason: DataTypes.TEXT,
  snapshot: DataTypes.JSONB,
}, { tableName: 'reconciliation_histories', underscored: true });

const DeliveryTimeline = sequelize.define('DeliveryTimeline', {
  ...common,
  status: { type: DataTypes.STRING(80), allowNull: false },
  title: { type: DataTypes.STRING(160), allowNull: false },
  description: DataTypes.TEXT,
  occurredAt: { type: DataTypes.DATE, defaultValue: DataTypes.NOW, field: 'occurred_at' },
}, { tableName: 'delivery_timelines', underscored: true });

const AuditLog = sequelize.define('AuditLog', {
  ...common,
  action: { type: DataTypes.STRING(120), allowNull: false },
  entityType: { type: DataTypes.STRING(120), field: 'entity_type' },
  entityId: { type: DataTypes.UUID, field: 'entity_id' },
  metadata: DataTypes.JSONB,
  ipAddress: { type: DataTypes.STRING(80), field: 'ip_address' },
}, { tableName: 'audit_logs', underscored: true, indexes: [{ fields: ['action'] }, { fields: ['entity_type', 'entity_id'] }, { fields: ['created_at'] }] });

const Notification = sequelize.define('Notification', {
  ...common,
  title: { type: DataTypes.STRING(160), allowNull: false },
  message: { type: DataTypes.TEXT, allowNull: false },
  readAt: { type: DataTypes.DATE, field: 'read_at' },
}, { tableName: 'notifications', underscored: true });

const SystemSetting = sequelize.define('SystemSetting', {
  ...common,
  key: { type: DataTypes.STRING(120), allowNull: false, unique: true },
  value: DataTypes.JSONB,
  description: DataTypes.TEXT,
}, { tableName: 'system_settings', underscored: true });

Role.belongsToMany(Permission, { through: RolePermission, foreignKey: 'role_id' });
Permission.belongsToMany(Role, { through: RolePermission, foreignKey: 'permission_id' });
Role.hasMany(User, { foreignKey: 'role_id' });
User.belongsTo(Role, { foreignKey: 'role_id' });
User.hasOne(UserProfile, { foreignKey: 'user_id' });
UserProfile.belongsTo(User, { foreignKey: 'user_id' });
User.hasMany(RefreshToken, { foreignKey: 'user_id' });
RefreshToken.belongsTo(User, { foreignKey: 'user_id' });

Vendor.hasMany(PurchaseOrder, { foreignKey: 'vendor_id' });
PurchaseOrder.belongsTo(Vendor, { foreignKey: 'vendor_id' });
Material.hasMany(PurchaseOrder, { foreignKey: 'material_id' });
PurchaseOrder.belongsTo(Material, { foreignKey: 'material_id' });

Vendor.hasMany(Driver, { foreignKey: 'vendor_id' });
Driver.belongsTo(Vendor, { foreignKey: 'vendor_id' });
Vendor.hasMany(Vehicle, { foreignKey: 'vendor_id' });
Vehicle.belongsTo(Vendor, { foreignKey: 'vendor_id' });
Driver.hasMany(DriverDocument, { foreignKey: 'driver_id' });
DriverDocument.belongsTo(Driver, { foreignKey: 'driver_id' });
Vehicle.hasMany(VehicleDocument, { foreignKey: 'vehicle_id' });
VehicleDocument.belongsTo(Vehicle, { foreignKey: 'vehicle_id' });

PurchaseOrder.hasMany(DeliveryOrder, { foreignKey: 'purchase_order_id' });
DeliveryOrder.belongsTo(PurchaseOrder, { foreignKey: 'purchase_order_id' });
Vendor.hasMany(DeliveryOrder, { foreignKey: 'vendor_id' });
DeliveryOrder.belongsTo(Vendor, { foreignKey: 'vendor_id' });
Driver.hasMany(DeliveryOrder, { foreignKey: 'driver_id' });
DeliveryOrder.belongsTo(Driver, { foreignKey: 'driver_id' });
Vehicle.hasMany(DeliveryOrder, { foreignKey: 'vehicle_id' });
DeliveryOrder.belongsTo(Vehicle, { foreignKey: 'vehicle_id' });
Material.hasMany(DeliveryOrder, { foreignKey: 'material_id' });
DeliveryOrder.belongsTo(Material, { foreignKey: 'material_id' });

DeliveryOrder.hasOne(Dispatch, { foreignKey: 'delivery_order_id' });
Dispatch.belongsTo(DeliveryOrder, { foreignKey: 'delivery_order_id' });
User.hasMany(Dispatch, { foreignKey: 'submitted_by' });
Dispatch.belongsTo(User, { as: 'submitter', foreignKey: 'submitted_by' });

DeliveryOrder.hasMany(WeighbridgeRecord, { foreignKey: 'delivery_order_id' });
WeighbridgeRecord.belongsTo(DeliveryOrder, { foreignKey: 'delivery_order_id' });
User.hasMany(WeighbridgeRecord, { foreignKey: 'captured_by' });
WeighbridgeRecord.belongsTo(User, { as: 'capturer', foreignKey: 'captured_by' });

DeliveryOrder.hasOne(ReceiptNote, { foreignKey: 'delivery_order_id' });
ReceiptNote.belongsTo(DeliveryOrder, { foreignKey: 'delivery_order_id' });
User.hasMany(ReceiptNote, { foreignKey: 'received_by' });
ReceiptNote.belongsTo(User, { as: 'receiver', foreignKey: 'received_by' });

DeliveryOrder.hasMany(Attachment, { foreignKey: 'delivery_order_id' });
Attachment.belongsTo(DeliveryOrder, { foreignKey: 'delivery_order_id' });
ReceiptNote.hasMany(Attachment, { foreignKey: 'receipt_note_id' });
Attachment.belongsTo(ReceiptNote, { foreignKey: 'receipt_note_id' });
User.hasMany(Attachment, { foreignKey: 'uploaded_by' });
Attachment.belongsTo(User, { as: 'uploader', foreignKey: 'uploaded_by' });

DeliveryOrder.hasOne(Reconciliation, { foreignKey: 'delivery_order_id' });
Reconciliation.belongsTo(DeliveryOrder, { foreignKey: 'delivery_order_id' });
Reconciliation.hasMany(ReconciliationHistory, { foreignKey: 'reconciliation_id' });
ReconciliationHistory.belongsTo(Reconciliation, { foreignKey: 'reconciliation_id' });
User.hasMany(ReconciliationHistory, { foreignKey: 'user_id' });
ReconciliationHistory.belongsTo(User, { foreignKey: 'user_id' });

DeliveryOrder.hasMany(DeliveryTimeline, { foreignKey: 'delivery_order_id' });
DeliveryTimeline.belongsTo(DeliveryOrder, { foreignKey: 'delivery_order_id' });
User.hasMany(DeliveryTimeline, { foreignKey: 'user_id' });
DeliveryTimeline.belongsTo(User, { foreignKey: 'user_id' });
User.hasMany(AuditLog, { foreignKey: 'user_id' });
AuditLog.belongsTo(User, { foreignKey: 'user_id' });
User.hasMany(Notification, { foreignKey: 'user_id' });
Notification.belongsTo(User, { foreignKey: 'user_id' });

module.exports = {
  sequelize,
  Role,
  Permission,
  RolePermission,
  User,
  UserProfile,
  RefreshToken,
  Vendor,
  Driver,
  DriverDocument,
  Vehicle,
  VehicleDocument,
  Material,
  PurchaseOrder,
  DeliveryOrder,
  Dispatch,
  WeighbridgeRecord,
  ReceiptNote,
  Attachment,
  Reconciliation,
  ReconciliationHistory,
  DeliveryTimeline,
  AuditLog,
  Notification,
  SystemSetting,
};
