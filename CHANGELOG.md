# Changelog

All notable changes to `rigshare-mcp` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
