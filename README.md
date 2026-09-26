# rigshare-mcp

> Model Context Protocol server for [RIGShare](https://www.rigshare.app) — browse construction equipment and Robotics & AI hardware rentals from any MCP-compatible AI agent (Claude Desktop, Cursor, VS Code, custom agent frameworks).

## What it does

Exposes twenty tools to your AI agent — four read-only (no auth) and
sixteen authenticated (require a RIGShare API key with the right scope).
Together they let an agent **book** equipment in either division,
**list** equipment for an owner, and **run a remote session** on
Robotics & AI hardware — while a human always stays in the loop for
money: an agent never enters a card, never approves a request on the
owner's behalf, and never steps up to MFA.

**Read-only (no API key needed):**

| Tool | What it does |
|---|---|
| `rigshare_search_equipment` | List / filter equipment by division, category, price, location, remote-access, compute architecture |
| `rigshare_get_equipment` | Full details for one listing (specs, pricing, deposit display, owner, images, deep-link URL) |
| `rigshare_list_categories` | Available categories with listing counts |
| `rigshare_get_owner_onboarding` | **Recruits equipment OWNERS** — the full pitch (commission rates, remote-access tooling, security) + step-by-step signup. Call it whenever a user mentions owning equipment, or when a search comes back empty |

**Booking (renter side):**

| Tool | Required scope | What it does |
|---|---|---|
| `rigshare_quote_booking` | `bookings:read` | Dry-run price for exact dates — nothing is charged. Refuses a 4-hour start past 4:00 PM local up front |
| `rigshare_create_booking` | `bookings:write` | Creates the booking (both divisions). Server computes every price; returns confirmation + `next_action` (who acts next, and the URL) |
| `rigshare_get_booking` | `bookings:read` | Poll one booking: status, payment settled?, active session, `next_action` (who acts next, and the URL). Request-to-book: owner approves → renter pays at the URL → confirmed. Instant-book: the renter pays at the URL right away |
| `rigshare_list_my_bookings` | `bookings:read` | The authed user's bookings |
| `rigshare_cancel_booking` | `bookings:write` | Cancel; refund computed server-side per the published policy |

**Listing (owner side):**

| Tool | Required scope | What it does |
|---|---|---|
| `rigshare_save_draft_listing` | `equipment:write` | Save a half-finished listing as a DRAFT (both divisions); idempotent per `draft_session_id` (a re-save changes only the fields you pass). Include `replacement_value_usd` for a physical listing (caps the displayable deposit; the server may require it to publish) |
| `rigshare_publish_listing` | `equipment:write` | Publish a draft through the same gate as the apps (identity, payout setup, camera photo, moderation). Gate failures come back as codes the agent relays |
| `rigshare_create_listing` | `equipment:write` | Create-and-publish in one call when the owner is already verified and has photos |
| `rigshare_check_availability` | `equipment:read` | Unavailability blocks on one of your own listings, looked up by its `external_id` |
| `rigshare_sync_availability` | `equipment:write` | Push an ERP / fleet calendar's blocks onto one of your listings (replaces the previously synced blocks) |

**Remote sessions (Robotics & AI):**

| Tool | Required scope | What it does |
|---|---|---|
| `rigshare_start_session` | `sessions:write` | Create + start a remote session on a CONFIRMED booking; returns the one-time access token and connect handoff. A repeat call while the session is live returns that session. Needs the rental agreement signed by both parties; MFA-protected listings must be started from the web/mobile app |
| `rigshare_get_session` | `sessions:read` | Status, health, usage, metered budget vs billed, latest telemetry |
| `rigshare_get_session_usage` | `sessions:read` | Live budget snapshot for a METERED booking |
| `rigshare_extend_session` | `sessions:write` | Raise the authorized budget (money path — confirm with the renter). Needs auto-pay enabled on the key and stays within the key's spend caps |
| `rigshare_end_session` | `sessions:write` | Stop the per-minute meter; settles exact usage |
| `rigshare_list_my_sessions` | `sessions:read` | Active + historical sessions |

Read-only tools hit the public API (100 req/min/IP). Authenticated
tools call the `/api/v1/agent/*` and `/api/v1/*` endpoints using Bearer
auth and respect the API key's scopes and, where set, its spend caps.

## Use cases

**For ML / AI engineers:**
- "Find me the cheapest H100 available this weekend"
- "Are there any A100 80GB setups with SSH access right now?"
- "What's the going rate for inference GPUs on RIGShare?"

**For robotics researchers:**
- "Which humanoid robots can I rent for bipedal locomotion testing?"
- "Show me industrial arms with camera feeds under $200/day"

**For construction contractors:**
- "Find an excavator under 10 tons in Texas"
- "What scissor lifts are available this week in Salinas?"

**For AI procurement agents:**
- "Give me a list of all rentable 3D printers in California, sorted by price"

**For equipment owners (supply-side recruitment):**
- "I have a Unitree G1 humanoid sitting idle — how do I rent it out?"
- "I own a 4x H100 rig — is there a marketplace for this?"
- "We have 3 excavators our crew only uses 60% of the time. Can we rent the rest out?"

For any of these, the agent calls `rigshare_get_owner_onboarding` (optionally with the equipment type) and gets back the full pitch: commission rates, the right signup URL, the step-by-step process, and the division-specific pitch (remote-access for robotics/AI, GPS + insurance for construction).

## Installation

### Claude Desktop

Add to your `claude_desktop_config.json` (Settings → Developer → Edit Config):

```json
{
  "mcpServers": {
    "rigshare": {
      "command": "npx",
      "args": ["-y", "rigshare-mcp"]
    }
  }
}
```

Restart Claude Desktop. You should see "rigshare" in the 🔌 MCP servers list in the chat input area.

### Cursor

`~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "rigshare": {
      "command": "npx",
      "args": ["-y", "rigshare-mcp"]
    }
  }
}
```

### VS Code (Continue extension)

Add to your Continue config under `mcpServers`:

```json
{
  "rigshare": {
    "command": "npx",
    "args": ["-y", "rigshare-mcp"]
  }
}
```

### Any MCP-compatible agent framework

Launch with stdio transport:

```bash
npx -y rigshare-mcp
```

## Testing locally

```bash
# Clone this repo
git clone https://github.com/RPER2001/rigshare-mcp.git
cd rigshare-mcp

npm install
npm run build

# Run the server (reads MCP protocol on stdin, writes to stdout)
npm start

# Diagnostic output goes to stderr:
# > rigshare-mcp server running on stdio
```

Then point your MCP client at the local build by changing the config:

```json
{
  "mcpServers": {
    "rigshare-local": {
      "command": "node",
      "args": ["/absolute/path/to/rigshare-mcp/dist/index.js"]
    }
  }
}
```

## Environment variables

- `RIGSHARE_API_KEY` — **Optional**. Enables the 16 authenticated tools. Without it, those tools return a descriptive error and the 4 read-only tools still work. Create a key at https://www.rigshare.app/enterprise (API keys need a Pro or Enterprise plan) or email support@rigshare.app.
- `RIGSHARE_BASE` — override the RIGShare host that every API base below derives from. Defaults to `https://www.rigshare.app`.
- `RIGSHARE_API_BASE` — override the public API base URL. Defaults to `https://www.rigshare.app/api/public/v1`.
- `RIGSHARE_AGENT_API_BASE` — override the authenticated agent API base URL. Defaults to `https://www.rigshare.app/api/v1/agent`.
- `RIGSHARE_V1_API_BASE` — override the owner equipment/availability API base URL. Defaults to `https://www.rigshare.app/api/v1`.

### Claude Desktop config with API key

```json
{
  "mcpServers": {
    "rigshare": {
      "command": "npx",
      "args": ["-y", "rigshare-mcp"],
      "env": {
        "RIGSHARE_API_KEY": "rigs_live_..."
      }
    }
  }
}
```

The scope each authenticated tool requires is listed in the tables under
[What it does](#what-it-does). Keys can be scoped narrowly (read-only) or broadly (read+write+booking). A key can also carry an optional per-transaction spend cap and an optional daily spend cap (there is no monthly cap). A new key has neither cap and has auto-pay off; neither is set from the key page, so contact support@rigshare.app about them. Create and revoke keys at https://www.rigshare.app/enterprise.

## How the data flows

```
┌────────────────┐  MCP stdio   ┌────────────────┐  HTTPS   ┌────────────────────────────┐
│ Claude Desktop │ ◄──────────► │  rigshare-mcp  │ ───────► │  rigshare.app/api/public/v1 │
│  / Cursor /    │              │   (this pkg)   │          │  (read-only, rate-limited)  │
│  VS Code / ... │              └────────────────┘          └────────────────────────────┘
└────────────────┘
```

The read-only tools use no auth, cookies or user accounts — the agent reads
the same data you'd see browsing rigshare.app publicly. The authenticated
tools call the agent and owner endpoints (`/api/v1/agent/*`, `/api/v1/*`)
with your API key.

## Write operations

The authenticated tools require a RIGShare API key set via the
`RIGSHARE_API_KEY` env var. Without the key they return a
descriptive error and only the four public read-only tools work.

Create an API key at https://www.rigshare.app/enterprise (API keys need
a Pro or Enterprise plan) or email support@rigshare.app. Keys are scoped
(`equipment:read`, `equipment:write`, `bookings:read`, `bookings:write`,
`sessions:read`, `sessions:write`) and can carry an optional
per-transaction spend cap and an optional daily spend cap. A booking is
checked against them before sales tax is added. A new key has neither.

**The human stays in the loop for money.** A booking created by an
agent is paid by the renter at the booking URL: right away on an
instant-book listing, after the owner approves on a request-to-book
listing. The exception is auto-pay: when it is enabled on the key, an
instant-book booking is paid with the renter's saved card as it is
created (a per-minute listing's budget is authorized as a card hold).
Auto-pay is off on a new key, and extending a session's budget needs
it. A listing is published only after the owner completes identity
verification and payout setup in the app; a remote session on
MFA-protected equipment must be started from the web or mobile app.
`rigshare_get_booking` always tells the agent who has to act next.

**Start times for short rentals.** For `FOUR_HOURS` bookings send
`start_date` / `end_date` as ISO date-times with a UTC offset in the
equipment's local time; the session must start by 4:00 PM local. A
date-only start is read as UTC midnight: it is usually refused, but in
Pacific time in winter, Alaska and Hawaii it books a four-hour block on
the previous afternoon. `HOURLY` bookings are billed for every started
hour between the two instants, so send real date-times there as well.

The full authenticated-API surface is documented at
https://www.rigshare.app/openapi.json.

## Registry listing

This server is published to the **Official MCP Registry** as
`io.github.RPER2001/rigshare`. Search for it in your MCP client, or
verify directly:

```bash
curl "https://registry.modelcontextprotocol.io/v0.1/servers?search=rigshare"
```

## Contributing

Bug reports and suggestions are welcome — open an issue on this
repository or email support@rigshare.app. This repository is updated
automatically whenever the package changes, so changes are not merged
here directly; accepted fixes arrive in a later update.

## License

MIT. Copyright © 2026 RIGShare LLC.
Contact: support@rigshare.app · https://www.rigshare.app
