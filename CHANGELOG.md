# Changelog

All notable changes to `rigshare-mcp` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
