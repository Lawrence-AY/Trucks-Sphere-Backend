# Compact PO and material numbering

Preview:

```powershell
node scripts/renumber-pos-materials.js --project trucksphere
```

Apply the reviewed mapping:

```powershell
node scripts/renumber-pos-materials.js --apply --project trucksphere
```

The script sorts current POs and materials by their original numeric IDs and assigns consecutive IDs from one. PO vendor suffixes are preserved. It updates document IDs, material numbers, operational references, stock IDs/movement references, per-PO trip counters, and merge-history destinations in one transaction, with a 450-write limit. Existing trip document IDs, issued job IDs, receipt IDs, weights, ordered quantities and inventory balances remain unchanged. Material spelling aliases remain; conflicting retired material-ID aliases are removed because those numeric IDs now identify current materials.

Global material and PO counters reset to the current record counts. Other counters remain intact. A `numberingRevision` marker on `counters/auto_ids` tells the repair helpers to use the current numbering series rather than historic source IDs and embedded trip prefixes. Per-PO J counters remain above issued suffixes and linked-trip counts. The original-to-current mapping is saved in `numberingMigrations`, and all before-images are saved under the gitignored `.po-repair-backups/compact-*` directory before any database write. Existing historical trip and receipt strings may contain older PO prefixes; their current `purchaseOrderId` and `poNumber` identify the renumbered order. Rerunning a completed migration is a no-op.

This operation deliberately reuses numeric values retired by the earlier merge cleanup. Use current record IDs for new operations, and retain the backup/mapping when reading historical documents. After compaction, the old high counters from the merge audit no longer determine the next IDs.
