# Phase 4 - Versioned website design backend

## Apply and verify

Overlay these repo-relative changed/new files onto the backend after Phases 1-3.
Use the matching frontend patch. No Prisma schema migration, second queue, new
runtime dependency or bulk tenant rewrite is introduced. The existing publication
transaction, immutable snapshots, launch idempotency, durable outbox and immediate
readiness checks are retained.

**Do not treat the offline checks as production approval.** This environment had
no installed Prisma/Vitest application dependency tree, database, asset-storage
credentials or authenticated staging environment. Real type checking, Prisma
validation, Vitest integration and a production build remain release gates.

## Version and compatibility rules

The registry retains all four 1.0.0 definitions and adds the four 2.0.0 definitions.
The public projection's schema remains version 1; presentation version is a separate
explicit identifier. The API publishes the same `{id, version, schemaVersion}`
contract already used by the frontend; no runtime schema is imported across
frontend Zod 3 and backend Zod 4 projects.

Existing versions are never upgraded by a versionless save. A versionless change
to a different family uses its original release; the new Studio submits both ID
and version for intentional upgrades. Public compatibility fallback uses the
original release, not the registry's latest entry. An entitlement downgrade uses
Clean Modern from the same committed release, retaining the stored premium
selection for restoration. Read paths keep existing v2 publications resolvable
when the selection gate is disabled.

The component registry keeps every existing `.v1` ID and adds its matching `.v2`
ID. Publication checks known IDs, correct slots, active status, the release gate,
premium entitlement and the existing design contract. Client-side card visibility
is not the publication authorization boundary.

## Activation order

The new environment variables are documented in `.env.example`:

```dotenv
WEBSITE_TEMPLATE_V2_ENABLED=false
WEBSITE_DEFAULT_TEMPLATE_VERSION=1.0.0
```

First deploy this backend with those defaults. Deploy the matching frontend's v1
and v2 renderers and complete versioned catalog to every serving instance. Verify
canary preview and public routes. Then set `WEBSITE_TEMPLATE_V2_ENABLED=true` to
allow explicit v2 selection and publication. Changing the registration default is
a separate decision: set `WEBSITE_DEFAULT_TEMPLATE_VERSION=2.0.0` only after the
canary succeeds. Default 2.0.0 is rejected unless the gate is true. Invalid release
configuration fails closed when the policy is read.

Existing website records and published snapshots are not migrated. The repair
service's historical fallback remains explicitly 1.0.0. Idempotent provisioning
returns an existing website unchanged. New-site provisioning reads the configured
default only when creating a website.

Rollback: restore the new-site default to 1.0.0 and disable new v2 selection/
publication as needed, but keep the deployed v2 renderers while v2 publications
exist. Gate rollback does not make an already-live site disappear and does not
authorize deleting historical revisions. An already-selected v2 draft may still
be edited; a new v2 publication is blocked until activation is restored.

## Managed page photographs

The existing content-upload endpoint now accepts `hero-image` as well as
`about-image`. The existing multipart/authentication/HEIC conversion route remains
in use. Existing file-size, MIME, storage-response and image-dimension checks are
retained. New HOME hero references are validated against image assets belonging
to the current website on page save, editor save and publication/launch. Explicit
null removes a hero reference. Historical About URL compatibility is retained.

Content image URLs participate in draft/publication deletion protection. New
managed content assets are immutable and retained for historical revision restore,
even after removal from the current page. Physical reclamation is intentionally
not automatic; a future retention-aware cleanup must prove there are no retained
revision references before removing storage objects. Uploading an image does not
publish it or mutate the current page's unrelated fields.

HOME content also accepts bounded, authored process steps and an announcement.
These are presentation fields, not manufactured reviews or business claims. Real
business data, service identities, booking preferences and review sources remain
owned by their existing CRM modules.

## Verification

The executed dependency-light suites and exact counts are recorded in
`docs/phase4-verification.json`. They exercise the actual exported policy, release,
compatibility and ownership functions using explicit I/O adapters. The design
registry adapter does not claim to replace the real Zod contract tests. The launch,
onboarding and private preview regressions were rerun. Changed TypeScript was
syntax-transpiled, not fully type-checked against generated Prisma types.

Run with this repository's pinned package manager and actual infrastructure:

```sh
pnpm install --frozen-lockfile
pnpm run release:phase4:design
pnpm run test:phase1:launch:integration
pnpm run test:phase2:contracts
pnpm run test:phase3:preview-contract
```

The new design contract command includes the real registry, selection, component,
Studio, publication-cache and preview Vitest suites. Before activation, verify a
v1 published tenant and a newly selected v2 tenant in staging, their exact
committed revisions on canonical hosts, downgrade/restoration, uploads from the
wrong tenant, unknown template/component versions, launch retries, post-commit
recovery and concurrent edits during publication. No staging success, external
storage upload, DNS/TLS provisioning or production rollout is claimed by this
archive.
