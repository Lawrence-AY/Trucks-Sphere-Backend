const { db } = require('../../../config/firebase');
const ExcelJS = require('exceljs');
const driversService = require('../drivers/service');
const vehiclesService = require('../vehicles/service');
const vendorsService = require('../vendors/service');
const { verifyDriverIdentity } = require('../../integrations/iprsService');

const IMPORT_TYPES = new Set(['drivers', 'vehicles', 'vendors']);

function normaliseHeader(value) {
  return String(value || '')
    .replace(/^\uFEFF/, '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
}

function normaliseText(value) {
  return String(value ?? '').trim();
}

function normaliseKey(value) {
  return normaliseText(value).toLowerCase();
}

function normaliseNationalId(value) {
  return normaliseText(value).replace(/\s+/g, '').toUpperCase();
}

function normalisePlate(value) {
  return normaliseText(value).replace(/\s+/g, '').toUpperCase();
}

function omitUndefinedFields(record) {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

// RFC 4180-compatible enough for mobile-exported CSVs: quoted fields,
// escaped quotes, CRLF, and a BOM are all supported without another parser.
function rowsToParsedData(records) {
  if (!records.length) return { headers: [], rows: [] };

  const headers = records.shift().map(normaliseHeader);
  const rows = records
    .filter((record) => record.some((value) => normaliseText(value)))
    .map((record, offset) => {
      const data = {};
      headers.forEach((header, index) => {
        if (header) data[header] = normaliseText(record[index]);
      });
      return { rowNumber: offset + 2, raw: data };
    });
  return { headers, rows };
}

function parseCsv(buffer) {
  const text = Buffer.from(buffer).toString('utf8').replace(/^\uFEFF/, '');
  const records = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field.replace(/\r$/, ''));
      records.push(row);
      row = [];
      field = '';
    } else {
      field += char;
    }
  }
  if (field.length || row.length) {
    row.push(field.replace(/\r$/, ''));
    records.push(row);
  }
  return rowsToParsedData(records);
}

function excelCellText(cell) {
  const value = cell.value;
  if (value === undefined || value === null) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'object' && value.result !== undefined) return normaliseText(value.result);
  return cell.text || normaliseText(value);
}

async function parseXlsx(buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Buffer.from(buffer));
  const worksheet = workbook.worksheets[0];
  if (!worksheet) return { headers: [], rows: [] };

  const columnCount = worksheet.actualColumnCount;
  const records = [];
  worksheet.eachRow({ includeEmpty: false }, (row) => {
    records.push(Array.from({ length: columnCount }, (_value, index) => excelCellText(row.getCell(index + 1))));
  });
  return rowsToParsedData(records);
}

async function parseImportFile(buffer, file = {}) {
  const filename = String(file.originalname || file.name || '').toLowerCase();
  const mimeType = String(file.mimetype || file.mimeType || '').toLowerCase();
  const isXlsx = filename.endsWith('.xlsx') || mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  return isXlsx ? parseXlsx(buffer) : parseCsv(buffer);
}

function column(row, aliases) {
  for (const alias of aliases) {
    const value = row[alias];
    if (normaliseText(value)) return normaliseText(value);
  }
  return '';
}

function statusSummary(rows) {
  return rows.reduce((summary, row) => {
    summary.total += 1;
    if (row.status === 'READY') summary.ready += 1;
    if (row.status === 'SKIPPED') summary.skipped += 1;
    if (row.status === 'INVALID') summary.invalid += 1;
    return summary;
  }, { total: 0, ready: 0, skipped: 0, invalid: 0 });
}

function missing(code) {
  return { status: 'INVALID', code };
}

async function vendorIndex() {
  const byId = new Map();
  const byName = new Map();
  const snapshot = await db.collection('vendors').get();
  snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() })).forEach((vendor) => {
    const id = normaliseKey(vendor.id || vendor.vendorId);
    if (id) byId.set(id, vendor);
    const name = normaliseKey(vendor.companyName || vendor.name);
    if (name) byName.set(name, vendor);
  });
  return { byId, byName };
}

function resolveVendor(row, vendors) {
  const vendorId = column(row, ['vendor_id', 'vendorid']);
  const vendorName = column(row, ['vendor_name', 'vendor_company_name', 'vendor', 'company_name']);
  const vendor = (vendorId && vendors.byId.get(normaliseKey(vendorId))) ||
    (vendorName && vendors.byName.get(normaliseKey(vendorName)));
  return vendor || null;
}

function labelFor(type, item) {
  if (type === 'drivers') return item.fullName || 'Unnamed driver';
  if (type === 'vehicles') return item.registrationNumber || 'Unnamed vehicle';
  return item.companyName || 'Unnamed vendor';
}

function buildDriver(row, vendors) {
  const vendor = resolveVendor(row, vendors);
  const firstName = column(row, ['first_name', 'firstname']);
  const surname = column(row, ['surname', 'last_name', 'lastname']);
  const driver = {
    vendorId: vendor?.id || '',
    firstName,
    surname,
    fullName: [firstName, surname].filter(Boolean).join(' '),
    phone: column(row, ['phone', 'phone_number', 'mobile']),
    email: column(row, ['email', 'email_address']) || undefined,
    nationalId: normaliseNationalId(column(row, ['national_id', 'nationalid', 'id_number', 'identity_number'])),
    licenseNumber: column(row, ['license_number', 'licence_number', 'driving_license']),
    licenseClass: column(row, ['license_class', 'licence_class']) || undefined,
    licenseExpiry: column(row, ['license_expiry', 'licence_expiry']) || undefined,
    emergencyContact: column(row, ['emergency_contact', 'emergency_phone']) || undefined,
    status: column(row, ['status']) || 'active',
  };
  const item = omitUndefinedFields(driver);
  if (!vendor) return { ...missing('VENDOR_NOT_FOUND'), item };
  if (!driver.firstName) return { ...missing('MISSING_DRIVER_FIRST_NAME'), item };
  if (!driver.surname) return { ...missing('MISSING_DRIVER_SURNAME'), item };
  if (!driver.phone) return { ...missing('MISSING_DRIVER_PHONE'), item };
  if (!driver.nationalId) return { ...missing('MISSING_NATIONAL_ID'), item };
  return { status: 'READY', code: 'READY', item };
}

function buildVehicle(row, vendors) {
  const vendor = resolveVendor(row, vendors);
  const registrationNumber = normalisePlate(column(row, ['registration_number', 'registration', 'plate_number', 'plate']));
  const vehicle = {
    vendorId: vendor?.id || '',
    registrationNumber,
    plateNumber: registrationNumber,
    make: column(row, ['make']) || undefined,
    model: column(row, ['model']) || undefined,
    year: Number(column(row, ['year'])) || undefined,
    type: column(row, ['type', 'vehicle_type', 'truck_type']) || undefined,
    color: column(row, ['color']) || undefined,
    insuranceExpiry: column(row, ['insurance_expiry']) || undefined,
    inspectionExpiry: column(row, ['inspection_expiry']) || undefined,
    lastInspection: column(row, ['last_inspection']) || undefined,
    status: column(row, ['status']) || 'active',
  };
  const item = omitUndefinedFields(vehicle);
  if (!vendor) return { ...missing('VENDOR_NOT_FOUND'), item };
  if (!registrationNumber) return { ...missing('MISSING_REGISTRATION_NUMBER'), item };
  if (!vehicle.type) return { ...missing('MISSING_VEHICLE_TYPE'), item };
  return { status: 'READY', code: 'READY', item };
}

function buildVendor(row) {
  const vendor = {
    companyName: column(row, ['company_name', 'company', 'vendor_name', 'name']),
    contactPerson: column(row, ['contact_person', 'contact_name', 'contact']),
    phone: column(row, ['phone', 'phone_number', 'mobile']),
    email: column(row, ['email', 'email_address']) || undefined,
    address: column(row, ['address', 'physical_address']) || undefined,
    kraPin: column(row, ['kra_pin', 'krapin']) || undefined,
    registrationNumber: column(row, ['registration_number', 'business_registration_number']) || undefined,
    businessPermit: column(row, ['business_permit']) || undefined,
    companyActCR12: column(row, ['company_act_cr12', 'cr12']) || undefined,
    fleetSize: Number(column(row, ['fleet_size'])) || 0,
    taxCompliance: column(row, ['tax_compliance']) || undefined,
    status: column(row, ['status']) || 'active',
  };
  const item = omitUndefinedFields(vendor);
  if (!vendor.companyName) return { ...missing('MISSING_COMPANY_NAME'), item };
  if (!vendor.contactPerson) return { ...missing('MISSING_CONTACT_PERSON'), item };
  if (!vendor.phone) return { ...missing('MISSING_VENDOR_PHONE'), item };
  return { status: 'READY', code: 'READY', item };
}

function detectExisting(type, item, indexes) {
  if (type === 'drivers' && indexes.drivers.has(normaliseNationalId(item.nationalId))) return 'DRIVER_ALREADY_EXISTS';
  if (type === 'vehicles' && indexes.vehicles.has(normalisePlate(item.registrationNumber || item.plateNumber))) return 'VEHICLE_ALREADY_EXISTS';
  if (type === 'vendors' && indexes.vendors.has(normaliseKey(item.companyName))) return 'VENDOR_ALREADY_EXISTS';
  return '';
}

async function existingIndexes() {
  const [drivers, vehicles, vendors] = await Promise.all([
    db.collection('drivers').get(),
    db.collection('vehicles').get(),
    db.collection('vendors').get(),
  ]);
  return {
    drivers: new Set(drivers.docs.map((doc) => normaliseNationalId(doc.data().nationalId)).filter(Boolean)),
    vehicles: new Set(vehicles.docs.map((doc) => normalisePlate(doc.data().registrationNumber || doc.data().plateNumber)).filter(Boolean)),
    vendors: new Set(vendors.docs.map((doc) => normaliseKey(doc.data().companyName || doc.data().name)).filter(Boolean)),
  };
}

async function previewRows(type, rawRows) {
  const [vendors, indexes] = await Promise.all([vendorIndex(), existingIndexes()]);
  const seen = new Set();
  const build = type === 'drivers' ? buildDriver : type === 'vehicles' ? buildVehicle : buildVendor;

  return rawRows.map(({ rowNumber, raw }) => {
    const result = type === 'vendors' ? build(raw) : build(raw, vendors);
    const item = result.item;
    const row = { rowNumber, status: result.status, code: result.code, label: labelFor(type, item), item };
    if (row.status !== 'READY') return row;
    const existing = detectExisting(type, item, indexes);
    if (existing) return { ...row, status: 'SKIPPED', code: existing };
    const unique = type === 'drivers'
      ? normaliseNationalId(item.nationalId)
      : type === 'vehicles'
        ? normalisePlate(item.registrationNumber)
        : normaliseKey(item.companyName);
    if (seen.has(unique)) return { ...row, status: 'SKIPPED', code: 'DUPLICATE_IN_FILE' };
    seen.add(unique);
    return row;
  });
}

function assertImportType(type) {
  if (!IMPORT_TYPES.has(type)) {
    throw Object.assign(new Error('Unsupported import type'), { statusCode: 400, code: 'CSV_IMPORT_TYPE_INVALID' });
  }
}

async function runCreate(type, item) {
  if (type === 'drivers') {
    await verifyDriverIdentity({
      nationalId: item.nationalId,
      firstName: item.firstName,
      surname: item.surname,
    });
    return driversService.create(item);
  }
  if (type === 'vehicles') return vehiclesService.create(item);
  return vendorsService.create(item);
}

const bulkImportService = {
  async preview(type, buffer, file) {
    assertImportType(type);
    const parsed = await parseImportFile(buffer, file);
    if (!parsed.headers.length) {
      throw Object.assign(new Error('CSV headers missing'), { statusCode: 400, code: 'CSV_HEADERS_REQUIRED' });
    }
    const rows = await previewRows(type, parsed.rows);
    return { type, headers: parsed.headers, counts: statusSummary(rows), rows };
  },

  async commit(type, buffer, file) {
    const preview = await this.preview(type, buffer, file);
    const rows = [];
    for (const row of preview.rows) {
      if (row.status !== 'READY') {
        rows.push(row);
        continue;
      }
      try {
        await runCreate(type, row.item);
        rows.push({ ...row, status: 'IMPORTED', code: 'IMPORTED' });
      } catch (error) {
        const code = String(error?.code || '').toUpperCase();
        const duplicate = error?.statusCode === 409 || code.includes('DUPLICATE') || code.includes('EXISTS');
        rows.push({
          ...row,
          status: duplicate ? 'SKIPPED' : 'INVALID',
          code: duplicate ? 'ENTRY_ALREADY_EXISTS' : 'IMPORT_ROW_FAILED',
        });
      }
    }
    const counts = rows.reduce((summary, row) => {
      summary.total += 1;
      if (row.status === 'IMPORTED') summary.imported += 1;
      if (row.status === 'SKIPPED') summary.skipped += 1;
      if (row.status === 'INVALID') summary.invalid += 1;
      return summary;
    }, { total: 0, imported: 0, skipped: 0, invalid: 0 });
    return { type, counts, rows };
  },
};

module.exports = bulkImportService;
