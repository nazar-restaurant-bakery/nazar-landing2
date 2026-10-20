# Private sandbox recovery validation

This is a local integrity checker. It never connects to PostgreSQL, Supabase, Auth,
a provider, or the network, and never changes recovery inputs.

## Private package contract

Keep these files in the authorized private local recovery directory, outside Git:

- schema.sql: successful schema-only application export, including table definitions,
  indexes, functions, grants, policies and triggers required by the application.
- catering-orders.json: the original exact UTF-8 JSON array of all four sandbox
  test orders, with every column and nested value preserved. Do not parse and
  reserialize this file to generate the recovery copy; retain the captured bytes.
  Provider checkout identifiers are not automatically treated as credentials.
- staff-anonymous.json: one object in an array, containing exactly
  staff_ref (staff_001 or sandbox-staff-1), active (boolean), auth_linked (true). An optional role
  may be null or omitted when the source has no role column. Only preserve owner/staff
  if that role actually exists in the source; never infer it from the Auth account.
  Exclude the real auth_user_id, email, password, tokens, JWT and Auth data.
- recovery-source-proof.json: capturedAtUtc, expectedCateringRows=4, expectedStaffRows=1,
  cateringRowsSha256 (SHA-256 of the exact catering-orders.json bytes),
  staffAnonymousSha256 (SHA-256 of exact staff-anonymous.json bytes),
  scope=read_only_source_capture_not_reset_or_restore,
  allRowsReviewedSynthetic=true, schemaDumpSucceeded=true, authPlatformPreserved=true,
  markerClassificationPassed=true, freeFormReviewPending=false, localRestoreProof=false.
  Initial capture must leave allRowsReviewedSynthetic=false and freeFormReviewPending=true
  until a private complete-row review is performed. Marker classification alone is insufficient.

The person capturing the rows must review all four complete rows, including nested
payloads, without publishing their contents. Test names and reserved email suffixes
alone do not prove every nested value is synthetic. The checker reports credential
or nonreserved-email concerns by field name only and does not redact or rewrite them.
If redaction is necessary, label that copy incomplete and retain the issue; do not
call it a verified complete recovery dataset.

The declared source hash is a transport integrity check, not an independent
authenticity proof. Compute it at capture time and retain the successful capture
command receipt privately. A hash computed later from the destination alone cannot
prove that the source was exported completely.

## Run

Use Node 24 or newer (exact-number readback comparison needs JSON source context).

    node tools/test-env/validate-recovery.mjs <private-directory>
    node tools/test-env/validate-recovery.mjs <private-directory> --readback <local-readback.json> --output <new-report.json>

The output includes counts, field names and artifact hashes, never row values,
emails, UUIDs, provider identifiers or staff identities. The optional output file
uses exclusive creation and cannot overwrite an input. Missing files and validation
failures return failure. No report grants reset permission.

## Restore proof and staff identity

An independent isolated local restore must apply the schema and recover all four
orders. Then export every column and compare its JSON readback with the source.
The comparison tolerates object-key and row ordering changes but detects missing
columns, altered nested values, null/boolean/string changes and exact decimal or
large-integer differences. It never treats rounded JavaScript numbers as proof.

Even a matching data readback is not by itself full schema restore or Supabase
Auth/JWT proof. This checker intentionally reports restorationVerified=false.
Retain the independent restore process result, schema checks, row counts and
comparison result together before describing recovery as verified.

The real staff Auth principal is intentionally not recoverable from this artifact.
The planned application-only reset must preserve the Auth platform. Afterward,
an authorized private operation must link the preserved Auth account to staff_001
and restore its active flag and any source-proven role. An unknown role stays unknown. Do not place that identity mapping in reports,
Git or the anonymous export. This is an application recovery package, not a full
database/Auth/storage/Vault backup. No reset is performed by these tools.
