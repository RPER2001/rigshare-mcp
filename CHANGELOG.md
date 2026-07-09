# Changelog

All notable changes to `rigshare-mcp` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
