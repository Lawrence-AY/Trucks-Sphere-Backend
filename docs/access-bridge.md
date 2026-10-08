# Firebase Access bridge

The Access listener reads Access/WinScale and sends changed captures to the main TruckSphere API. Firebase Firestore stores observations, retry status, source snapshots and job links. There is no SQLite runtime or separate backend/dashboard.

## Configuration

Merge `docs/access-bridge.env.example` into the main backend `.env`, set the bridge key and Access column mappings, then enable `TARTIM_ENABLED=true`. Site IDs are resolved from the matched TruckSphere delivery or purchase order. Configure `TARTIM_SOURCE_WEIGHT_UNIT=kg` or `tonnes` when the Access scale unit is known. Otherwise the matched site must supply `weighbridgeWeightUnit`. Product units are never used as scale units. The existing backend Firebase configuration is used.

Set the listener's `TARTIM_API_URL` to `https://YOUR-API/api/access-bridge/captures` (localhost HTTP is allowed for development), and set the same `TARTIM_API_KEY` and `TARTIM_SOURCE_ID` in both applications. Use a random key of at least 32 characters. The listener has no Firebase service-account credentials. Run the main backend with `npm.cmd start`, then run `npm.cmd start` in `ToUse/access-listener` on the Access workstation. Node 24+ is required for the listener.

Vehicle registration is the primary link to an existing Site Schedule job. Plates are normalized for case, spaces and hyphens. Legacy jobs without a stored plate can resolve their vehicle ID through the fleet registry. Supplied driver, company, origin, destination and material confirm the scheduled context; they never overwrite conflicting job relationships. The captured fields and timestamps are retained in the job's accessCapture metadata.

DIGER3_ISIM identifies the driver by name or registered ID/national ID/licence. DIGER5_ISIM can identify the exact trip/job, PO number or document ID; configure TARTIM_DRIVER_FIELD and TARTIM_PO_FIELD for other columns. When a plate has multiple active schedules, matching context must identify exactly one. Ambiguity or conflicting context blocks processing. The truck must exist in the fleet registry for both site and warehouse captures (`UNKNOWN_TRUCK` otherwise).

Without a matching schedule, a registered truck and driver can create a custom job against one open purchase order. Supply its ID/PO number in DIGER5_ISIM, or identify it uniquely using destination (DIGER2_ISIM), material (MALZEME_KODU/MALZEME_ADI) and optional vendor (FIRMA_ADI). The order supplies site, material, vendor, unit, storage lot and banker. Missing or ambiguous references remain blocked; the bridge does not invent orders, drivers or trucks. A truck or driver already assigned to an active job cannot create another job. Warehouse captures require an existing shipment so product quantities and shipment references are preserved.

Access form time may precede job creation by at most two minutes, provided the job existed before the server observed the upload. Older captures cannot attach to future schedules. Existing jobs can retain an empty site ID when the source scale unit is explicitly configured.

## Workflow

- Find the existing site schedule by registration and confirm job context, or create a custom job with `isUnscheduled=true` using the shared delivery service. The existing purchase-order number and shared per-PO job counter produce the job reference. Save the capture binding on creation so retries and the second weighing reuse the same document. Verify the registered truck and captured plate again at weigh-out.
- Persist first weight through the shared delivery service. That write sets SITE_WEIGHED_IN and the site-arrival markers together. The app removes the job from Site Schedule and displays its saved first weight in Weights to Be Weighed Out through existing live sync. A failed weighing write leaves the job at its prior stage.
- Convert `TARTIM1` to site weigh-in and `TARTIM2` to site weigh-out using the explicitly configured Access source unit, or the matched site's weighbridge unit, storing weights in tonnes. Captures are blocked if neither the explicit source unit nor the site unit is set. Existing scheduled jobs with no site ID can be weighed using the explicit source unit; no site is guessed or created. Timestamps use `TARTIM_UTC_OFFSET`, default `+03:00` for Nairobi. Second weight must be positive and below first weight.
- Use the existing site-arrival, inventory and receipt-number services. Receipts are available in the app's existing receipt/history views. Automatic paper printing is not included.
- Final weigh-out sets `SITE_WEIGHED_OUT`, generates the RN using the shared receipt counter, and moves the job into Site History. Delivery snapshot notifications refresh web subscribers; five-second polling also refreshes mobile and disconnected web streams without manual refresh. Warehouse inspection remains a separate step after weighing.
- Warehouse deliveries retain their product units and quantities and proceed to inspection after weigh-out. Security flags and warehouse validation remain enforced.
- Link waiting and completed Access records by source, normalized plate and first-weigh timestamp. Retries and restarts reuse the job. Conflicting app-entered weights are held rather than overwritten. Completed app entries may match if their weigh-in timestamp is within two minutes of the capture.

## Firebase and recovery

`accessBridgeSources/{sourceId}` holds source health and the worker lease, with `snapshots` and `events` subcollections. Events are pending, processed, ignored or blocked. Blocked events retry after 30 seconds. The first upload of historical completed records is a baseline and does not create jobs; waiting vehicles are processed immediately. Reuse the source ID across restarts, but use a new one for a different Access database.

The listener sends only changed rows after an acknowledged upload and sends a heartbeat after every successful scan. On restart it resends the source records; Firestore deduplicates them transactionally. During network outages it retries by rereading Access. Keep Access records until upload succeeds: without a local durable queue, records deleted from Access before a successful upload cannot be recovered.

Management users can GET `/api/access-bridge` with their normal login token to inspect the latest 100 events and source health. Listener credentials authorize only POST `/api/access-bridge/captures` for the configured source. Credentials and source routing are never taken from capture payloads.

If Access entries do not appear in TruckSphere, check the listener for `Scan OK` and the bridge's `lastSuccess`. The startup banner alone does not confirm an upload. Each upload batch is committed in one Firestore transaction to avoid per-row transaction latency exhausting the listener's 30-second request timeout. A first scan or restart still needs to upload all source rows before reporting success.

Uploaded captures are not necessarily jobs: historical completed baseline records are ignored, and other captures require a matching schedule or the confirmed custom-job context described above. Inspect each event's `status` and `reason` before re-entering data. This bridge only reads Access; it does not copy TruckSphere entries back into Access.

Automated tests use fake repositories and do not connect to live Firebase or Access hardware. Validate the actual driver-field mapping, weight units, scheduled/unmatched/warehouse deliveries and operator workflow before enabling production captures.
