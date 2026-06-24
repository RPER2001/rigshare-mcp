# Changelog

All notable changes to `rigshare-mcp` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.4.0] - 2026-06-23

### Added
- **AI-compute discovery** — `rigshare_search_equipment` now accepts a
  `compute_architecture` filter (CUDA / ROCM / APPLE_SILICON / TPU /
  TRAINIUM / CPU) so agents can narrow to the accelerator family their
  framework is locked to (e.g. CUDA-only kernels). Search results now
  surface the architecture inline for each matching listing.
- **AI-compute listing config** — `rigshare_create_listing`'s
  `remote_access` block accepts `compute_architecture` (the accelerator
  family renters filter on) and `gpu_temp_ceiling` (optional safe GPU
  temperature in °C; RIGShare auto-pauses an overheating node).
- **Tunnel awareness for NAT'd hardware** — owner onboarding and the
  `endpoint` field now explain RIGShare's managed reverse tunnel: an owner
  whose box has no public IP can finish in the web wizard's
  "Auto-provision a RIGShare tunnel" step (a one-line agent assigns a
  secure `https://rig-<id>.tunnel.rigshare.app` endpoint automatically),
  rather than port-forwarding.

### Changed
- Category examples in tool schemas updated `GPU_COMPUTE` → `AI_COMPUTE`
  (the enum was renamed; the legacy key/slug still resolve server-side).

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
