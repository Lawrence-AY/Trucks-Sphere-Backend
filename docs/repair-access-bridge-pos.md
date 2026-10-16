# Repair trip-created duplicate purchase orders

Preview all eligible duplicates (no database writes):

```powershell
node scripts/repair-access-bridge-pos.js --env-file .env.env
```

Narrow the preview to a vendor and material:

```powershell
node scripts/repair-access-bridge-pos.js --env-file .env.env --vendor "HINDI GEN AGENCY" --material MURRAM
```

Pause the bridge worker and backend writes while applying. The script uses `FIREBASE_PROJECT_ID` from the selected environment file by default. You can optionally pass `--project` with the ID printed by the preview to check the target:

```powershell
node scripts/repair-access-bridge-pos.js --env-file .env.env --vendor "HINDI GEN AGENCY" --material MURRAM --apply --project YOUR_FIREBASE_PROJECT_ID
```

Omit the vendor/material filters to process all eligible groups. `--keep-po PO0001-V001` selects a specific open keeper when review is needed. Multiple legitimate manual orders, conflicting sites/quarries, warehouse orders, multi-material orders, cancelled sources and bridge orders with contractual quantities are retained or reported for review. Grouping uses the same vendor and material IDs (with legacy numeric formatting normalized); missing material IDs can match by material spelling. Distinct material registry records are not consolidated by this script.

Within each group, prefer a manual open PO, then the oldest eligible open PO. Move each bridge-created duplicate to the keeper in one transaction, and archive it with `mergedIntoPurchaseOrderId`. Each transaction transfers delivery-order, bridge-ticket, stock and stock-movement PO references, adds the source pending-quality-control balance to the keeper exactly once, recalculates the received delivery summary and advances the keeper trip counter. Ordered quantities, stock quantities, weights, issued job IDs, receipt IDs and capture identities are preserved. Historical job IDs may retain their original PO prefix; the current `purchaseOrderId` and `poNumber` point to the keeper. Original duplicate documents remain archived for audit and to reserve their issued numbers.

The trip counter is at least the largest existing J suffix, either original PO counter, and the number of linked jobs. Global `purchase_order_v2_counter` and legacy `purchase_order_counter` advance past the highest PO/WH number found in orders and trip/ticket references. Higher existing counters stay unchanged. Counters are last-issued values: if the repaired value is 70, the next PO is PO0071. Other entity and receipt counters are untouched. This intentionally does not renumber orders or close gaps left by issued duplicate numbers.

Before applying, the script writes a plan and document before-images plus patches to `.po-repair-backups/<run>/`. This directory is gitignored. A failed backup prevents writes. Firestore timestamps in JSON backups retain their serialized seconds/nanoseconds representation; backups are audit/restore source data, not an automatic rollback command. Each source merge is atomic and rechecks eligibility against current Firestore data. Rerunning skips archived merged sources and cannot transfer their balances twice. Earlier source merges remain committed if a later one fails. Each source merge is limited to 450 writes; oversized sources are reported for a dedicated migration. The script scans the listed collections to detect references and protect transactional consistency, so large datasets incur reads. Review the printed skipped list before resuming the worker.

The script uses the existing Firebase service-account configuration and does not deploy code. Run its isolated tests with:

```powershell
node --test test/repairBridgePurchaseOrders.test.js
```

## Check or repair only the global PO counters

```powershell
node scripts/repair-access-bridge-pos.js --counters-only
node scripts/repair-access-bridge-pos.js --counters-only --apply
```

Apply mode now repairs counters before merging orders and prints the actual saved values from `counters/auto_ids` plus the next PO number. The banner prints the configured project and database. A counter remaining at 1783 means the next PO is PO1784, even after duplicate POs are archived. Archiving does not erase their issued numbers. The per-PO `jobCounters/<retained PO ID>/nextJobNumber` is updated with each merge and is independent of the global PO counter. Do not run a second applying instance while another repair is still running.

## Delete incorrect POs after merging

```powershell
node scripts/repair-access-bridge-pos.js --apply --delete-merged
```

To delete only duplicates that are already fully merged:

```powershell
node scripts/repair-access-bridge-pos.js --cleanup-only --apply
```

Deletes are backed up and rechecked in a transaction. Deletion requires a verified bridge-repair marker, an existing retained PO, zero pending QC balance, no remaining PO references in deliveries/tickets/stocks/movements/warehouse jobs, and a transferred trip counter. The duplicate purchase order and its obsolete trip-counter document are removed. `purchaseOrderMerges/<old PO ID>` retains a small redirect and issued-number history; counter repair includes this history, so deleted numbers cannot be reused. New runs use atomic batches under the Firestore write limit to avoid rescanning collections for every duplicate.
