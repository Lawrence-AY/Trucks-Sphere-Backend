const axios = require('axios');

const REQUEST_TIMEOUT_MS = 20_000;
const MIN_REQUEST_INTERVAL_MS = 400;
const ODOO_CUSTOM_FIELDS = [
  {
    name: 'x_trucksphere_measurement_type',
    field_description: 'TruckSphere Measurement Type',
    ttype: 'char',
  },
  {
    name: 'x_trucksphere_properties',
    field_description: 'TruckSphere Material Properties',
    ttype: 'text',
  },
  {
    name: 'x_trucksphere_standard_weight',
    field_description: 'TruckSphere Standard Weight',
    ttype: 'float',
  },
  {
    name: 'x_trucksphere_diameter_options',
    field_description: 'TruckSphere Diameter Options',
    ttype: 'text',
  },
];

let schemaPromise;
let nextOdooRequestAt = 0;

function integrationError(message, statusCode = 502) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = 'ODOO_MATERIAL_SYNC_FAILED';
  return error;
}

function getConfig() {
  const baseUrl = String(process.env.ODOO_BASE_URL || '').trim().replace(/\/+$/, '');
  const apiKey = String(process.env.ODOO_API_KEY || '').trim();
  const database = String(process.env.ODOO_DATABASE || '').trim();
  if (!baseUrl || !apiKey) {
    throw integrationError('Odoo material integration is not configured.', 503);
  }

  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    throw integrationError('Odoo material integration has an invalid URL.', 503);
  }
  if (url.protocol !== 'https:') {
    throw integrationError('Odoo material integration must use HTTPS.', 503);
  }
  return { baseUrl: url.toString().replace(/\/$/, ''), apiKey, database };
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForOdooRequestSlot() {
  const now = Date.now();
  const scheduledAt = Math.max(now, nextOdooRequestAt);
  nextOdooRequestAt = scheduledAt + MIN_REQUEST_INTERVAL_MS;
  if (scheduledAt > now) await delay(scheduledAt - now);
}

function extractId(value) {
  if (Number.isInteger(value)) return value;
  if (Array.isArray(value)) return extractId(value[0]);
  if (value && typeof value === 'object' && Number.isInteger(value.id)) return value.id;
  return null;
}

function many2oneId(value) {
  if (Number.isInteger(value)) return value;
  if (Array.isArray(value) && Number.isInteger(value[0])) return value[0];
  return null;
}

function responseMessage(response) {
  const message = String(response?.data?.message || '').replace(/[\r\n]+/g, ' ').slice(0, 280);
  return message || `HTTP ${response?.status || 'network error'}`;
}

async function callOdoo(model, method, body) {
  const config = getConfig();
  const headers = {
    Authorization: `Bearer ${config.apiKey}`,
    'Content-Type': 'application/json; charset=utf-8',
    'User-Agent': 'TruckSphere Material Integration/1.0',
  };
  if (config.database) headers['X-Odoo-Database'] = config.database;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    let response;
    try {
      await waitForOdooRequestSlot();
      response = await axios.post(`${config.baseUrl}/json/2/${model}/${method}`, body, {
        headers,
        timeout: REQUEST_TIMEOUT_MS,
        validateStatus: () => true,
      });
    } catch (error) {
      const cause = error.code === 'ECONNABORTED' ? 'request timed out' : 'network request failed';
      console.error(`[Odoo] ${model}.${method} ${cause}`);
      throw integrationError('Unable to synchronize materials with Odoo.');
    }

    if (response.status === 429 && attempt < 2) {
      const retryAfter = Number(response.headers?.['retry-after']);
      await delay(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : (attempt + 1) * 1500);
      continue;
    }
    if (response.status < 200 || response.status >= 300) {
      console.error(`[Odoo] ${model}.${method} failed (${response.status}): ${responseMessage(response)}`);
      throw integrationError('Unable to synchronize materials with Odoo.');
    }
    return response.data;
  }

  throw integrationError('Unable to synchronize materials with Odoo.');
}

async function findFirst(model, domain, fields) {
  const records = await callOdoo(model, 'search_read', { domain, fields, limit: 1 });
  return Array.isArray(records) && records.length ? records[0] : null;
}

async function createOne(model, values) {
  const id = extractId(await callOdoo(model, 'create', { vals_list: values }));
  if (!id) throw integrationError(`Odoo did not return an ID after creating ${model}.`);
  return id;
}

async function writeOne(model, id, values) {
  const result = await callOdoo(model, 'write', { ids: [id], vals: values });
  if (result !== true) throw integrationError(`Odoo did not confirm the ${model} update.`);
}

async function ensureOdooMaterialSchema() {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      const productTemplateModel = await findFirst('ir.model', [['model', '=', 'product.template']], ['id']);
      if (!productTemplateModel?.id) {
        throw integrationError('Odoo Product model metadata is unavailable.');
      }

      for (const field of ODOO_CUSTOM_FIELDS) {
        const existing = await findFirst('ir.model.fields', [
          ['model_id', '=', productTemplateModel.id],
          ['name', '=', field.name],
        ], ['id']);
        if (!existing?.id) {
          await createOne('ir.model.fields', {
            model_id: productTemplateModel.id,
            name: field.name,
            field_description: field.field_description,
            ttype: field.ttype,
            state: 'manual',
          });
        }
      }
    })().catch((error) => {
      schemaPromise = undefined;
      throw error;
    });
  }
  return schemaPromise;
}

function unitCandidates(unit) {
  const normalized = String(unit || '').trim().toLowerCase();
  const aliases = {
    tonnes: ['Ton(s)', 'Tonne', 'Tons', 'Ton'],
    tonne: ['Ton(s)', 'Tonne', 'Tons', 'Ton'],
    tons: ['Ton(s)', 'Tons', 'Ton', 'Tonne'],
    ton: ['Ton(s)', 'Tons', 'Ton', 'Tonne'],
    kilograms: ['kg', 'Kilogram'],
    kilogram: ['kg', 'Kilogram'],
    kgs: ['kg', 'Kilogram'],
    kg: ['kg', 'Kilogram'],
    litres: ['Litre(s)', 'Litres', 'Litre', 'Liters', 'Liter'],
    litre: ['Litre(s)', 'Litres', 'Litre', 'Liters', 'Liter'],
    liters: ['Litre(s)', 'Liters', 'Liter', 'Litres', 'Litre'],
    liter: ['Litre(s)', 'Liters', 'Liter', 'Litres', 'Litre'],
    metres: ['m', 'Meter'],
    metre: ['m', 'Meter'],
    meters: ['m', 'Meter'],
    meter: ['m', 'Meter'],
    millimetres: ['mm', 'Millimeter'],
    millimeters: ['mm', 'Millimeter'],
    'cubic metres': ['m³', 'Cubic Meters', 'Cubic Metres'],
    'cubic meters': ['m³', 'Cubic Meters', 'Cubic Metres'],
    pieces: ['Units', 'Unit(s)', 'Piece'],
    piece: ['Units', 'Unit(s)', 'Piece'],
    bags: ['Units', 'Unit(s)', 'Bag'],
    bag: ['Units', 'Unit(s)', 'Bag'],
    units: ['Units', 'Unit(s)'],
    unit: ['Units', 'Unit(s)'],
  };
  return [...new Set([String(unit || '').trim(), ...(aliases[normalized] || []), 'Units', 'Unit(s)'].filter(Boolean))];
}

async function findUnitOfMeasure(unit) {
  for (const name of unitCandidates(unit)) {
    const record = await findFirst('uom.uom', [['name', '=ilike', name]], ['id']);
    if (record?.id) return record.id;
  }
  throw integrationError('No compatible Odoo unit of measure was found for this material.');
}

async function findOrCreateCategory(category) {
  const name = `TruckSphere Materials - ${String(category || 'Other').trim() || 'Other'}`;
  const existing = await findFirst('product.category', [['name', '=', name]], ['id']);
  return existing?.id || createOne('product.category', { name });
}

function numberOrUndefined(value) {
  if (value === '' || value === null || value === undefined) return undefined;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

function textOrUndefined(value) {
  const text = String(value || '').trim();
  return text || undefined;
}

function setIfDefined(target, key, value) {
  if (value !== undefined) target[key] = value;
}

function buildProductValues(material, { uomId, categoryId, creating }) {
  const values = {
    name: String(material.name || material.id).trim(),
    default_code: String(material.odooInternalReference || material.id || material.materialId).trim(),
    categ_id: categoryId,
    uom_id: uomId,
    active: String(material.status || 'active').toLowerCase() !== 'inactive',
    purchase_ok: true,
    x_trucksphere_measurement_type: textOrUndefined(material.measurementType),
  };
  if (creating) {
    values.sale_ok = false;
    values.type = textOrUndefined(material.productType) || 'consu';
  }

  setIfDefined(values, 'description_purchase', textOrUndefined(material.description));
  setIfDefined(values, 'standard_price', numberOrUndefined(material.unitPrice));
  setIfDefined(values, 'list_price', numberOrUndefined(material.salesPrice));
  setIfDefined(values, 'barcode', textOrUndefined(material.barcode));
  setIfDefined(values, 'weight', numberOrUndefined(material.weight));
  setIfDefined(values, 'volume', numberOrUndefined(material.volume));
  if (Array.isArray(material.properties)) values.x_trucksphere_properties = JSON.stringify(material.properties);
  setIfDefined(values, 'x_trucksphere_standard_weight', numberOrUndefined(material.standardWeight));
  if (Array.isArray(material.diameterOptions)) values.x_trucksphere_diameter_options = JSON.stringify(material.diameterOptions);
  return values;
}

async function findMatchingTemplate(material) {
  const code = String(material.id || material.materialId || '').trim();
  const byCode = await findFirst('product.template', [['default_code', '=', code]], ['id']);
  if (byCode?.id) return byCode;

  // Backward-compatible lookup for records created by the original PO sync.
  const legacyCode = `TruckSphere:material:${code}`;
  const legacy = await findFirst('product.template', [['default_code', '=', legacyCode]], ['id']);
  if (legacy?.id) return legacy;

  const candidates = await callOdoo('product.template', 'search_read', {
    domain: [['name', '=ilike', String(material.name || '').trim()]],
    fields: ['id', 'name'],
    limit: 2,
  });
  return Array.isArray(candidates) && candidates.length === 1 ? candidates[0] : null;
}

function parseJsonArray(value) {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function productFieldsToMaterial(product, variantId) {
  const updates = {
    odooProductTemplateId: product.id,
    odooProductVariantId: variantId || null,
    odooProductCategoryId: many2oneId(product.categ_id),
    odooUomId: many2oneId(product.uom_id),
    odooSyncedAt: new Date().toISOString(),
  };
  const internalReference = textOrUndefined(product.default_code);
  const barcode = textOrUndefined(product.barcode);
  const unitPrice = numberOrUndefined(product.standard_price);
  const salesPrice = numberOrUndefined(product.list_price);
  const weight = numberOrUndefined(product.weight);
  const volume = numberOrUndefined(product.volume);
  const productType = textOrUndefined(product.type);
  const properties = parseJsonArray(product.x_trucksphere_properties);
  const diameterOptions = parseJsonArray(product.x_trucksphere_diameter_options);
  setIfDefined(updates, 'barcode', barcode);
  setIfDefined(updates, 'unitPrice', unitPrice);
  setIfDefined(updates, 'salesPrice', salesPrice);
  setIfDefined(updates, 'weight', weight);
  setIfDefined(updates, 'volume', volume);
  setIfDefined(updates, 'productType', productType);
  setIfDefined(updates, 'odooInternalReference', internalReference);
  setIfDefined(updates, 'properties', properties);
  setIfDefined(updates, 'diameterOptions', diameterOptions);
  setIfDefined(updates, 'standardWeight', numberOrUndefined(product.x_trucksphere_standard_weight));
  return updates;
}

function categoryFromOdoo(value) {
  const name = Array.isArray(value) ? String(value[1] || '') : '';
  const suffix = name.replace(/^TruckSphere Materials\s*-\s*/i, '').trim();
  return ['Aggregates', 'Steel', 'Cement', 'Liquid', 'Blocks'].includes(suffix) ? suffix : 'Other';
}

function unitFromOdoo(value) {
  const name = (Array.isArray(value) ? String(value[1] || '') : '').toLowerCase();
  if (/(ton|tonne)/.test(name)) return 'Tonnes';
  if (/(kilogram|\bkg\b)/.test(name)) return 'Kilograms';
  if (/(litre|liter|\bl\b)/.test(name)) return 'Litres';
  if (/(cubic|m³|m3)/.test(name)) return 'Cubic Metres';
  if (/(millimet|\bmm\b)/.test(name)) return 'Millimetres';
  if (/(metre|meter|\bm\b)/.test(name)) return 'Metres';
  if (/bag/.test(name)) return 'Bags';
  return 'Pieces';
}

function odooProductToMaterial(product, variantId) {
  const unit = unitFromOdoo(product.uom_id);
  return {
    ...productFieldsToMaterial(product, variantId),
    name: textOrUndefined(product.name),
    description: textOrUndefined(product.description_purchase),
    category: categoryFromOdoo(product.categ_id),
    measurementType: unit,
    defaultUnit: unit,
    status: product.active === false ? 'inactive' : 'active',
  };
}

async function fetchOdooPurchaseProducts() {
  await ensureOdooMaterialSchema();
  return callOdoo('product.template', 'search_read', {
    domain: [['purchase_ok', '=', true]],
    fields: [
      'id', 'name', 'default_code', 'description_purchase', 'active', 'barcode', 'standard_price', 'list_price',
      'weight', 'volume', 'type', 'categ_id', 'uom_id', 'x_trucksphere_properties',
      'x_trucksphere_standard_weight', 'x_trucksphere_diameter_options',
    ],
    limit: 500,
  });
}

async function syncMaterial(material) {
  if (!material?.id || !material?.name) {
    throw integrationError('A material ID and name are required for Odoo synchronization.', 400);
  }

  await ensureOdooMaterialSchema();
  const [uomId, categoryId] = await Promise.all([
    findUnitOfMeasure(material.defaultUnit || material.measurementType),
    findOrCreateCategory(material.category),
  ]);
  const existing = await findMatchingTemplate(material);
  const values = buildProductValues(material, { uomId, categoryId, creating: !existing?.id });
  const templateId = existing?.id || await createOne('product.template', values);
  if (existing?.id) await writeOne('product.template', templateId, values);

  const [records, variant] = await Promise.all([
    callOdoo('product.template', 'read', {
      ids: [templateId],
      fields: [
        'id', 'default_code', 'barcode', 'standard_price', 'list_price', 'weight', 'volume', 'type', 'categ_id', 'uom_id',
        'x_trucksphere_properties', 'x_trucksphere_standard_weight', 'x_trucksphere_diameter_options',
      ],
    }),
    findFirst('product.product', [['product_tmpl_id', '=', templateId]], ['id']),
  ]);
  const product = Array.isArray(records) ? records[0] : null;
  if (!product?.id) throw integrationError('Odoo did not return the synchronized material product.');
  return productFieldsToMaterial(product, variant?.id);
}

module.exports = {
  syncMaterial,
  fetchOdooPurchaseProducts,
  odooProductToMaterial,
  ensureOdooMaterialSchema,
  __testables: { buildProductValues, productFieldsToMaterial, odooProductToMaterial, unitCandidates },
};
