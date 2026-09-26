# Changelog

All notable changes to `rigshare-mcp` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Dates are the UTC day each version was published to npm. A few version
numbers were used for development milestones that were never published on
their own; those entries say which published release first included them.

## [2.1.2] — 2026-09-28

No tool, parameter, output field, annotation, resource or prompt was added,
removed or renamed: existing MCP client configurations keep working unchanged.

### Changed
- `rigshare_create_booking`: `idempotency_key` must be printable ASCII (up to 100 characters); a UUID works. The server refuses anything else.
- `rigshare_create_booking`: a request that matches a booking you created a few minutes ago now says that nothing new was booked or charged, shows that booking's payment state, and never tells you to pay while a payment is in progress. A different `idempotency_key` for an identical booking gets a clear conflict naming the existing booking; reusing a key for a different booking is refused.
- Tool and parameter descriptions were rewritten to match what the RIGShare
  API actually does: what each tool does, when not to use it, what each
  parameter means, and what it does not return.
- `category` on `rigshare_create_listing` and `rigshare_save_draft_listing`
  lists the accepted values. Any other value is refused before a request is
  sent; RIGShare already refused it.
- API keys are created at https://www.rigshare.app/enterprise and need a Pro
  or Enterprise plan. Earlier copy pointed to a profile page that has no
  API-key section.
- Spend caps are described as they are: an optional per-transaction cap and
  an optional daily cap, neither set on a new key, and a booking is checked
  against them before sales tax. There is no monthly cap.
- `rigshare_extend_session` documents when it is refused: auto-pay is off on
  the API key (as it is on a new key), the extension would go over a spend
  cap, or the key is invalid, revoked or expired. For those refusals the tool
  says that no hold was placed.
- `rigshare_sync_availability` sends date-times that carry a UTC offset as
  UTC. A time with no offset, or a block that ends before it starts, is
  refused up front with a message naming the block; RIGShare refuses the
  whole sync for either.
- `rigshare_create_booking` explains that a date-only start for a four-hour
  booking is usually refused, but books the previous afternoon in Pacific
  time in winter, Alaska and Hawaii.

### Fixed
- `rigshare_extend_session` no longer shows a new total budget of $0.00 when
  RIGShare could not report it. It says the total is unknown and to check
  `rigshare_get_session_usage` instead of extending again.
- `rigshare_create_booking` tells the renter to pay now on an instant-book
  listing, instead of waiting for an owner approval that never comes.
- `rigshare_create_listing` links an `AI_COMPUTE` listing to its Robotics & AI
  page, reports an `external_id` match as an update of the existing listing
  (its photos are not changed), and does not call a listing that is not
  active "live".
- `rigshare_list_my_bookings` shows the owner's displayed deposit (none
  stated, none required, or the figure) instead of a $0.00 deposit.
- `rigshare_cancel_booking` says when the owner declined a request, and that
  the amounts are not final while a refund is pending.
- `rigshare_publish_listing` no longer says `PHOTO_REVIEW_UNAVAILABLE` always
  clears on retry: it usually does, but if it keeps failing the owner should
  replace the photos or contact support.
- `rigshare_sync_availability` reports a failed sync as an error that changed
  nothing, instead of as a success.
- `rigshare_start_session` no longer says a new session was started when it
  returned the session already live on the booking.
- Owner onboarding and the offline fallback copy no longer list Afterpay.

## [2.1.1] — not published

Never published on its own; these changes first ship in 2.1.2. No change to tool names, input or output schemas, annotations, resources or
prompts: existing MCP client configurations keep working unchanged.

### Changed
- Smaller package: comments are stripped from the compiled `dist/index.js`.

### Fixed
- `rigshare_create_booking` and `rigshare_get_booking` say a payment is
  **processing** (and that the renter should not pay again) while an auto-pay
  payment is still settling, instead of reporting it as pending or not yet
  paid.

## [2.1.0] — 2026-09-08

Agents can now run the whole loop — book, list, and run a remote session —
with a human kept in the loop for money.

### Added
- **`rigshare_get_booking`** — one booking plus `next_action` (who acts next,
  a plain-language instruction and the exact URL). The polling half of the
  booking flow: owner approves → renter pays at the URL → CONFIRMED → (Robotics
  & AI) start the session.
- **`rigshare_get_session`** — status, health, connect handoff, usage, metered
  budget vs billed, and the latest telemetry (null until the node reports).
- **`rigshare_publish_listing`** — publish a draft through the same checks the
  RIGShare apps use. Failure codes (`ID_NOT_VERIFIED`,
  `STRIPE_CONNECT_REQUIRED`, `TIER_LIMIT`, `INCOMPLETE`,
  `REPLACEMENT_VALUE_REQUIRED`, `DEPOSIT_ABOVE_LIMIT`, `MODERATION_FLAGGED`)
  come back with a hint the agent can relay to the owner.
- `replacement_value_usd` and `deposit_display_usd` on
  `rigshare_save_draft_listing` and `rigshare_create_listing`. A physical
  listing needs a replacement value to publish; it caps the deposit figure an
  owner may display at 10% of it ($25–$1,000).
- `rigshare_create_booking` shows the server's `next_action` and documents the
  start-time rule for short rentals: four-hour bookings take ISO date-times
  with a UTC offset and must start by 4:00 PM local; hourly bookings are
  billed per whole hour between the two instants. `rigshare_quote_booking`
  refuses a four-hour start after 4:00 PM local up front.
- `Dockerfile` for hosted execution (Glama / Smithery).

### Changed
- **RIGShare no longer holds a security deposit on new bookings.** Quotes,
  bookings and the owner-onboarding copy show the owner's *displayed* deposit
  figure (`deposit_display_cents`: null = the owner stated none, 0 = the owner
  requires none). It is never held or authorized, and is charged only if the
  renter expressly accepts a damage claim, never above that figure.
  `rigshare_cancel_booking` reports whether an older booking had a real hold
  (`had_hold` / `disposition`); such a hold is released, never captured.
- `rigshare_cancel_booking`: when a booking ends before pickup is confirmed,
  the owner delivery fee is refunded in full together with the service fee
  charged on it.
- The reduced verified-student service fee is no longer quoted as a fixed
  figure in tool or resource descriptions; it is always resolved server-side.

### Fixed
- **`student_rate_active` is passed through.** `GET /api/public/v1/policy`
  publishes whether the reduced student rate is currently being charged; the
  package now keeps that field (only a real boolean is accepted — anything
  else stays `null`, meaning unknown).
- The owner-onboarding Economics section mentions the student rate only when
  the live policy says it is active, says the status is unknown when it is
  serving bundled fallback copy, and omits it when the rate is off.
- The bundled fallback carries `student_rate_active: null`, since it is only
  used when the live policy cannot be reached.
- `listing_caps.student` is `null` (no student-specific cap is published)
  rather than `2`, and a `null` cap renders as "Not published" instead of
  "Unlimited".

## [2.0.0] — 2026-07-09

This release also includes the changes listed under 1.5.0 and 1.6.0 below,
which were not published on their own.

### Added
- **MCP resources**: `rigshare://pricing` and `rigshare://owner-onboarding`
  (read live from `GET /api/public/v1/policy`), `rigshare://categories` (from
  `/api/public/v1/categories`), and `rigshare://terms` /
  `rigshare://how-it-works` (links to the web pages).
- **MCP prompts**: `rent-gpu` (search → details → quote → book compute),
  `list-my-equipment` (onboarding → save draft → publish) and
  `check-my-rentals` (bookings + sessions + metered usage).
- **`structuredContent`** on the read tools (`search_equipment`,
  `get_equipment`, `quote_booking`, `list_my_bookings`, `list_my_sessions`,
  `get_session_usage`, `check_availability`), alongside the unchanged text, so
  agents can machine-read results. Write tools remain text-only.
- **Tool annotations** (`readOnlyHint` / `destructiveHint` / `idempotentHint`
  / `openWorldHint`) and a short `title` on every tool.
- **`rigshare_end_session`** — stops the per-minute meter a
  `rigshare_start_session` started and settles the exact usage server-side,
  releasing the unused budget (`sessions:write`).
- Search results show four-hour (`$X/4hr`) and monthly (`$X/mo`) rates.
- `RIGSHARE_BASE` (the host every API base derives from) and
  `RIGSHARE_V1_API_BASE` overrides. Existing `RIGSHARE_API_BASE` /
  `RIGSHARE_AGENT_API_BASE` settings still take precedence.

### Changed
- **Pricing and onboarding copy is read live** from
  `GET /api/public/v1/policy`, so a published price change reaches agents
  without a new package release. If the endpoint is unreachable the tools fall
  back to bundled copy and keep working. Public lookups (categories, policy)
  are cached in memory for about 10 minutes; failures are never cached.
- **Error messages from the public API** now include the server's error text
  and a code: `client_4xx` (fix the request), `upstream_5xx` or
  `network_error` (retryable). Request URLs are no longer included in the
  message.
- **Upgraded to the current `@modelcontextprotocol/sdk`** (`^1.29.0`, plus
  `zod ^3.25`). Tool inputs are validated before a tool runs, so malformed
  input now returns the validator's message instead of the old custom error
  strings. Tool names, inputs, endpoints, auth and output text on valid input
  are otherwise unchanged. The major version signals the SDK upgrade.
- `rigshare_get_owner_onboarding` describes the draft-first flow: start a
  listing right away, and complete identity and payout setup once, at
  publish. The direct `rigshare_create_listing` path still publishes
  immediately, so that setup must be done on the web first.

### Fixed
- **`rigshare_create_listing` could not publish remote-access listings.** The
  required `security_ack` attestation is now part of the `remote_access`
  input, is sent to the API, and a clear error is returned up front when it is
  not `true`.
- **Search no longer hides rows.** Every row the requested page returned is
  shown; `limit` alone decides how many.
- **Unexpected tool errors** return a generic message to the model; details
  go to the server's stderr log.

### Removed
- `rigshare_create_listing`'s `remote_access` no longer offers
  `compute_architecture` or `gpu_temp_ceiling` (added in 1.4.0).

## [1.6.0] — not published

Not published to npm on its own; these changes first shipped in 2.0.0.

### Added
- **`rigshare_cancel_booking`** (`bookings:write`) — cancels a booking and
  issues any refund per RIGShare's published cancellation policy, computed
  entirely server-side (physical: 7+ days 100% / 3–6 days 75% / 1–2 days 50% /
  same day 0%, with a 25% high-value exception on multi-day rentals over $5k;
  Robotics & AI remote access: before the session 100% / within the first hour
  75% / after that 0%). The client sends only the booking id and an optional
  note; it cannot set the refund amount. Cancelling an already cancelled,
  completed or disputed booking returns an error, never a second refund.
- **`rigshare_extend_session`** (`sessions:write`) — raises the authorized
  budget on a running per-minute session by 15, 30 or 60 minutes. The added
  authorization is computed server-side from the listing's rate; only actual
  usage is charged. Renter only.
- **`rigshare_get_session_usage`** (`sessions:read`) — live budget snapshot for
  a per-minute booking: authorized vs used, accrued cost, a low-budget warning
  and the extension options. Moves no money.
- **`rigshare_save_draft_listing`** (`equipment:write`) — saves a half-finished
  listing as a draft. No identity or payout setup is needed to draft; those
  checks and a photo are required at publish. Idempotent per
  `draft_session_id`.

## [1.5.0] — not published

Not published to npm on its own; these changes first shipped in 2.0.0.

### Added
- **`rigshare_quote_booking`** (`bookings:read`) — a dry-run price quote: the
  exact cost `rigshare_create_booking` would charge (rental subtotal, renter
  service fee, delivery, coverage/egress, any deposit terms in effect at the
  time, and the grand total, in cents and formatted USD), without creating or
  charging anything. Per-minute listings return the hourly rate, minimum
  session budget and budget presets instead. No client price is sent or
  trusted.
- **`rigshare_check_availability`** (`equipment:read`) — the unavailability
  windows on one of your listings, looked up by its `external_id`, and
  optionally whether a requested range overlaps one.
- **`rigshare_sync_availability`** (`equipment:write`) — push an ERP / fleet
  calendar onto a listing. The blocks you send replace the previously synced
  set (send `[]` to clear); windows that overlap a confirmed booking are
  rejected and reported back.

## [1.4.0] — 2026-06-24

### Added
- **AI-compute discovery** — `rigshare_search_equipment` accepts a
  `compute_architecture` filter (CUDA / ROCM / APPLE_SILICON / TPU / TRAINIUM /
  CPU), and each result shows its architecture.
- **AI-compute listing options** — `rigshare_create_listing`'s `remote_access`
  accepts `compute_architecture` and an optional `gpu_temp_ceiling` (°C).
- Owner onboarding and the listing `endpoint` field explain RIGShare's managed
  tunnel for hardware without a public IP address.

### Changed
- Category examples use `AI_COMPUTE` (previously `GPU_COMPUTE`; the old value
  is still accepted).

## [1.3.0] — 2026-06-10

This release also includes the changes listed under 1.2.0 below.

### Added
- **`rigshare_create_listing`** (`equipment:write`) — owners can publish
  listings from an MCP client, in both divisions (construction, and Robotics &
  AI with remote-access settings and per-minute billing). Photos are passed as
  https URLs; RIGShare fetches, moderates, watermarks and re-hosts them. The
  same requirements as the web flow apply: identity verification, payout
  setup, plan listing limits, content moderation and category requirements.
- `rigshare_get_owner_onboarding` mentions the direct listing path for owners
  who have an API key.

## [1.2.0] — not published

Not published to npm on its own; these changes first shipped in 1.3.0.

### Fixed
- **The authenticated tools misread successful responses.**
  `rigshare_list_my_bookings` and `rigshare_list_my_sessions` always reported
  "none found", and `rigshare_create_booking` created the booking but showed
  "—" for its confirmation code and booking ID. All three now read the
  response correctly.
- `rigshare_create_booking` shows the auto-pay payment status (and any error)
  and links Robotics & AI bookings to the correct booking page.
- The server reports its real version (it was stuck at 1.0.0).

### Added
- **Per-minute (metered) billing** — `budget_usd` on `rigshare_create_booking`
  authorizes a session budget for metered listings; search and details flag
  metered listings and their hourly rate; the bookings list shows the
  authorized budget and settled usage.
- **`rigshare_start_session`** (`sessions:write`) — starts a remote session on
  a confirmed Robotics & AI booking and returns the one-time access token,
  connection URL and allocated specs.
- **Coverage and qualification inputs** on `rigshare_create_booking`
  (`coverage_path`, `waiver_version`, `qualification_answers`,
  `qualification_version`). Physical equipment requires a coverage choice;
  without these inputs such bookings could not be made from the tool.
- `RETURN_PENDING` in the bookings status filter.

## [1.1.3] — 2026-05-02

### Fixed
- README and `smithery.yaml` show the correct API-key prefix, `rigs_live_`.
  Documentation only.

## [1.1.2] — 2026-04-22

### Changed
- `package.json` and `server.json` point to the public repository,
  https://github.com/RPER2001/rigshare-mcp. No runtime changes.

## [1.1.1] — 2026-04-21

### Added
- `mcpName` in `package.json` and a `server.json` manifest; published to the
  Official MCP Registry as `io.github.RPER2001/rigshare`.

### Fixed
- Shorter `server.json` description, within the registry's 100-character
  limit.

## [1.1.0] — 2026-04-21

### Added
- `rigshare_get_owner_onboarding` — for users who own equipment. Detects
  construction vs Robotics & AI from the equipment type and returns the
  matching pitch, signup URL, commission tiers and step-by-step instructions.

### Changed
- An empty search result suggests owner onboarding.
- Consistent `RIGShare` capitalization in tool descriptions, README and error
  messages.

## [1.0.0] — 2026-04-21

### Added
- Initial release with 6 tools:
  - **Read-only** (no API key): `rigshare_search_equipment`,
    `rigshare_get_equipment`, `rigshare_list_categories`.
  - **Authenticated** (require `RIGSHARE_API_KEY`):
    `rigshare_list_my_bookings`, `rigshare_list_my_sessions`,
    `rigshare_create_booking`.
- stdio transport, built on `@modelcontextprotocol/sdk`.
- Booking prices are computed server-side (client price hints are ignored).
- Idempotency key support for booking retries.
