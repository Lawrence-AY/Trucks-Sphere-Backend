# Vendor matching - changes (branch feat/vendor-matching)

## Files included
- NEW  src/utils/vendorMatching.js       (normalisation + fuzzy matching)
- NEW  test/vendorMatching.test.js       (10 passing tests)
- MOD  src/integrations/access-bridge/processor.js  (match-before-create; VENDOR_REVIEW_REQUIRED)
- MOD  src/integrations/access-bridge/config.js     (vendorMatching thresholds)
- MOD  src/modules/vendors/service.js    (addAlias / listAliases / removeAlias)
- MOD  src/modules/vendors/controller.js (alias endpoints)
- MOD  src/modules/vendors/routes.js     (alias routes)

## How to apply
Drop the files into the same paths in the backend repo, then deploy.

## Firestore (new, lazy-created)
Collection: vendorAliases
Fields: id (sha256 of normalised alias), vendorId, alias, aliasNormalized, createdAt

## Environment variables (see .env.example)
Optional thresholds:
- TARTIM_VENDOR_AUTO_THRESHOLD (default 0.90)
- TARTIM_VENDOR_REVIEW_THRESHOLD (default 0.72)
- TARTIM_VENDOR_AMBIGUITY_MARGIN (default 0.05)

## Tests
node --test test/vendorMatching.test.js
