# Changelog

All notable changes to `rigshare-mcp` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

NOT PUBLISHED. The source in this repo is corrected; shipping it requires a
version bump in THREE places (`package.json`, `src/index.ts` `VERSION`,
`server.json` ×2), then `npm publish` followed by `mcp-publisher`.

### Fixed
- **`student_rate_active` is no longer discarded.** RIGShare's reduced
  verified-student rate has a kill switch, and `GET /api/public/v1/policy`
  publishes `student_rate_active` so a consumer can tell whether the rate is
  actually being charged. `coercePolicy` whitelists fields and was dropping
  exactly that one, so this package could not see the answer it was fetching —
  while the app's seeded AI knowledge entries now tell every agent that this
  field IS the live answer. It is passed through, and only a real boolean is
  accepted (anything else stays `null` = unknown, never a default of "yes").
- **No static string promises the student rate any more.** The quote-booking
  tool description, the `rigshare://pricing` resource description and the
  rendered Economics bullet all asserted "student 3%" unconditionally. The
  bullet now renders the reduction only when the live policy says the rate is
  active, says the status is unknown when serving the bundled fallback, and
  omits the clause entirely when the rate is off.
- **The bundled fallback stops making claims it cannot know.** It carries
  `student_rate_active: null` — it renders precisely when `/policy` is
  unreachable, so "unknown" is the only honest value.
- **`listing_caps.student` is `null`, not `2`.** RIGShare published a 2-listing
  student cap that was enforced nowhere and has retired the claim rather than
  starting to enforce it. `capLabel` no longer renders a null cap as
  "Unlimited" — that was a positive claim invented out of an absence.

## [2.0.0] - 2026-07-09

### Added (additive modern-MCP surface — no change to existing tool behavior)
- **MCP RESOURCES** (`capabilities.resources`). Five resources registered via
  `server.registerResource`: `rigshare://pricing` + `rigshare://owner-onboarding`
  (backed by a NEW app endpoint `GET /api/public/v1/policy`),
  `rigshare://categories` (backed by `/api/public/v1/categories`), and static
  `rigshare://terms` / `rigshare://how-it-works` (URL pointers to the web pages).
- **Durable anti-drift: pricing/onboarding copy is now sourced from the app.**
  `rigshare_get_owner_onboarding` renders its Economics block (commission tiers,
  subscription prices, listing caps, renter service fee incl. student 3%,
  security-deposit rate/minimum) LIVE from `/api/public/v1/policy` — the single
  source of truth backed by the enforced constants (`subscriptions.ts`
  `SUBSCRIPTION_TIERS` + `STUDENT_TIER`, `stripe.ts` `RENTER_SERVICE_FEE_RATE` /
  `SECURITY_DEPOSIT_RATE` / `SECURITY_DEPOSIT_MIN`). A price change in the app now
  flows to the tool WITHOUT republishing this package. **Graceful fallback:** if
  the endpoint is unreachable the tool falls back to a bundled copy that mirrors
  the constants, so it can never break; the policy fetch is cached ~10 min. The
  division-specific signup/how-it-works URLs stay local.
- **MCP PROMPTS** (`capabilities.prompts`). Three guided workflows via
  `server.registerPrompt`: `rent-gpu` (search → get → quote → book tech compute),
  `list-my-equipment` (onboarding → save draft → publish), and
  `check-my-rentals` (list bookings + sessions + metered usage). Each renders a
  concise template referencing the real tool names.
- **`structuredContent` (P-4)** on the seven READ tools (`search_equipment`,
  `get_equipment`, `quote_booking`, `list_my_bookings`, `list_my_sessions`,
  `get_session_usage`, `check_availability`): each now declares a permissive Zod
  `outputSchema` and returns the normalized (mostly passthrough) parsed response
  as `structuredContent` ALONGSIDE the unchanged text, so agents can machine-read
  results. Write tools are intentionally left text-only. Error results omit
  `structuredContent` (the SDK skips output validation for `isError` results).

### Changed (additive polish — no tool behavior change on valid input)
- **P-8 error taxonomy on the public fetch path.** `fetchJson` now parses the
  server's JSON error body (aligning with `fetchAuthJson`'s `data.error`
  extraction) and classifies retryable (5xx / network → `upstream_5xx` /
  `network_error`) vs. terminal (4xx → `client_4xx`), reflecting the code in the
  message. **S2:** the request URL is no longer in the client-facing error string
  (logged to stderr instead), matching `fetchAuthJson`.
- **P-9 in-memory TTL cache** (~10 min) for the slow-moving public GETs — the
  categories fetch and the new `/policy` fetch — so the resources + onboarding
  tool don't re-hit the API on every call. Only clean successes are cached.
- **NEW public app endpoint `GET /api/public/v1/policy`** (force-dynamic, no auth,
  no secrets, cache-friendly headers): the canonical pricing / fee / deposit /
  cancellation / draft-first-onboarding snapshot, sourced from the enforced
  constants. `version` bumps on any canonical change.

### Changed (BREAKING — internal surface only; no tool behavior change)
- **Migrated from the low-level `Server` API to the modern `McpServer` surface**
  of the official `@modelcontextprotocol/sdk` (bumped `^1.0.4` → `^1.29.0`; added
  `zod ^3.25`). Every tool is now registered via `server.registerTool(name, {
  title, description, inputSchema, annotations }, handler)` instead of the two
  hand-written `ListToolsRequestSchema` / `CallToolRequestSchema` handlers.
- **Hand-written JSON Schemas replaced by Zod input schemas.** Each tool's
  `inputSchema` is now a Zod raw shape that accepts the EXACT SAME inputs (same
  required vs. optional, enums, formats, and min/max constraints) — e.g.
  `z.string().uuid()`, `z.string().datetime()`, `z.number().int().min().max()`,
  `z.enum([...])`. Input is auto-validated BEFORE the handler runs, so the
  now-redundant manual guards (UUID re-regexes, required-field/type checks, the
  `additional_minutes` enum check, the `blocks` array check) were removed. The
  genuinely semantic guards the schema can't express are kept: the `remote_access`
  `security_ack === true` attestation, the "at least one photo" rule on
  `create_listing`, and the `external_id` trim/non-empty checks.
- **Tool annotations added** to every tool (`readOnlyHint` / `destructiveHint` /
  `idempotentHint` / `openWorldHint`) plus a concise `title`, so MCP clients can
  reason about which tools read vs. write vs. destroy.
- **This is a breaking release only in the SDK/registration surface.** All 17
  tools keep the SAME names, inputs, endpoints, auth, and rendered output text.
  Invalid-input error messages now come from Zod (the deleted manual guards)
  instead of the old custom strings — the only observable difference, and only on
  malformed input. Bumped to `2.0.0` to signal the SDK dependency jump; there is
  NO change to any tool's behavior on valid input.

## [1.6.0] - 2026-07-09

### Added
- **`rigshare_cancel_booking`** (MONEY PATH, bookings:write scope) — cancels a
  booking for the authenticated user AND issues any refund per RIGShare's
  published cancellation policy. The refund is computed ENTIRELY server-side from
  the booking's canonical charges + how far out the cancellation is (physical:
  7+d 100% / 3-6d 75% / 1-2d 50% / same-day 0%, 25% on >$5k multi-day; Tech
  remote: before-session 100% / first-hour 75% / after 0%; 7% renter service fee
  non-refundable on renter cancels). The client CANNOT dictate the refund amount
  or the trigger — it sends only the booking id (plus an optional audit note that
  never affects the refund). The security-deposit hold is released (never
  captured). Terminal-safe: cancelling an already-cancelled/completed/disputed
  booking errors, never double-refunds. Returns the refund breakdown (refunded /
  retained / deposit disposition). Backed by a NEW endpoint,
  `POST /api/v1/agent/bookings/[id]/cancel`, which routes through the SAME
  `updateBookingStatusForUser` core (→ `processAutoRefund`) the web + mobile use;
  the trigger is derived from the authenticated role, so an agent can't inject
  `OWNER_NO_SHOW` for a full refund.
- **`rigshare_extend_session`** (MONEY PATH, sessions:write scope) — raises the
  authorized per-minute budget on a running METERED (per-minute) Robotics & AI
  session so a renter about to hit their cap can keep going. The additional
  authorization hold + budget increase are computed SERVER-SIDE from the
  equipment's canonical per-minute rate (client picks only a fixed 15/30/60-min
  length); only actual usage is ever charged. Renter-only. Backed by a NEW
  endpoint, `POST /api/v1/agent/bookings/[id]/extend`, routing through the SHARED
  `extendMeterSessionForUser` core. Pairs with `rigshare_get_session_usage`.
- **`rigshare_get_session_usage`** (READ, sessions:read scope) — live budget
  snapshot for a METERED booking: authorized budget vs. used, accrued cost, a
  low-budget warning, and the extension options. Read-only (moves no money).
  Backed by a NEW endpoint, `GET /api/v1/agent/bookings/[id]/meter`, routing
  through the SHARED `getMeterUsageForUser` core (renter or owner). Pairs with
  `rigshare_extend_session`.
- **`rigshare_save_draft_listing`** (equipment:write scope) — saves a
  half-finished listing as a DRAFT (same fields as `rigshare_create_listing`, but
  nothing goes live). Drafts are UNGATED: no identity verification and no Stripe
  Connect payout setup are required to DRAFT (matching RIGShare's draft-first
  flow); those gates + a photo are enforced only at PUBLISH. Idempotent per
  `draft_session_id`. Backed by a NEW endpoint, `POST /api/v1/agent/drafts`, that
  reuses the SAME `createDraftFromPhotosForUser` + `updateDraftForUser` cores the
  mobile draft flow uses. A companion `POST /api/v1/agent/drafts/[id]/publish`
  endpoint (reusing `publishDraftForUser`) flips a draft → ACTIVE with the full
  publish-time gate stack intact.

## [1.5.0] - 2026-07-09

### Added
- **`rigshare_quote_booking`** — DRY-RUN price quote (bookings:read scope). Makes
  agent-driven booking SAFE: it computes the EXACT cost a `rigshare_create_booking`
  would charge — rental subtotal, renter service fee (student 3% vs 7% resolved
  server-side), the 15%/min-$100 security-deposit hold (0 for METERED), delivery,
  coverage/egress, and grand total (cents + formatted USD) — but creates and
  charges NOTHING. Previously the only pricing path was `rigshare_create_booking`,
  which charges, so an agent booked blind; now it can preview and confirm the cost
  with the renter first. METERED (per-minute Tech) listings return the per-hour
  rate, minimum session budget, and budget presets instead of a fixed total (no
  deposit). Backed by a NEW endpoint, `POST /api/v1/agent/quote`, which runs the
  SAME validation and the SAME server-side computation as the create route
  (`resolveEffectiveCommission` → `computeRentalQuote`) and stops before creating
  the booking. No client price is ever sent or trusted. `rigshare_create_booking`'s
  description now recommends quoting first.
- **`rigshare_check_availability`** — reads the unavailability windows (blocked
  date ranges) RIGShare holds for one of your listings, keyed by its `external_id`
  (equipment:read scope). Optionally reports whether a requested `starts_at` →
  `ends_at` range overlaps a blocked window. Backed by the existing
  `GET /api/v1/availability` (no app change); the endpoint keys only on
  `external_id` (an owner-scoped lookup), so the tool matches that exactly.
- **`rigshare_sync_availability`** — pushes an ERP/fleet calendar to RIGShare
  (equipment:write scope): marks date ranges UNAVAILABLE on a listing so no new
  RIGShare booking can be created during them, identified by `external_id`.
  Snapshot semantics — the blocks sent REPLACE the previously-synced set (pass
  `[]` to clear); windows overlapping a CONFIRMED booking are rejected and
  reported. Serves fleet/ERP owners who listed via `rigshare_create_listing`
  (external_id). Backed by the existing `POST /api/v1/availability` (no app
  change).

## [1.4.0] - 2026-07-09

### Fixed
- **`rigshare_create_listing` could not publish ANY remote-access (Tech)
  listing.** The backend hard-rejects a remote create without `security_ack`,
  but the tool never sent it — every GPU/robot/compute listing failed with an
  opaque 400. Added `security_ack` to the `remote_access` input (documented as
  REQUIRED when `remote_access` is provided), threaded it into the create body,
  and added a pre-flight check that returns a clear, actionable error before the
  fetch when it isn't `true`.
- **`rigshare_get_owner_onboarding` described the retired verify-first flow.**
  Rewrote the "How to list" steps to production's **draft-first** order: sign
  up → start the listing immediately (no verification needed to DRAFT) → at
  Publish, RIGShare walks you through one-time identity + Stripe Connect setup
  just-in-time → go live. Kept the note that the direct `rigshare_create_listing`
  API path publishes immediately (no draft step), so identity + Connect must be
  done once on the web first for that path.
- **Onboarding pricing copy corrected.** The renter service fee is now "up to
  7% (reduced to 3% for verified students)"; the deposit line clarifies the 15%
  authorization hold (minimum $100) applies to physical/FIXED rentals only —
  METERED per-minute Tech sessions have NO deposit (the renter authorizes a
  usage budget instead).
- **Search pagination no longer silently drops rows.** The tool advertised a
  limit up to 100 and forwarded it, then sliced the output to 10 and reported
  "N more omitted" — but those rows were unreachable (bumping `page` skips
  them). It now renders every row the page returned; the caller's `limit`
  decides how many come back.
- **Top-level tool errors no longer leak internals.** The CallTool catch echoed
  raw `err.message` to the model/user; it now logs the full detail to stderr
  and returns a generic message.

### Added
- **`rigshare_end_session`** — ends the METERED (per-minute) billing clock a
  `rigshare_start_session` started, settling the charge for EXACT usage
  server-side and releasing the unused budget (sessions:write scope). Closes
  the money-safety gap: search → book (budget) → start session → **end session
  (settle)**. Backed by a new agent endpoint,
  `POST /api/v1/agent/bookings/[id]/end`, which authorizes the caller and routes
  through the shared `endMeteredBookingForUser` core (client amounts ignored).
- **`compute_architecture` search filter** (`CUDA` / `ROCM` / `APPLE_SILICON` /
  `TPU` / `TRAINIUM` / `CPU`) on `rigshare_search_equipment` — forwarded to the
  public browse API and surfaced in each result row. Lets agents find AI compute
  a workload can actually run on.
- Search results now show the `four_hour` ($X/4hr) and `monthly` ($X/mo) rates
  in addition to hourly/daily/weekly.

### Changed
- **Robust base-URL derivation.** All API bases now derive from a single
  `RIGSHARE_BASE` (default `https://www.rigshare.app`) instead of a fragile
  `.replace(/\/agent\/?$/, "")` on the agent base. Existing `RIGSHARE_API_BASE`
  / `RIGSHARE_AGENT_API_BASE` overrides still win (back-compat), and a new
  optional `RIGSHARE_V1_API_BASE` override is honored.

## [1.3.0] - 2026-06-10

### Added
- **`rigshare_create_listing`** — owners can now publish equipment listings
  directly from an MCP client (equipment:write scope), for BOTH divisions:
  construction gear and Robotics & AI hardware (remote-access config +
  METERED per-minute billing supported). Photos are passed as https URLs
  and ingested server-side — SSRF-validated fetch, content moderation,
  watermarking, and re-hosting on RIGShare storage (hotlinks are never
  stored). The backend routes through the same shared listing engine as
  the web flow, so identity verification, Stripe Connect onboarding,
  plan listing caps, text moderation, and the per-category qualification
  floor all apply to API-created listings.
- `rigshare_get_owner_onboarding` now tells agents about the direct
  listing path when the owner has an API key.

## [1.2.0] - 2026-06-10

### Fixed
- **All three authenticated tools were broken by an envelope mismatch.** The
  agent API wraps every success payload as `{ data, success: true }`, but the
  tool code read fields off the top level. `rigshare_list_my_bookings` and
  `rigshare_list_my_sessions` always reported "none found", and
  `rigshare_create_booking` created the booking server-side but reported
  "Confirmation code: —, Booking ID: —, Total: $0.00" back to the agent.
  `fetchAuthJson` now unwraps the envelope.
- `rigshare_create_booking` now reads the response's flat field names
  (`confirmation_code`, `total_amount`, …), surfaces the auto-pay
  `payment.status` / error (previously silently dropped), and uses the
  server's division-aware booking URL — Tech bookings previously deep-linked
  to the construction path `/booking/<id>` instead of
  `/robotics-ai/booking/<id>`.
- Server version + User-Agent were stuck at 1.0.0; now derived from one
  `VERSION` constant matching `package.json`.

### Added
- **Metered (per-minute) billing support** — METERED Tech listings require an
  authorized session budget at booking. New `budget_usd` parameter on
  `rigshare_create_booking` (converted to `meter_budget_cents`); search/detail
  results now flag metered listings with their per-hour metering rate; the
  bookings list shows authorized budget and settled usage.
- **`rigshare_start_session`** — starts a remote session on a confirmed
  Robotics & AI booking (sessions:write scope). Returns the one-time access
  token, connection URL, and allocated specs. Completes the agent loop:
  search → book (budget) → start session → track usage.
- **Coverage + qualification parameters** on `rigshare_create_booking`
  (`coverage_path`, `waiver_version`, `qualification_answers`,
  `qualification_version`) — physical/construction equipment requires a
  coverage path (Terms §9); previously the tool offered no way to satisfy the
  gate, so every construction booking was rejected by the booking engine.
- `RETURN_PENDING` added to the bookings status filter enum.

## [1.1.3] - 2026-05-02

### Fixed
- README + `smithery.yaml` corrected the API-key prefix from the typo
  `rigsk_live_` to the actual generated prefix `rigs_live_`. No runtime
  or tool-surface changes — docs-only fix.

## [1.1.2] - 2026-04-21

### Changed
- **Source repository moved** from `RPER2001/rigshare-app/packages/mcp-rigshare`
  (private commercial repo) to `RPER2001/rigshare-mcp` (this public repo).
  `package.json` and `server.json` both updated to point here. No runtime or
  tool-surface changes.

## [1.1.1] - 2026-04-21

### Added
- `mcpName` property in `package.json` for Official MCP Registry compliance.
- `server.json` manifest for registry publishing via `mcp-publisher`.
- Published to the Official MCP Registry as `io.github.RPER2001/rigshare`.

### Fixed
- `server.json` description shortened to satisfy the registry's 100-char cap.

## [1.1.0] - 2026-04-21

### Added
- `rigshare_get_owner_onboarding` — 7th tool. Recruits equipment OWNERS who
  mention idle hardware. Auto-classifies robotics/AI vs construction from the
  equipment type and returns a tailored pitch with the right signup URL,
  commission tiers, and step-by-step instructions.
- Brand consistency sweep: `RigShare` → `RIGShare` across tool descriptions,
  README, and error messages.

### Changed
- Empty-result search now nudges toward owner onboarding when it's likely
  a supply-side gap.

## [1.0.0] - 2026-04-20

### Added
- Initial release with 6 tools:
  - **Read-only** (no auth): `rigshare_search_equipment`,
    `rigshare_get_equipment`, `rigshare_list_categories`.
  - **Authenticated** (require `RIGSHARE_API_KEY`): `rigshare_list_my_bookings`,
    `rigshare_list_my_sessions`, `rigshare_create_booking`.
- Stdio transport, TypeScript implementation on `@modelcontextprotocol/sdk`.
- Server-side price calculation for booking creation (client price hints
  ignored).
- Idempotency key support for booking retries.
- Division-aware decision-maker targeting (management for construction,
  executive for robotics/AI) — surfaced via the search tool.
