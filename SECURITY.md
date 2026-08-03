# TruckSphere security policy

## Reporting a vulnerability

Report suspected vulnerabilities privately to `security@trucksphere.app`. Include a clear reproduction path, affected endpoint or build, and any proof of impact. Do not include credentials, access tokens, personal data, or production exports in the report.

The runtime exposes the same contact at `/.well-known/security.txt`. Set `SECURITY_CONTACT` and `SECURITY_POLICY_URL` in production if the public policy is hosted elsewhere.

## Deployment requirements

Before a production rollout, provision `ENCRYPTION_SECRET` and `ENCRYPTION_SALT` using the deployment platform's secret manager. They are mandatory in production and must be unique per environment. Set `FIREBASE_API_KEY` as an environment variable as well; there are no source-code fallbacks.

Direct Firestore client access is denied in `firestore.rules`; deploy it with `firebase deploy --only firestore:rules --project <project-id>`. The backend uses the Admin SDK and continues to access Firestore normally.

## Implemented controls

- HTTPS redirects and HSTS in production.
- CSP without `unsafe-inline`, explicit CORS origins, Helmet headers, request size limits, rate limits, and command-input filtering.
- Passwords require 12+ characters with upper/lowercase letters, a number, and a special character.
- Password-reset OOB-code issuance and verification are separately rate limited.
- Refresh tokens are server-side, opaque, hashed at rest, encrypted where they wrap the Firebase token, and rotated on every refresh. Reuse invalidates the token family and revokes Firebase refresh tokens.
- Uploads require an allowed MIME type and matching file signature.
- Request and audit logs redact passwords, tokens, secrets, API keys, cookies, authorization data, and reset codes.

## Recurring verification

Run `npm audit --omit=dev` for both applications during every release. Check the deployed HTTPS API with [SecurityHeaders.com](https://securityheaders.com/) after each production header or proxy change, and keep the resulting grade/link in the release record.

Use the Firebase Local Emulator Suite or the Firebase Rules Playground to confirm that unauthenticated and authenticated client SDK reads/writes are denied for every collection before deploying rule changes.
