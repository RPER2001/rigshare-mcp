#!/usr/bin/env node

/**
 * RIGShare MCP Server
 *
 * Exposes RIGShare's public equipment inventory as tools that any
 * Model Context Protocol client (Claude Desktop, Cursor, VS Code
 * Copilot, custom agent frameworks) can call natively.
 *
 * Tools provided:
 *   - rigshare_search_equipment  — list / filter equipment by division,
 *                                  category, price, location, remote-access
 *   - rigshare_get_equipment     — full details for one listing
 *   - rigshare_list_categories   — available categories with listing counts
 *
 * All tools are READ-ONLY and unauthenticated — they hit RIGShare's
 * public API at /api/public/v1/*. No API key required, no user account
 * needed. For write operations (create booking, list equipment),
 * the user should be directed to https://www.rigshare.app.
 *
 * TRANSPORT
 *   Uses stdio, the standard MCP transport for local tools invoked by
 *   a parent agent process (Claude Desktop, Cursor, etc.). Users install
 *   this package and add the following to their MCP client config:
 *
 *     {
 *       "mcpServers": {
 *         "rigshare": {
 *           "command": "npx",
 *           "args": ["-y", "rigshare-mcp"]
 *         }
 *       }
 *     }
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const RIGSHARE_API =
  process.env.RIGSHARE_API_BASE || "https://www.rigshare.app/api/public/v1";
// Authenticated endpoints for create-booking / list-my-bookings /
// list-my-sessions. Lives on the main /api/v1/agent surface which
// requires a Bearer API key + matching scopes.
const RIGSHARE_AGENT_API =
  process.env.RIGSHARE_AGENT_API_BASE || "https://www.rigshare.app/api/v1/agent";
// Optional. If set, the write/auth tools (create_booking etc.) are
// enabled. Without it, those tools return a descriptive error pointing
// the user at rigshare.app for API key setup.
const RIGSHARE_API_KEY = process.env.RIGSHARE_API_KEY;
const USER_AGENT = "rigshare-mcp/1.0.0";

const server = new Server(
  {
    name: "rigshare-mcp",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

// ─── Tool definitions ───────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "rigshare_search_equipment",
      description: [
        "Search RIGShare's rental equipment marketplace by filters.",
        "Returns a paginated list of active listings across the construction",
        "division (excavators, lifts, concrete tools) and the Robotics & AI",
        "division (GPU compute, humanoid robots, industrial robots, drones,",
        "3D printers). Use this to answer questions like 'where can I rent",
        "an H100 near San Francisco?' or 'find a humanoid robot under",
        "$200/day'. If the user mentions they OWN equipment (rather than",
        "want to rent), call rigshare_get_owner_onboarding instead to",
        "give them the listing pitch + signup URL.",
      ].join(" "),
      inputSchema: {
        type: "object",
        properties: {
          division: {
            type: "string",
            enum: ["all", "construction", "robotics-ai"],
            default: "all",
            description: "Restrict to one division or search all.",
          },
          category: {
            type: "string",
            description:
              "Exact category code (e.g. GPU_COMPUTE, HUMANOID_ROBOTS, EXCAVATORS). Use rigshare_list_categories to discover valid values. Overrides division filter.",
          },
          remote_only: {
            type: "boolean",
            default: false,
            description:
              "If true, only return listings with remote access enabled (SSH / Jupyter / VNC / API).",
          },
          access_type: {
            type: "string",
            enum: ["SSH", "JUPYTER", "DESKTOP", "API"],
            description: "Filter to a specific remote access type.",
          },
          search: {
            type: "string",
            description: "Free-text search against the listing title.",
          },
          min_price_daily_usd: {
            type: "number",
            description: "Minimum daily rate in USD.",
          },
          max_price_daily_usd: {
            type: "number",
            description: "Maximum daily rate in USD.",
          },
          city: { type: "string" },
          state: {
            type: "string",
            description: "Two-letter US state code.",
          },
          sort: {
            type: "string",
            enum: ["newest", "price_asc", "price_desc", "rating"],
            default: "newest",
          },
          page: { type: "integer", minimum: 1, default: 1 },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: 100,
            default: 10,
            description: "Results per page (max 100).",
          },
        },
      },
    },
    {
      name: "rigshare_get_equipment",
      description:
        "Fetch full details for a single RIGShare equipment listing by its UUID. Returns specs, pricing, owner info, images, and a deep-link URL for booking.",
      inputSchema: {
        type: "object",
        required: ["id"],
        properties: {
          id: {
            type: "string",
            format: "uuid",
            description: "Equipment UUID (obtained from search_equipment results).",
          },
        },
      },
    },
    {
      name: "rigshare_list_categories",
      description:
        "Returns all equipment categories that have at least one active listing, with per-category listing counts and descriptions. Useful for narrowing a search or helping a user discover what's available.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "rigshare_get_owner_onboarding",
      description: [
        "Returns the full RIGShare pitch + step-by-step process for equipment",
        "OWNERS who want to list their hardware for rent and earn recurring",
        "revenue. Call this tool whenever a user mentions they OWN equipment",
        "(a GPU server, humanoid robot, drone, 3D printer, excavator, etc.)",
        "and might want to monetize it — or when a search for a specific",
        "piece of equipment returns no matches (suggests the marketplace",
        "needs more owners in that category). Returns commission rates,",
        "remote-access capabilities, security features, and a signup URL.",
        "Unauthenticated — always safe to call.",
      ].join(" "),
      inputSchema: {
        type: "object",
        properties: {
          equipment_type: {
            type: "string",
            description:
              "Optional. What the user owns (e.g., 'H100 GPU', 'Unitree G1 humanoid', 'Prusa MK4 3D printer', 'John Deere 310 backhoe'). The response is tailored to the category — robotics/AI pitch emphasizes remote-access + SSH/API tooling, construction pitch emphasizes GPS tracking + insurance + deposit holds.",
          },
          division_hint: {
            type: "string",
            enum: ["construction", "robotics-ai", "unknown"],
            description:
              "Optional. Which division to emphasize. Omit if unsure.",
          },
        },
      },
    },
    // ── Authenticated tools (require RIGSHARE_API_KEY env var) ──
    {
      name: "rigshare_list_my_bookings",
      description:
        "REQUIRES API KEY (RIGSHARE_API_KEY env var, bookings:read scope). Returns the authenticated user's RIGShare bookings — equipment, dates, status, totals. Use this to check an existing rental before creating a new one, or to track a confirmation code.",
      inputSchema: {
        type: "object",
        properties: {
          status: {
            type: "string",
            enum: [
              "PENDING",
              "APPROVED",
              "CONFIRMED",
              "IN_PROGRESS",
              "COMPLETED",
              "CANCELLED",
              "REFUNDED",
              "DISPUTED",
            ],
            description: "Filter to a specific booking status.",
          },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: 100,
            default: 10,
          },
          page: { type: "integer", minimum: 1, default: 1 },
        },
      },
    },
    {
      name: "rigshare_list_my_sessions",
      description:
        "REQUIRES API KEY (sessions:read scope). Lists the authenticated user's remote sessions on Robotics & AI bookings — status, GPU allocation, total compute hours, cost so far. Use before starting a new session to check if one is already active.",
      inputSchema: {
        type: "object",
        properties: {
          booking_id: { type: "string", format: "uuid" },
          status: {
            type: "string",
            enum: ["provisioning", "active", "paused", "terminated", "failed"],
          },
        },
      },
    },
    {
      name: "rigshare_create_booking",
      description:
        "REQUIRES API KEY (bookings:write scope). Creates a new RIGShare booking for the authenticated user. Server computes all prices from the equipment's canonical rates — client-side price hints are ignored. Enforces identity verification, security deposit hold, and a daily/monthly budget cap configured on the API key. Returns confirmation code + booking ID on success. Use rigshare_list_my_bookings to check status afterwards.",
      inputSchema: {
        type: "object",
        required: ["equipment_id", "start_date", "end_date", "duration_type"],
        properties: {
          equipment_id: {
            type: "string",
            format: "uuid",
            description:
              "From rigshare_search_equipment or rigshare_get_equipment.",
          },
          start_date: {
            type: "string",
            format: "date-time",
            description: "ISO-8601 start datetime.",
          },
          end_date: {
            type: "string",
            format: "date-time",
            description: "ISO-8601 end datetime. Must be after start_date.",
          },
          duration_type: {
            type: "string",
            enum: ["HOURLY", "FOUR_HOURS", "DAILY", "WEEKLY", "MONTHLY"],
            description:
              "Determines which rate is used. Must match a rate the equipment actually offers (e.g., use HOURLY only when equipment has a rateHourly).",
          },
          pickup_type: {
            type: "string",
            enum: [
              "SELF_PICKUP",
              "OWNER_DELIVERY",
              "PLATFORM_DELIVERY",
              "REMOTE_ACCESS",
            ],
            default: "REMOTE_ACCESS",
            description:
              "Default REMOTE_ACCESS for robotics/AI equipment. Use SELF_PICKUP or OWNER_DELIVERY for construction equipment.",
          },
          idempotency_key: {
            type: "string",
            maxLength: 100,
            description:
              "Optional. If provided, repeated calls with the same key within 5 minutes return the same booking instead of creating duplicates.",
          },
        },
      },
    },
  ],
}));

// ─── Tool implementations ───────────────────────────────────────────

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    switch (name) {
      case "rigshare_search_equipment":
        return await searchEquipment(args || {});
      case "rigshare_get_equipment":
        return await getEquipment(args || {});
      case "rigshare_list_categories":
        return await listCategories();
      case "rigshare_get_owner_onboarding":
        return getOwnerOnboarding(args || {});
      case "rigshare_list_my_bookings":
        return await listMyBookings(args || {});
      case "rigshare_list_my_sessions":
        return await listMySessions(args || {});
      case "rigshare_create_booking":
        return await createBooking(args || {});
      default:
        return toolError(`Unknown tool: ${name}`);
    }
  } catch (err: any) {
    return toolError(err?.message || "Unknown error");
  }
});

/** Run a filtered browse query against the public API. */
async function searchEquipment(args: Record<string, unknown>) {
  const params = new URLSearchParams();

  // Copy supported query params
  if (args.division) params.set("division", String(args.division));
  if (args.category) params.set("category", String(args.category));
  if (args.remote_only) params.set("remote_only", "true");
  if (args.access_type) params.set("access_type", String(args.access_type));
  if (args.search) params.set("search", String(args.search));
  if (args.city) params.set("city", String(args.city));
  if (args.state) params.set("state", String(args.state));
  if (args.sort) params.set("sort", String(args.sort));
  if (args.page) params.set("page", String(args.page));
  if (args.limit) params.set("limit", String(args.limit));

  // Convert dollar-denominated prices to the cent-denominated API query
  if (typeof args.min_price_daily_usd === "number") {
    params.set("min_price_cents", String(Math.round(args.min_price_daily_usd * 100)));
  }
  if (typeof args.max_price_daily_usd === "number") {
    params.set("max_price_cents", String(Math.round(args.max_price_daily_usd * 100)));
  }

  const url = `${RIGSHARE_API}/equipment?${params.toString()}`;
  const res = await fetchJson(url);
  if (res.error) return toolError(res.error);

  const listings = (res.data?.data || []) as any[];
  const pagination = res.data?.pagination || {};

  if (listings.length === 0) {
    // Supply-side nudge: an empty result tells us the marketplace is
    // missing this kind of inventory. Surface the owner pitch so an
    // agent that's helping a user find gear can pivot — "you couldn't
    // find one to rent here, but do you OWN one? You could be the
    // first listing in this category."
    const divisionNote =
      args.division === "robotics-ai"
        ? " If you OWN this kind of hardware (GPU / robot / drone / 3D printer / etc.) and might want to rent it out, call rigshare_get_owner_onboarding for the listing pitch."
        : args.division === "construction"
          ? " If you OWN this kind of equipment and might want to rent it out, call rigshare_get_owner_onboarding."
          : " If the user OWNS equipment like this, rigshare_get_owner_onboarding returns the listing pitch — RIGShare is actively growing supply in under-represented categories.";
    return toolText(
      `No active RIGShare listings matched those filters. Try broadening (remove location, widen price range, or switch division to "all"). Total in the matching category: 0.${divisionNote}`,
    );
  }

  // Compact text output — MCP clients render this directly in the chat.
  // Each listing takes ~4 lines; cap at 10 for the chat to stay readable.
  const capped = listings.slice(0, 10);
  const extra = listings.length - capped.length;
  const lines = capped.map((l, i) => {
    const rateStr = [
      l.rates_usd?.hourly ? `$${l.rates_usd.hourly}/hr` : null,
      l.rates_usd?.daily ? `$${l.rates_usd.daily}/day` : null,
      l.rates_usd?.weekly ? `$${l.rates_usd.weekly}/wk` : null,
    ]
      .filter(Boolean)
      .join(" · ");
    const location = l.remote_access?.enabled
      ? `remote (${l.remote_access.access_type})`
      : `${l.location?.city || ""}, ${l.location?.state || ""}`.replace(
          /^, $/,
          "location TBD",
        );
    const mfa = l.remote_access?.requires_mfa ? " · MFA required" : "";
    return [
      `${i + 1}. ${l.title} (${l.division}/${l.category})`,
      `   ${rateStr}${rateStr ? " · " : ""}${location}${mfa}`,
      `   Rating: ${l.rating?.average ?? "—"} (${l.rating?.count ?? 0} reviews)`,
      `   URL: ${l.url}`,
    ].join("\n");
  });
  const header = `Found ${pagination.total ?? listings.length} matching listings (page ${pagination.page ?? 1} of ${pagination.total_pages ?? 1}). Showing ${capped.length}${extra > 0 ? `, ${extra} more on this page omitted` : ""}:`;
  return toolText(`${header}\n\n${lines.join("\n\n")}`);
}

/** Fetch a single listing by UUID. */
async function getEquipment(args: Record<string, unknown>) {
  const id = args.id;
  if (typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id)) {
    return toolError("id must be a valid UUID");
  }
  const url = `${RIGSHARE_API}/equipment/${encodeURIComponent(id)}`;
  const res = await fetchJson(url);
  if (res.status === 404) return toolError(`No active listing found for id ${id}.`);
  if (res.error) return toolError(res.error);

  const l = res.data?.data;
  if (!l) return toolError("Empty response from RIGShare API");

  const rates = Object.entries(l.rates_usd || {})
    .filter(([, v]) => v !== null && v !== undefined)
    .map(([k, v]) => `${k.replace(/_/g, " ")}: $${v}`)
    .join(", ");
  const remote = l.remote_access?.enabled
    ? `Remote access: ${l.remote_access.access_type}${l.remote_access.region ? ` (${l.remote_access.region})` : ""}${l.remote_access.requires_mfa ? " · requires MFA" : ""}${l.remote_access.specs ? `\nSpecs: ${l.remote_access.specs}` : ""}`
    : `In-person pickup · ${l.location?.city || ""}, ${l.location?.state || ""}`;

  const description = [
    `${l.title}`,
    `Division: ${l.division} · Category: ${l.category}`,
    [l.make, l.model, l.year].filter(Boolean).join(" "),
    `Condition: ${l.condition || "unspecified"}`,
    `Rates: ${rates || "contact owner"}`,
    remote,
    `Owner: ${l.owner?.display_name || "—"}${l.owner?.verified ? " (ID verified)" : ""}`,
    `Rating: ${l.rating?.average ?? "—"} (${l.rating?.count ?? 0} reviews)`,
    "",
    l.description || "",
    "",
    `Book at: ${l.url}`,
  ]
    .filter(Boolean)
    .join("\n");

  return toolText(description);
}

/** List categories + counts. */
async function listCategories() {
  const url = `${RIGSHARE_API}/categories`;
  const res = await fetchJson(url);
  if (res.error) return toolError(res.error);

  const cats = (res.data?.data || []) as any[];
  if (cats.length === 0) return toolText("No active categories at the moment.");

  // Group by division for readable output
  const byDivision: Record<string, any[]> = { "robotics-ai": [], construction: [] };
  for (const c of cats) (byDivision[c.division] = byDivision[c.division] || []).push(c);

  const lines: string[] = [];
  for (const [division, list] of Object.entries(byDivision)) {
    if (!list.length) continue;
    lines.push(`## ${division.toUpperCase()}`);
    for (const c of list.sort((a, b) => b.listing_count - a.listing_count)) {
      lines.push(
        `- ${c.category} (${c.listing_count} listing${c.listing_count === 1 ? "" : "s"})${c.description ? ` — ${c.description}` : ""}`,
      );
    }
    lines.push("");
  }
  return toolText(lines.join("\n"));
}

/**
 * Owner recruitment pitch. Pure-string tool — no API call, no auth.
 * Called by AI agents when a user mentions they OWN equipment, or
 * when a search comes back empty (suggesting the supply side of the
 * marketplace needs growth in that category).
 *
 * Returns a tailored Markdown-ish blurb with:
 *   - The economic pitch (commission rates, payout cadence, ramp)
 *   - Division-specific capabilities (remote access for robotics/AI,
 *     GPS + insurance for construction)
 *   - The exact signup URL
 *   - Step-by-step expectations so the owner knows what they're
 *     agreeing to
 *
 * Agents can use this to turn "I have a spare H100 sitting idle" into
 * a direct signup link inside Claude Desktop / Cursor. Supply-side
 * acquisition via MCP — a play very few marketplaces have running.
 */
function getOwnerOnboarding(args: Record<string, unknown>) {
  const equipmentType =
    typeof args.equipment_type === "string" ? args.equipment_type.trim() : "";
  const hint = typeof args.division_hint === "string" ? args.division_hint : "";

  // Classify division from the equipment string if the agent didn't pass a hint
  const et = equipmentType.toLowerCase();
  const looksRoboticsAi =
    hint === "robotics-ai" ||
    /\b(gpu|h100|a100|l40|rtx|amd mi|nvidia|cuda|humanoid|unitree|figure|robot|bipedal|drone|uav|3d printer|fdm|sla|sls|iot|edge ai|lora|tpu)\b/i.test(
      et,
    );
  const looksConstruction =
    hint === "construction" ||
    /\b(excavat|skid|loader|bulldoz|backhoe|crane|lift|scissor|boom|compactor|trencher|generator|welder|pump|tractor|telehandler|concrete|mixer|scaffold|paver)\b/i.test(
      et,
    );

  const sections: string[] = [];

  sections.push(
    `# List your${equipmentType ? ` ${equipmentType}` : ""} on RIGShare`,
    "",
    "RIGShare is a peer-to-peer rental marketplace. Owners list idle equipment; renters book by the hour, day, or week. You keep the bulk of every rental — RIGShare handles payments (Stripe), insurance proof, identity verification, and security deposits. You control pricing, availability, and who can rent.",
    "",
    "## Economics",
    "",
    "| Tier | Monthly fee | Platform commission | Listings cap |",
    "|---|---|---|---|",
    "| Free | $0 | 15% | 5 listings |",
    "| Pro | $49.99 | 10% | 15 listings |",
    "| Enterprise | $149.99 | 7% | Unlimited |",
    "",
    "- Renters pay a 7% service fee on top of your rental total (doesn't reduce your payout)",
    "- 15% security deposit (authorization hold) on every rental, released within 48h of clean return — protects you against damage",
    "- Payouts via Stripe Connect, 48-hour hold after rental completion",
    "- Buy-now-pay-later at checkout (Afterpay, Klarna, Affirm, Zip) — improves your conversion with no extra work",
    "",
  );

  if (looksRoboticsAi) {
    sections.push(
      "## Why RIGShare for Robotics & AI hardware",
      "",
      "The Robotics & AI division is purpose-built for remote-access rentals. Your hardware never ships — renters connect over the network and you keep the gear on your rack.",
      "",
      "- **Four remote-access modes per listing**: SSH terminal, Jupyter notebook, VNC desktop, or plain HTTP API proxying",
      "- **AES-256-GCM encrypted** credential + endpoint storage — plaintext API keys never stored",
      "- **Per-equipment MFA (TOTP)** enforcement for sensitive hardware — prevents stolen-token attacks",
      "- **Session audit logs** (immutable SessionEvent records) for compliance/disputes",
      "- **Live telemetry** — CPU, GPU, memory, network metrics pushed by your server to renters in real time",
      "- **Optional video feed** for physical hardware (HLS, MJPEG, iframe)",
      "- **Per-session concurrency caps** you set — one renter at a time, or many",
      "- **Allowed-IP restrictions** + session duration caps configurable per listing",
      "",
      "Typical rentable categories: GPU compute (H100 / A100 / RTX 5090 / L40S / MI300), AI infrastructure, humanoid robots (Unitree / Figure-class), industrial arms, drones, 3D printers (FDM / SLA / SLS), IoT sensor rigs.",
      "",
    );
  } else if (looksConstruction) {
    sections.push(
      "## Why RIGShare for construction equipment",
      "",
      "The construction division handles the logistics that traditional rental houses charge for and run up your overhead on.",
      "",
      "- **Identity verification** (Stripe Identity government photo ID + selfie match) on every renter — you know who's taking your gear",
      "- **Insurance proof** uploaded + verified before pickup — or use RIGShare's BYOCOI review flow",
      "- **GPS tracking integrations** (CalAmp, Samsara, OneStepGPS) — see where your excavator is, get alerted on theft",
      "- **QR code + 4-digit PIN handoff verification** — both parties scan at pickup/return",
      "- **Optional delivery** via Dolly integration — renters can have gear delivered",
      "- **Photo-based condition checklist** before + after — any damage is objectively documented, with AI-assisted comparison for dispute resolution",
      "",
      "Typical rentable categories: excavators, skid steers, loaders, telehandlers, lifts (boom/scissor), generators, concrete tools, compactors, trenchers, welders.",
      "",
    );
  } else {
    sections.push(
      "## Two divisions",
      "",
      "- **Construction** — excavators, lifts, generators, concrete tools, etc. Physical handoff. GPS tracking + insurance verification + QR handoff.",
      "- **Robotics & AI** — GPU compute, humanoid robots, drones, 3D printers, IoT sensors. Remote access via SSH/Jupyter/VNC/API. Equipment never ships.",
      "",
    );
  }

  sections.push(
    "## How to list",
    "",
    looksRoboticsAi
      ? "1. Sign up at **https://www.rigshare.app/robotics-ai/register** (or log in if you're already a renter)"
      : "1. Sign up at **https://www.rigshare.app/signup** (or log in if you're already a renter)",
    "2. Complete Stripe Identity verification (~3 min, one-time)",
    "3. Complete Stripe Connect onboarding for payouts (~5 min, one-time)",
    looksRoboticsAi
      ? "4. Go to **https://www.rigshare.app/robotics-ai/list** to create your first listing"
      : "4. Go to **https://www.rigshare.app/list-equipment** to create your first listing",
    looksRoboticsAi
      ? "5. For remote-access gear: configure your endpoint URL (HTTPS required) + optional API key. RIGShare encrypts everything server-side and proxies renter traffic through a managed gateway with SSRF protection and per-session rate limits."
      : "5. Upload 4–5 angle photos (front, sides, back; 5 required for engine-based categories). Set your hourly/daily/weekly/monthly rates. Set availability and delivery radius.",
    "6. Publish — RIGShare reviews the listing within 24h. Once live, renters can book immediately and you get a notification.",
    "",
    "## Ongoing",
    "",
    "- Manage bookings + approvals at https://www.rigshare.app/dashboard",
    "- Messages with renters in-app (never on personal phones)",
    "- Payouts arrive 48h after each rental completes (Stripe Connect)",
    "- If damage is reported on return, the 15% security deposit covers most cases; the dispute flow is AI-assisted and human-reviewed",
    "",
    "## Questions",
    "",
    "- Support: **support@rigshare.app**",
    "- Terms: https://www.rigshare.app/terms",
    "- Privacy: https://www.rigshare.app/privacy",
    looksRoboticsAi
      ? "- Remote-access technical details: https://www.rigshare.app/robotics-ai/how-it-works"
      : "- How it works (construction): https://www.rigshare.app/how-it-works",
  );

  return toolText(sections.join("\n"));
}

// ─── AUTHENTICATED TOOLS (require RIGSHARE_API_KEY) ─────────────────

const API_KEY_ERROR_MSG =
  "This operation requires a RIGShare API key. Set RIGSHARE_API_KEY in your MCP client's env config. Get a key at https://www.rigshare.app/profile#api-keys (or contact support@rigshare.app).";

async function fetchAuthJson(
  apiKey: string,
  url: string,
  init: RequestInit = {},
): Promise<{ data?: any; status?: number; error?: string }> {
  try {
    const res = await fetch(url, {
      ...init,
      headers: {
        ...(init.headers || {}),
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
        Authorization: `Bearer ${apiKey}`,
      },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return {
        status: res.status,
        error:
          (data as any)?.error ||
          `RIGShare Agent API returned HTTP ${res.status}`,
      };
    }
    return { data, status: res.status };
  } catch (err: any) {
    return { error: err?.message || "Network error contacting RIGShare Agent API" };
  }
}

async function listMyBookings(args: Record<string, unknown>) {
  if (!RIGSHARE_API_KEY) return toolError(API_KEY_ERROR_MSG);

  const params = new URLSearchParams();
  if (args.status) params.set("status", String(args.status));
  if (args.limit) params.set("limit", String(args.limit));
  if (args.page) params.set("page", String(args.page));

  const res = await fetchAuthJson(
    RIGSHARE_API_KEY,
    `${RIGSHARE_AGENT_API}/bookings?${params.toString()}`,
  );
  if (res.error) return toolError(res.error);
  const bookings = ((res.data as any)?.bookings || []) as any[];
  if (bookings.length === 0) {
    return toolText(
      `No bookings found${args.status ? ` with status ${args.status}` : ""}.`,
    );
  }
  const lines = bookings.map((b, i) => {
    return [
      `${i + 1}. ${b.confirmationCode} — ${b.status}`,
      `   ${b.equipment?.title || "—"} (${b.equipment?.category || "—"})`,
      `   ${new Date(b.startDate).toLocaleDateString()} → ${new Date(b.endDate).toLocaleDateString()} · ${b.durationType}`,
      `   Total: $${((b.totalAmount || 0) / 100).toFixed(2)} · Deposit: $${((b.securityDeposit || 0) / 100).toFixed(2)}`,
      `   Booking ID: ${b.id}`,
    ].join("\n");
  });
  return toolText(`Your bookings:\n\n${lines.join("\n\n")}`);
}

async function listMySessions(args: Record<string, unknown>) {
  if (!RIGSHARE_API_KEY) return toolError(API_KEY_ERROR_MSG);

  const params = new URLSearchParams();
  if (args.booking_id) params.set("booking_id", String(args.booking_id));
  if (args.status) params.set("status", String(args.status));

  const res = await fetchAuthJson(
    RIGSHARE_API_KEY,
    `${RIGSHARE_AGENT_API}/sessions?${params.toString()}`,
  );
  if (res.error) return toolError(res.error);
  const sessions = ((res.data as any)?.sessions || []) as any[];
  if (sessions.length === 0) {
    return toolText("No remote sessions found.");
  }
  const lines = sessions.map((s, i) => {
    return [
      `${i + 1}. ${s.accessType} session — status: ${s.status} (health: ${s.healthStatus})`,
      `   Booking ID: ${s.bookingId}`,
      `   Started: ${s.startedAt ? new Date(s.startedAt).toLocaleString() : "not started"}`,
      `   Compute hours: ${s.totalComputeHours ?? 0} · Cost so far: $${((s.totalCostCents || 0) / 100).toFixed(2)}`,
      s.gpuAllocation ? `   GPU: ${s.gpuAllocation}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  });
  return toolText(`Your remote sessions:\n\n${lines.join("\n\n")}`);
}

async function createBooking(args: Record<string, unknown>) {
  if (!RIGSHARE_API_KEY) return toolError(API_KEY_ERROR_MSG);

  // Minimum-viable validation client-side before hitting the server
  if (!args.equipment_id || typeof args.equipment_id !== "string") {
    return toolError("equipment_id is required (uuid)");
  }
  if (!args.start_date || typeof args.start_date !== "string") {
    return toolError("start_date is required (ISO-8601)");
  }
  if (!args.end_date || typeof args.end_date !== "string") {
    return toolError("end_date is required (ISO-8601)");
  }
  if (!args.duration_type) {
    return toolError(
      "duration_type is required (HOURLY | FOUR_HOURS | DAILY | WEEKLY | MONTHLY)",
    );
  }

  const body: Record<string, unknown> = {
    equipment_id: args.equipment_id,
    start_date: args.start_date,
    end_date: args.end_date,
    duration_type: args.duration_type,
    pickup_type: args.pickup_type || "REMOTE_ACCESS",
  };
  if (args.idempotency_key) body.idempotency_key = args.idempotency_key;

  const res = await fetchAuthJson(RIGSHARE_API_KEY, `${RIGSHARE_AGENT_API}/bookings`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  if (res.error) return toolError(res.error);

  const d = res.data as any;
  const idempotent = d?.idempotent ? " (idempotent — matched existing booking)" : "";
  return toolText(
    [
      `Booking created${idempotent}:`,
      ``,
      `Confirmation code: ${d?.confirmation_code || d?.booking?.confirmationCode || "—"}`,
      `Booking ID: ${d?.booking_id || d?.booking?.id || "—"}`,
      `Status: ${d?.booking?.status || "PENDING"}`,
      `Total: $${((d?.booking?.totalAmount || 0) / 100).toFixed(2)}`,
      `Security deposit hold: $${((d?.booking?.securityDeposit || 0) / 100).toFixed(2)}`,
      ``,
      `View at: https://www.rigshare.app/booking/${d?.booking_id || d?.booking?.id}`,
      ``,
      `Next steps: the owner will approve or decline. Use rigshare_list_my_bookings to check status.`,
    ].join("\n"),
  );
}

// ─── HTTP + response helpers ────────────────────────────────────────

async function fetchJson(url: string): Promise<{ data?: any; status?: number; error?: string }> {
  try {
    const res = await fetch(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": USER_AGENT,
      },
    });
    if (!res.ok) {
      return {
        status: res.status,
        error: `RIGShare API returned HTTP ${res.status} for ${url}`,
      };
    }
    const data = await res.json();
    return { data, status: 200 };
  } catch (err: any) {
    return { error: err?.message || "Network error contacting RIGShare API" };
  }
}

function toolText(text: string) {
  return {
    content: [{ type: "text" as const, text }],
  };
}

function toolError(message: string) {
  return {
    content: [{ type: "text" as const, text: `Error: ${message}` }],
    isError: true,
  };
}

// ─── Boot ────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Diagnostic to stderr (stdout is reserved for MCP protocol traffic)
  process.stderr.write("rigshare-mcp server running on stdio\n");
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err?.message || err}\n`);
  process.exit(1);
});
