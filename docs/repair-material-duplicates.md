# Merge typo materials

Preview compatible duplicate names:

```powershell
node scripts/repair-material-duplicates.js --project trucksphere
```

Apply the reviewed transaction:

```powershell
node scripts/repair-material-duplicates.js --apply --project trucksphere
```

The script defaults to a dry run and uses `.env` unless `--env-file` is supplied. It retains the lowest numbered canonical material, preserves spelling aliases and retired material IDs, updates PO/trip/ticket/warehouse references including nested material lines, and deletes the duplicate material documents. It retains redirects in `materialMerges` and before-images in the gitignored `.po-repair-backups` directory.

Stock document IDs depend on the delivery and material IDs. The repair computes replacement IDs using the actual stock model, preserves all inventory quantities, usage and valuations, and updates stock-movement references atomically. Unknown stock identities or collisions abort without writes. Distinct numeric sizes, warehouse designations, units or conflicting product codes are not automatically merged. Transactions are limited to 450 writes; oversized datasets need a scoped migration. Original raw Access payloads and audit records are retained unchanged.

After materials merge, POs that previously used distinct typo material IDs may become vendor/material duplicates. Reconcile these with:

```powershell
node scripts/repair-access-bridge-pos.js --apply --delete-merged --project trucksphere
```

Material creation and Access Bridge matching use canonical spellings, saved aliases and conservative fuzzy matching. Deploy the updated material service/matching helper for the creation checks to take effect on the running backend. Material and PO counters reserve previously issued numbers.
