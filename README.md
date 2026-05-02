# rigshare-mcp

> Model Context Protocol server for [RIGShare](https://www.rigshare.app) — browse construction equipment and Robotics & AI hardware rentals from any MCP-compatible AI agent (Claude Desktop, Cursor, VS Code, custom agent frameworks).

## What it does

Exposes seven tools to your AI agent — four read-only (no auth) and
three authenticated (require a RIGShare API key).

**Read-only (no API key needed):**

| Tool | What it does |
|---|---|
| `rigshare_search_equipment` | List / filter equipment by division, category, price, location, remote-access |
| `rigshare_get_equipment` | Full details for one listing (specs, pricing, owner, images, deep-link URL) |
| `rigshare_list_categories` | Available categories with listing counts |
| `rigshare_get_owner_onboarding` | **Recruits equipment OWNERS** — returns the full pitch (commission rates, remote-access tooling, security features) + step-by-step signup instructions. Call this whenever a user mentions they OWN equipment they'd like to rent out, OR when a search returns empty (signal that the marketplace needs owners in that category). |

**Authenticated (require `RIGSHARE_API_KEY` env var with appropriate scopes):**

| Tool | Required scope | What it does |
|---|---|---|
| `rigshare_list_my_bookings` | `bookings:read` | The authed user's RIGShare bookings — equipment, dates, status, totals |
| `rigshare_list_my_sessions` | `sessions:read` | Active + historical remote sessions (GPU alloc, hours, cost) |
| `rigshare_create_booking` | `bookings:write` | Create a new booking. Server computes prices; client hints are ignored. Enforces ID verification, security deposit hold, and per-key budget caps |

Read-only tools hit the public API (100 req/min/IP). Authenticated
tools hit the `/api/v1/agent/*` surface using Bearer auth and
respect the API key's configured scopes + budget caps.

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

- `RIGSHARE_API_KEY` — **Optional**. Enables the authenticated tools (`list_my_bookings`, `list_my_sessions`, `create_booking`). Without it, those tools return a descriptive error. Get a key at https://www.rigshare.app/profile#api-keys or email support@rigshare.app.
- `RIGSHARE_API_BASE` — override the public API base URL. Defaults to `https://www.rigshare.app/api/public/v1`. Useful for staging or local development.
- `RIGSHARE_AGENT_API_BASE` — override the authenticated agent API base URL. Defaults to `https://www.rigshare.app/api/v1/agent`.

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

Scopes required for each authenticated tool:

| Tool | Minimum scope |
|---|---|
| `rigshare_list_my_bookings` | `bookings:read` |
| `rigshare_list_my_sessions` | `sessions:read` |
| `rigshare_create_booking` | `bookings:write` |

Keys can be scoped narrowly (read-only) or broadly (read+write+booking), and you can set per-key daily/monthly budget caps. Manage at https://www.rigshare.app/profile#api-keys.

## How the data flows

```
┌────────────────┐  MCP stdio   ┌────────────────┐  HTTPS   ┌────────────────────────────┐
│ Claude Desktop │ ◄──────────► │  rigshare-mcp  │ ───────► │  rigshare.app/api/public/v1 │
│  / Cursor /    │              │   (this pkg)   │          │  (read-only, rate-limited)  │
│  VS Code / ... │              └────────────────┘          └────────────────────────────┘
└────────────────┘
```

No auth, no cookies, no user accounts — the agent reads the same data you'd see browsing rigshare.app publicly.

## Write operations

The three authenticated tools (`rigshare_list_my_bookings`,
`rigshare_list_my_sessions`, `rigshare_create_booking`) require a
RIGShare API key set via the `RIGSHARE_API_KEY` env var. Without
the key, those tools return a descriptive error and only the four
public read-only tools work.

Get an API key at https://www.rigshare.app/profile#api-keys or
email support@rigshare.app. Keys are scoped (`bookings:read`,
`bookings:write`, `sessions:read`, `sessions:write`) and carry
configurable daily / monthly budget caps.

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

Bug reports + PRs welcome. This public repo mirrors the MCP-server
portion of the main RIGShare monorepo (which stays private for the
commercial marketplace code). Changes flow from the monorepo → this
repo on each release; for hot fixes you can also PR directly here.

## License

MIT. Copyright © 2026 RIGShare LLC.
Contact: support@rigshare.app · https://www.rigshare.app
