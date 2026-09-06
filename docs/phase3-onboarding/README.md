# Phase 3 - Onboarding interface

## Apply this patch

This ZIP contains only changed/new files, relative to the repository root. Merge its folders into the existing project after the supplied Phase 1 and Phase 2 updates; it is not a standalone application. No files need deletion and this phase introduces no database migration. Back up or commit your current working tree before applying it.

The conversation contained two different Phase 1 archives. The Phase 2 manifests identify `frontend-updated.zip` / `backend-updated.zip` as their foundation, not the alternate `*-phase1-updated.zip` archives. Necessary overlapping auth, host/access-cache, publication-delivery and projection files are reconciled in this patch so those incompatible variants do not remain mixed. The retained Phase 1/2 behavioral suites pass on the reconstructed tree. Keep the frontend and backend patches together.

Deploy the compatible backend first, then the frontend. The new private preview query requires backend preview contract version 1 and exact website/revision/profile metadata. An older backend is deliberately shown as an unconfirmed preview, not accepted as ready. Keep the existing publication transaction, durable outbox worker, epoch guards, session synchronization and five-step save contract enabled. Do not disable migrations, validation, authorization or release checks to get a green build.

## Verification status - release gate remains required

The bundled verification JSON and native TAP log describe actual local checks. Native tests exercise production TypeScript exports with explicit memory/database/Redis I/O adapters; they are not live database or browser tests. Syntax transpilation and local-import checks are not dependency-aware type checking.

The working environment did not contain project `node_modules`; package downloads could not resolve the registry. A full TypeScript check was attempted and failed because dependencies/type declarations were unavailable. Dependency installation, real-Zod Vitest tests, production builds, live PostgreSQL/Redis integration, actual browser screenshots, staging traces and real-device/screen-reader acceptance were NOT completed here. No staging success or production certification is claimed. Run the release and browser gates below before deploying to customers.

## Behavior delivered

The UI keeps Business profile, Branding, Services, Website address, and Review and launch, with the server-selected default template. A restrained desktop rail, stable central form, optional real-template preview, mobile keyboard-navigable tabs and a visual-viewport/safe-area footer replace the former moving-step interface. Labels, hint/error IDs, focused step headings and focused error summaries use the dashboard field components and neutral/green tokens. Form controls use 14-16 px text, modest radii and reduced-motion-safe transitions.

Saving is explicit and truthful. A component-lifetime, authenticated-owner-scoped draft store retains unsaved values on Back/retry, while acknowledged responses update the existing canonical caches. No private form values are put in localStorage. Only this wizard's own acknowledged revision edges can rebase a retained step; unrelated replay/other-tab data cannot silently rebase it. Failed uploads retain the selected File in memory with a clear retry/cancel path. Profile clears, international phone validation, existing currency/timezone, stable service IDs and add-ons, full-catalog conflict tokens and atomic saves are retained from Phase 2.

The final review displays persisted profile, branding, service/add-on and booking-readiness data, then exposes one Launch website action. Launch still uses the Phase 1 idempotent mutation and the auth gate's single navigation authority. The auth gate now preserves an already-confirmed form tree beneath an inert recovery dialog during a transient background session error; initial checks and 401/403 still block access.

Preview and public output use the same template registry, Shell/Page renderers, component runtime and projection contract. Local editable fields are overlaid on an authenticated canonical projection without a request for each keystroke. A new acknowledged revision/profile refreshes the canonical preview. The embedded iframe supplies real 1120/390 px CSS viewports and isolates dashboard typography; it is scaled to fit. A saved full-page preview uses the existing server-issued, short-lived private session rather than exposing an owner API URL.

Preview navigation is local and allowlisted to the projection's pages. Real booking/estimate engines and their availability/payment requests are not mounted in preview. Contact/review submissions, Turnstile and external map actions are isolated/disabled, analytics is disabled, indexing is forbidden and private pages use no-store/no-referrer headers. This intentional inert state is the exception to interaction parity; it must not create customer records. No template/review/claim/availability is invented in the local overlay. Hardcoded ratings, blanket guarantees and fabricated business statistics were removed; real reviews and business-authored page claims remain. Existing template identities/versions remain selected; this is not the Phase 4 template redesign.

## Manual staging acceptance still required

Use disposable tenants, not customer accounts. Check phone/tablet/desktop layouts at 320, 390, 768, 1280 and 1440 px, browser zoom at 200%, real iOS/Android software keyboards and reduced motion. Tab through every control and verify labels, error descriptions, step-title focus, arrow/Home/End preview-tab behavior, modal focus recovery and screen-reader announcements using VoiceOver/NVDA or an equivalent supported reader.

Save, reload, go back and retry every editable profile/branding/service field, including explicit null clears, non-default currency/timezone, logo/favicon removal/upload failure, zero-priced add-ons, 101+ catalog rows, deselection and an edit in another tab. Confirm rejected conflicts preserve inputs. Compare the actual selected template and brand values in local, saved-session and public renderers, including missing media/reviews and booking disabled/enabled states. Confirm no preview form, payment, availability or analytics request can submit. Test token expiry, Redis outage, suspension, reassignment and logout while a preview request is in flight.

Finally run the retained registration/launch staging harness: cached DRAFT access, first canonical-host request and revision, exactly one dashboard navigation, duplicate launch and post-commit lost response. Verify the wildcard host infrastructure independently using the existing platform checks. No DNS/TLS or live tenant infrastructure was modified by this patch.

## Backend commands and private preview contract

```sh
pnpm install --frozen-lockfile
pnpm run release:phase3:onboarding
```

The release command generates Prisma, validates its schema, runs retained launch/onboarding tests, the new preview-session behavior tests, real-Zod 4 preview wire-contract tests, full type checking and the production build. Existing database migrations and normal environment prerequisites remain necessary; this patch adds no new schema/table/queue.

Owned `GET /website/preview` responses include `website.previewContractVersion: 1`, `website.draftRevisionNumber` and `website.previewProfileVersion`. These private-only fields describe the draft, not a published revision. Bootstrap and preview derive profile hashes from the same persisted business fields, normalized legacy hours and postcode/zipcode mapping. Public projections do not gain private profile-version fields.

`POST /website/preview-sessions` accepts an optional `expected` object with website ID, nonnegative integer draft revision and 64-character profile hash. A saved-preview expectation cannot be combined with nonempty editor overrides. Malformed input is rejected; stale website/revision/profile expectations return a classified conflict before token delivery. Legacy Studio editor-state previews without an expectation remain compatible.

Tokens are generated using 32 cryptographic random bytes, stored only under a SHA-256 Redis key using EX 600/NX, and returned only after Redis confirms the write. Redis failure returns a retryable 503 instead of confirmed readiness. Consumption rejects malformed dates/envelopes, future issuance, expiry, excessive lifetime and mismatched projection identity, and checks current website ownership, owner status and tenant lifecycle again. The full-page route is no-store/no-referrer/noindex. Treat bearer tokens as secrets in all external logging and monitoring.

Preview services no longer silently cap an otherwise complete active catalog at 200 rows. Measure large-catalog serialization/read cost on staging; no new latency target is claimed. Existing public snapshot/revision selection, access validity, generation-aware routing/projection caching and durable publication recovery remain in the compatible Phase 1 form.
