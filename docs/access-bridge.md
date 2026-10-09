# Firebase Access bridge

The listener uploads WinScale rows to `POST /api/access-bridge/captures`. The backend authenticates `TARTIM_API_KEY` and `TARTIM_SOURCE_ID`, stores changed rows, then resolves them asynchronously. No listener changes are required.

## Configuration

Set `TARTIM_ENABLED=true`, `TARTIM_SOURCE_ID=Tunaylar-WinScale`, a shared random `TARTIM_API_KEY` of at least 32 characters, and `TARTIM_UTC_OFFSET=+03:00`. `TARTIM_WEIGHING_MODE=loading` is the default and implements the empty-first, loaded-second contract. Input and ticket weights are kilograms. `TARTIM_SOURCE_WEIGHT_UNIT` does not override this loading contract.

`TARTIM_WEIGHING_MODE=unloading` retains the existing scheduled site-delivery/warehouse workflow (loaded first, empty second, application weights in tonnes). Use that only for a source actually measuring unloading; it does not use the new loading-ticket resolver.

The backend uses its existing Firebase service-account environment. The requested production project is `trucksphere`; verify the Render service account and `FIREBASE_PROJECT_ID` together before deployment. This workspace currently specifies `trucksphere-demo`. Changing only a project name is not a credential migration. No environment secrets are included in logs or browser exports.

## Mapping and resolution

- `PLAKA`: normalized truck registration. Match `vehicles`; otherwise create a stable `AB-{plate}` record and reserve `vehicleRegistrations/{plate}` atomically.
- `FIRMA_ADI`: vendor/company; match names or create an explicitly bridge-created vendor.
- `DIGER3_ISIM`: driver name (configurable with `TARTIM_DRIVER_FIELD`). Match case-insensitively, including existing IDs/licences/national IDs. Duplicate names prefer the captured vendor, then the lexically smallest ID. Unknown names create stable driver records marked `registrationIncomplete`; no licence or national ID is fabricated. A missing name remains `DRIVER_NAME_REQUIRED`.
- `DIGER1_ISIM`: loading point, e.g. HINDI. `DIGER2_ISIM`: destination/site, e.g. MANDA BAY.
- `DIGER4_ISIM`: delivery note/description. `MALZEME_ADI` / `MALZEME_KODU`: material name/code. `OPERATOR_ADI`: operator.
- `DIGER5_ISIM` (or `TARTIM_PO_FIELD`): optional existing PO reference. Without a reference, match an existing open PO by vendor, site and material. Associate only one unambiguous match. Missing, closed or ambiguous POs leave `purchaseOrderId: null` and `poResolution: unmatched|ambiguous`. **The bridge never creates a PO or custom site order.** The capture is still saved and processed.

Unknown material/site names also create bridge-marked registry records so the ticket can retain stable relationships. Blank vendor/material/site values use explicit Unspecified labels rather than guessing a real entity.

## Loading ticket lifecycle and schema

`accessBridgeTickets/{sha256(source, normalized plate, first timestamp)}` stores:

- `status`: `in_yard` for ICERIDEKI_ARACLAR, `completed` for KAYITLAR.
- `truckId`, `driverId`, `vendorId`, `materialId`, `siteId`, nullable `purchaseOrderId`, and `poResolution`.
- `plateNumber`, `plateDate` (normalized plate plus local first-weigh date), `sourceId`.
- `tareKg`, nullable `grossKg` and `netKg`, `weightUnit: kg`.
- `firstAt`, `secondAt`, `ticketNumber`, mapped descriptive fields, `contentHash`, creation/update timestamps.

A completed row updates the same yard ticket using its first-weigh identity. If its first time was corrected, one open yard ticket for the same plate and local date can match. Multiple candidates remain `AMBIGUOUS_YARD_CAPTURE`; separate trips are never merged arbitrarily. `NET` must equal loaded minus empty weight (0.001 kg tolerance); if absent it is calculated. Completed captures arriving before yard rows are supported; late yard rows cannot downgrade a completed ticket.

Combine each TARIH date and SAAT clock time using the configured offset. The Access zero-date is stripped from the clock and is rejected as a real date. Invalid calendar dates, reverse chronology, conflicting saved weights and inconsistent NET remain visible validation failures.

These are weighbridge tickets, not delivery-order receipts: loading completion does not assert that goods have arrived, update site inventory, or generate an RN. Existing delivery orders and the legacy unloading workflow remain separate. The event result carries `ticketId`; authorized management users can read `/api/access-bridge/tickets/:id`. Existing `/api/access-bridge` history exposes raw payloads and resolution outcomes.

`accessBridgeTicketNumbers/{sha256(source, KAYIT_NO)}` maps a completed ticket number to its ticket document. Registry creation, registration reservation, ticket write and number mapping commit atomically. Stable IDs and payload hashes make retries safe across restarts. The original observations remain in `accessBridgeSources/{source}/snapshots` and `/events`.

## Logging and Firebase usage

Non-empty authenticated uploads log `[Access bridge] payload:` with `JSON.stringify(req.body)`, then `[Access bridge] record:` for every raw listener record. Worker attempts log `[Access bridge] processing record:` (including persisted raw data); `[Access bridge] resolution:` includes source, event, plate, truck/driver/PO IDs, PO resolution and ticket status. Failures log the event ID and reason. Raw logs contain business and driver information; apply your existing Render log retention/access controls.

Empty uploads return immediately with zero Firestore reads/writes and no payload log spam. Changed rows use one ingestion transaction and `getAll` bulk reads. Repeated identical rows in a batch coalesce; conflicting copies reject the batch. KAYITLAR dedupes by normalized KAYIT_NO; yard rows by normalized plate/date/clock. Unchanged uploads cause no writes. The first non-empty upload initializes source state; empty heartbeats do not update persisted `lastSuccess`.

The worker queries pending events independently of requests. It does not acquire/write a lease when idle. Active leases renew at most every 30 seconds within a batch. Registry collections are read once per worker batch (up to 100 events), and new entities are shared within that batch. These are full collection reads, not a claim of constant Firestore document cost. Exact ticket retries perform no ticket/registry writes, although event acknowledgements are written.

## Deployment and migration

Deploy the `accessBridgeTickets` composite index in `firestore.indexes.json` to the intended project before enabling the loading worker, then deploy/restart the Render backend with the configuration above. The Firestore schema additions are additive; no existing jobs, POs or snapshots are deleted or rewritten. Loading mode processes new completed BASELINE events rather than ignoring them.

Existing blocked events retry automatically within 30 seconds after deployment. Already ignored/processed historical events do not automatically requeue; unchanged listener replays remain deduped. If historical reprocessing is needed, deliberately reset only the selected event status/nextAttemptAt after reviewing its source and date. Old yard snapshot keys may produce one extra event on replay after normalization; ticket identity still prevents duplicate tickets.

Tests run against isolated fake Firestore stores; they do not write to Firebase or deploy to Render. Use `npm test` for the backend suite.
