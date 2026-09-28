# Firestore Schema — TruckSphere

> **Indexing strategy**: All service-level GET requests now flow through `snapshotStore` (in-memory `onSnapshot` cache). Sorting, filtering, and searching happen in memory — **zero composite index requirements for the hot API path**. The indexes below support the auth flow and optional direct Firestore queries from controllers.

---

## Collection: `users`

| Field | Type | Description |
|-------|------|-------------|
| `email` | `string` | Login email |
| `role` | `string` | One of: `admin`, `vendor`, `quarry_operator`, `site_operator` |
| `vendorId` | `string` | FK → `vendors.id` (only if `role=vendor`) |
| `quarryId` | `string` | FK → `quarries.id` (only if `role=quarry_operator`) |
| `siteId` | `string` | FK → `sites.id` (only if `role=site_operator`) |
| `displayName` | `string` | Full name |
| `createdAt` | `timestamp` | |
| `updatedAt` | `timestamp` | |

**Indexes**: `email ASC` (auto) | `email ASC + role ASC` | `role ASC + email ASC`

**Reads per request**: 1 (auth email lookup, limit 1)

---

## Collection: `vendors`

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | `V001`, `V002`, ... |
| `name` | `string` | Company name |
| `email` | `string` | Contact email |
| `phone` | `string` | |
| `address` | `string` | |
| `status` | `string` | `active`, `inactive`, `suspended` |
| `fleetSize` | `number` | |
| `createdAt` | `timestamp` | |
| `updatedAt` | `timestamp` | |

**Indexes**: `email ASC` (single-field)

**Reads per request**: 0 (snapshotStore)

---

## Collection: `drivers`

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | `DRV001`, ... |
| `name` | `string` | |
| `phone` | `string` | |
| `licenseNumber` | `string` | |
| `status` | `string` | `active`, `inactive` |
| `totalTrips` | `number` | |
| `rating` | `number` | 0-5 |
| `photoURL` | `string` | Firebase Storage URL |
| `createdAt` | `timestamp` | |
| `updatedAt` | `timestamp` | |

**Reads per request**: 0 (snapshotStore)

---

## Collection: `vehicles`

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | `TRK001`, ... |
| `plateNumber` | `string` | |
| `make` | `string` | |
| `model` | `string` | |
| `status` | `string` | `active`, `inactive`, `maintenance` |
| `capacity` | `number` | Tonnes |
| `vendorId` | `string` | FK |
| `createdAt` | `timestamp` | |
| `updatedAt` | `timestamp` | |

**Reads per request**: 0 (snapshotStore)

---

## Collection: `materials`

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | |
| `name` | `string` | e.g. "Aggregate 20mm" |
| `description` | `string` | |
| `category` | `string` | |
| `unit` | `string` | `tonnes`, `cubic_meters` |
| `active` | `boolean` | |
| `createdAt` | `timestamp` | |
| `updatedAt` | `timestamp` | |

**Reads per request**: 0 (snapshotStore)

---

## Collection: `purchaseOrders`

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | `PO001`, ... |
| `poNumber` | `string` | |
| `vendorId` | `string` | FK |
| `vendorName` | `string` | Denormalized |
| `materialId` | `string` | FK |
| `materialName` | `string` | Denormalized |
| `quarryId` | `string` | FK |
| `quarryName` | `string` | Denormalized |
| `siteId` | `string` | FK |
| `siteName` | `string` | Denormalized |
| `quantityOrdered` | `number` | Tonnes |
| `quantityDelivered` | `number` | After QC |
| `pendingQualityControl` | `number` | Awaiting QC |
| `status` | `string` | `pending`, `partial`, `completed`, `cancelled` |
| `createdAt` | `timestamp` | |
| `updatedAt` | `timestamp` | |

**Reads per request**: 0 (snapshotStore)

---

## Collection: `deliveryOrders`

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | Sanitized jobId |
| `jobId` | `string` | e.g. `DN-POMAT001-D001-J001` |
| `purchaseOrderId` | `string` | FK |
| `poNumber` | `string` | Denormalized |
| `vendorId` | `string` | FK |
| `vendorName` | `string` | Denormalized |
| `driverId` | `string` | FK |
| `driverName` | `string` | Denormalized |
| `plateNumber` | `string` | |
| `materialName` | `string` | |
| `materialSource` | `string \| null` | Quarry/material source for unscheduled site intake |
| `quarryId` | `string` | Origin FK |
| `quarryName` | `string` | Denormalized |
| `siteId` | `string` | Destination FK |
| `siteName` | `string` | Denormalized |
| `quantity` | `number` | Order qty |
| `quantityDelivered` | `number` | Net weight |
| `weighInWeight` | `number` | |
| `weighOutWeight` | `number` | |
| `netWeight` | `number` | |
| `storageLot` | `string` | |
| `storageLotAssignedAt` | `timestamp` | |
| `status` | `string` | `assigned`, `at_quarry`, `in_transit`, `at_site`, `delivered`, `completed` |
| `driverPhotoURL` | `string` | |
| `createdAt` | `timestamp` | |
| `updatedAt` | `timestamp` | |

**Indexes**: `status ASC + createdAt DESC` | `vendorId ASC + createdAt DESC` | `purchaseOrderId ASC + createdAt DESC`

**Reads per request**: 0 (snapshotStore)

---

## Collection: `weighbridgeRecords`

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | |
| `jobId` | `string` | FK |
| `deliveryOrderId` | `string` | FK |
| `type` | `string` | `weigh_in`, `weigh_out` |
| `weight` | `number` | Tonnes |
| `location` | `string` | |
| `timestamp` | `timestamp` | |
| `operator` | `string` | |
| `createdAt` | `timestamp` | |
| `updatedAt` | `timestamp` | |

**Indexes**: `jobId ASC + timestamp DESC` | `deliveryOrderId ASC + timestamp DESC`

**Reads per request**: 0 (snapshotStore)

---

## Collection: `checkpoints`

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | |
| `deliveryOrderId` | `string` | FK |
| `jobId` | `string` | FK |
| `type` | `string` | `in_transit`, `at_checkpoint`, `arrived`, `departed` |
| `timestamp` | `timestamp` | |
| `location` | `string` | |
| `notes` | `string` | |
| `createdAt` | `timestamp` | |
| `updatedAt` | `timestamp` | |

**Indexes**: `jobId ASC + timestamp DESC` | `deliveryOrderId ASC + timestamp DESC`

**Reads per request**: 0 (snapshotStore)

---

## Collection: `quarries`

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | |
| `name` | `string` | |
| `email` | `string` | |
| `location` | `map` | `{ address, lat, lng }` |
| `status` | `string` | `active`, `inactive` |
| `createdAt` | `timestamp` | |
| `updatedAt` | `timestamp` | |

**Indexes**: `email ASC`

**Reads per request**: 0 (snapshotStore)

---

## Collection: `sites`

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | |
| `name` | `string` | |
| `email` | `string` | |
| `location` | `map` | `{ address, lat, lng }` |
| `status` | `string` | `active`, `inactive` |
| `createdAt` | `timestamp` | |
| `updatedAt` | `timestamp` | |

**Indexes**: `email ASC`

**Reads per request**: 0 (snapshotStore)

---

## Collection: `fuelRecords`

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | `F001`, ... |
| `vendorId` | `string` | FK |
| `vendorName` | `string` | Denormalized |
| `jobId` | `string` | FK |
| `driverName` | `string` | |
| `plateNumber` | `string` | |
| `litres` | `number` | |
| `cost` | `number` | |
| `dispensedBy` | `string` | |
| `dispensedByEmail` | `string` | |
| `createdAt` | `timestamp` | |
| `updatedAt` | `timestamp` | |

**Indexes**: `vendorId ASC + createdAt DESC` | `jobId ASC + createdAt DESC`

**Reads per request**: 0 (snapshotStore)

---

## Collection: `fuelAuthorizations`

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | |
| `vendorId` | `string` | FK |
| `driverName` | `string` | |
| `plateNumber` | `string` | |
| `litres` | `number` | |
| `otp` | `string` | One-time PIN |
| `status` | `string` | `pending`, `authorized`, `rejected`, `expired` |
| `createdAt` | `timestamp` | |
| `updatedAt` | `timestamp` | |

**Indexes**: `vendorId ASC + status ASC + createdAt DESC`

**Reads per request**: 1 (pending authorizations query)

---

## Collection: `uploads`

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | |
| `deliveryOrderId` | `string` | FK |
| `jobId` | `string` | FK |
| `type` | `string` | `driver_photo`, `waybill`, `delivery_note` |
| `url` | `string` | Firebase Storage URL |
| `createdAt` | `timestamp` | |
| `updatedAt` | `timestamp` | |

**Indexes**: `deliveryOrderId ASC + createdAt DESC` | `jobId ASC + createdAt DESC`

**Reads per request**: 0 (snapshotStore)

---

## Firestore Read Reduction Summary

| Operation | Before | After |
|-----------|--------|-------|
| GET /api/* (all collections) | 1 read per request per collection | **0** (snapshotStore) |
| onSnapshot listeners (12 collections) | 0 | 12 reads every ~5min (when data changes) |
| Auth login email lookup | 2-4 reads | 2-4 reads (unchanged) |
| **100 users browsing for 1 hour** | **~12,000+ reads** | **~12 reads** |

**Effective reduction: ~99.9%**

---

## Deploying Indexes

```bash
cd Trucks-Sphere-Backend
firebase deploy --only firestore:indexes --project truck2sphere-57b00
