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

// Single source of truth for the RIGShare host. Every API base derives from
// it, so pointing the server at staging/self-hosted is one env var. Trailing
// slashes are tolerated. Default is the production Construction host — Tech
// (tech.rigshare.app) shares the same backend, so this base is correct for
// both divisions.
const RIGSHARE_BASE = (
  process.env.RIGSHARE_BASE || "https://www.rigshare.app"
).replace(/\/+$/, "");
// Public, unauthenticated browse surface (search / get / categories).
const RIGSHARE_API = process.env.RIGSHARE_API_BASE || `${RIGSHARE_BASE}/api/public/v1`;
// Authenticated agent surface for create-booking / list-my-bookings /
// list-my-sessions / start+end-session. Requires a Bearer API key + scopes.
const RIGSHARE_AGENT_API =
  process.env.RIGSHARE_AGENT_API_BASE || `${RIGSHARE_BASE}/api/v1/agent`;
// Owner-side sync surface (equipment create/list) lives at /api/v1, one level
// above the agent namespace. Prefer an explicit override; otherwise, for
// back-compat with pre-1.4.0 configs that only set RIGSHARE_AGENT_API_BASE,
// derive it from that base (strip the trailing /agent); else from RIGSHARE_BASE.
const RIGSHARE_V1_API =
  process.env.RIGSHARE_V1_API_BASE ||
  (process.env.RIGSHARE_AGENT_API_BASE
    ? process.env.RIGSHARE_AGENT_API_BASE.replace(/\/agent\/?$/, "")
    : `${RIGSHARE_BASE}/api/v1`);
// Optional. If set, the write/auth tools (create_booking etc.) are
// enabled. Without it, those tools return a descriptive error pointing
// the user at rigshare.app for API key setup.
const RIGSHARE_API_KEY = process.env.RIGSHARE_API_KEY;
// Keep in sync with package.json "version".
const VERSION = "1.4.0";
const USER_AGENT = `rigshare-mcp/${VERSION}`;

const server = new Server(
  {
    name: "rigshare-mcp",
    version: VERSION,
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
              "Exact category code (e.g. AI_COMPUTE, HUMANOID_ROBOTS, EXCAVATORS). Use rigshare_list_categories to discover valid values. Overrides division filter.",
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
          compute_architecture: {
            type: "string",
            enum: ["CUDA", "ROCM", "APPLE_SILICON", "TPU", "TRAINIUM", "CPU"],
            description:
              "Accelerator family for AI compute listings (mainly AI_COMPUTE). AI frameworks are architecture-locked, so filter to what the workload can run on: CUDA = NVIDIA, ROCM = AMD, APPLE_SILICON, TPU = Google, TRAINIUM = AWS, CPU = no accelerator.",
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
              "RETURN_PENDING",
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
      description: [
        "REQUIRES API KEY (bookings:write scope). Creates a new RIGShare booking",
        "for the authenticated user. Server computes all prices from the",
        "equipment's canonical rates — client-side price hints are ignored.",
        "Enforces identity verification, security deposit hold, and the",
        "daily/monthly budget cap configured on the API key.",
        "METERED listings (billing.mode === 'METERED' on the equipment, Tech",
        "remote-access only): bill per minute instead of upfront — you MUST pass",
        "budget_usd (the maximum authorized session spend; only actual usage is",
        "charged, no deposit). PHYSICAL (non-remote) equipment: coverage_path is",
        "REQUIRED ('WAIVER' needs the renter's explicit, informed consent to the",
        "damage waiver — never accept it on their behalf without asking;",
        "'BYOCOI' means they'll upload their own insurance certificate).",
        "Returns confirmation code + booking ID + payment status on success.",
        "Use rigshare_list_my_bookings to check status afterwards.",
      ].join(" "),
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
              "REMOTE_ACCESS",
            ],
            default: "REMOTE_ACCESS",
            description:
              "Default REMOTE_ACCESS for robotics/AI equipment. Use SELF_PICKUP or OWNER_DELIVERY for construction equipment.",
          },
          budget_usd: {
            type: "number",
            minimum: 0.5,
            maximum: 25000,
            description:
              "REQUIRED for METERED listings; ignored otherwise. Maximum authorized session spend in USD (fees included). Charged only for minutes actually used; a 15-minute warning fires before the budget exhausts and the session can be extended.",
          },
          coverage_path: {
            type: "string",
            enum: ["WAIVER", "BYOCOI"],
            description:
              "REQUIRED for physical (non-remote) equipment. 'WAIVER' = renter accepts RIGShare's damage waiver (get the renter's explicit consent first); 'BYOCOI' = renter brings their own certificate of insurance (uploaded after booking). Remote-access bookings are exempt.",
          },
          waiver_version: {
            type: "string",
            maxLength: 50,
            description:
              "Version string of the waiver the renter accepted (shown on the equipment page / terms). Required when coverage_path is WAIVER.",
          },
          qualification_answers: {
            type: "object",
            additionalProperties: { type: "string", maxLength: 500 },
            description:
              "Renter qualification answers, keyed by question id — required when the equipment's qualification tier demands it (the server error names the missing questions).",
          },
          qualification_version: {
            type: "string",
            maxLength: 50,
            description: "Version of the qualification questionnaire answered.",
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
    {
      name: "rigshare_create_listing",
      description: [
        "REQUIRES API KEY (equipment:write scope). Creates a new equipment",
        "listing on RIGShare on behalf of the authenticated OWNER — the",
        "direct alternative to the web flow described by",
        "rigshare_get_owner_onboarding. Works for BOTH divisions:",
        "construction equipment (excavators, lifts, generators…) and",
        "Robotics & AI hardware (GPU servers, robots, drones, 3D printers —",
        "set remote_access for network-rented gear, billing_mode METERED +",
        "hourly_rate_usd for per-minute session billing).",
        "Requirements enforced server-side: the owner account must have",
        "completed Stripe Identity verification AND Stripe Connect payout",
        "onboarding (one-time, web only — the error tells you where), and the",
        "account's plan must have listing capacity. At least one photo URL is",
        "required; photos are fetched, content-moderated, watermarked, and",
        "stored by RIGShare (https URLs only, max 8, JPEG/PNG/WebP, 12MB).",
        "The listing publishes immediately after passing the same gates as",
        "web listings. Confirm price and details with the owner before",
        "calling — this publishes to a live marketplace.",
      ].join(" "),
      inputSchema: {
        type: "object",
        required: ["title", "description", "category", "make", "model", "year", "condition", "daily_rate_usd", "city", "state", "zip"],
        properties: {
          title: { type: "string", minLength: 5, maxLength: 120 },
          description: {
            type: "string",
            minLength: 10,
            maxLength: 5000,
            description: "Honest, detailed description — specs, condition notes, what's included.",
          },
          category: {
            type: "string",
            description: "Exact category code — use rigshare_list_categories to discover valid values (e.g. AI_COMPUTE, EXCAVATORS).",
          },
          make: { type: "string", maxLength: 80 },
          model: { type: "string", maxLength: 80 },
          year: { type: "integer", minimum: 1950, maximum: 2035 },
          condition: { type: "string", enum: ["EXCELLENT", "GOOD", "FAIR"] },
          daily_rate_usd: { type: "number", minimum: 1, maximum: 100000 },
          hourly_rate_usd: {
            type: "number",
            minimum: 0,
            maximum: 100000,
            description: "Required when billing_mode is METERED (it is the per-minute metering basis).",
          },
          weekly_rate_usd: { type: "number", minimum: 0, maximum: 500000 },
          monthly_rate_usd: { type: "number", minimum: 0, maximum: 2000000 },
          city: { type: "string" },
          state: { type: "string", description: "Two-letter US state code." },
          zip: { type: "string", description: "5-digit US zip code." },
          photos: {
            type: "array",
            minItems: 1,
            maxItems: 8,
            items: {
              type: "object",
              required: ["url"],
              properties: {
                url: { type: "string", format: "uri", description: "Public https image URL (JPEG/PNG/WebP, ≤12MB)." },
                angle: { type: "string", maxLength: 32, description: "Optional label, e.g. 'front', 'side', 'controls'." },
              },
            },
            description: "At least one. Ingested server-side: moderated, watermarked, re-hosted by RIGShare.",
          },
          booking_type: {
            type: "string",
            enum: ["INSTANT", "REQUEST"],
            default: "REQUEST",
            description: "INSTANT = renters book without owner approval; REQUEST = owner approves each booking.",
          },
          remote_access: {
            type: "object",
            description:
              "Robotics & AI categories only — configure how renters connect over the network. When provided, security_ack MUST be true or the listing cannot be published.",
            required: ["security_ack"],
            properties: {
              access_type: { type: "string", enum: ["SSH", "JUPYTER", "DESKTOP", "API"] },
              endpoint: { type: "string", format: "uri", description: "HTTPS endpoint RIGShare proxies renter traffic to (SSRF-validated)." },
              specs: { type: "string", maxLength: 2000, description: "Hardware specs shown to renters (e.g. '8× H100 80GB, 2TB NVMe')." },
              region: { type: "string", maxLength: 100 },
              max_concurrent: { type: "integer", minimum: 1, maximum: 1000 },
              require_mfa: { type: "boolean", description: "Require TOTP MFA from renters before sessions (recommended for sensitive hardware)." },
              security_ack: {
                type: "boolean",
                description:
                  "REQUIRED WHEN remote_access is provided. You attest the endpoint is secured and you accept RIGShare's Terms & Liability Waiver. Required to publish any remote-access listing — the backend hard-rejects a remote create without it.",
              },
            },
          },
          billing_mode: {
            type: "string",
            enum: ["FIXED", "METERED"],
            default: "FIXED",
            description: "METERED = renters pay per minute of session time (remote-access Tech listings only; requires hourly_rate_usd).",
          },
          external_id: {
            type: "string",
            maxLength: 100,
            description: "Optional inventory-system id — future calls with the same external_id update this listing instead of duplicating it.",
          },
        },
      },
    },
    {
      name: "rigshare_start_session",
      description: [
        "REQUIRES API KEY (sessions:write scope). Starts a remote session on a",
        "CONFIRMED Robotics & AI booking (SSH / Jupyter / VNC / API access).",
        "Returns the session access token — shown ONCE, store it securely —",
        "plus the connection URL and allocated specs. For METERED bookings the",
        "per-minute clock runs while the session is active; call",
        "rigshare_end_session (or end the booking) to settle for exact usage.",
        "Equipment that requires MFA cannot be started via API key — the renter",
        "must use the web app.",
      ].join(" "),
      inputSchema: {
        type: "object",
        required: ["booking_id"],
        properties: {
          booking_id: {
            type: "string",
            format: "uuid",
            description: "A CONFIRMED booking id from rigshare_create_booking or rigshare_list_my_bookings.",
          },
        },
      },
    },
    {
      name: "rigshare_end_session",
      description: [
        "REQUIRES API KEY (sessions:write scope). Ends the METERED (per-minute)",
        "billing clock on a Robotics & AI booking that rigshare_start_session",
        "started: the server settles the charge for EXACT usage and releases the",
        "unused portion of the authorized budget. Call this as soon as the renter",
        "is done — otherwise the per-minute meter keeps running until a heartbeat",
        "hard-stop or the budget is exhausted, overcharging the renter. Returns",
        "the final compute hours + settled cost. Idempotent and safe: a booking",
        "whose billing is already settled returns an error, never a double charge",
        "(the server recomputes everything; client amounts are ignored).",
      ].join(" "),
      inputSchema: {
        type: "object",
        required: ["booking_id"],
        properties: {
          booking_id: {
            type: "string",
            format: "uuid",
            description:
              "The METERED booking id whose session clock should be stopped and settled (from rigshare_create_booking or rigshare_list_my_bookings).",
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
      case "rigshare_create_listing":
        return await createListing(args || {});
      case "rigshare_start_session":
        return await startSession(args || {});
      case "rigshare_end_session":
        return await endSession(args || {});
      default:
        return toolError(`Unknown tool: ${name}`);
    }
  } catch (err: any) {
    // Never echo raw internal error text to the model/user — log the full
    // detail to stderr (stdout is reserved for MCP protocol traffic) and
    // return a generic, non-leaky message.
    console.error(
      `[rigshare-mcp] tool "${name}" threw:`,
      err?.stack || err?.message || err,
    );
    return toolError(
      "The RIGShare MCP server hit an unexpected error. Check the server logs (stderr) for details.",
    );
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
  if (args.compute_architecture)
    params.set("compute_architecture", String(args.compute_architecture));
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
  // Render EVERY row this page returned. (Previously we sliced to 10 and said
  // "N more omitted" — but the omitted rows were unreachable: bumping `page`
  // skips them, since page 2 starts after the full server-side `limit`. Now the
  // caller's `limit` alone decides how many come back, and all are shown.)
  const lines = listings.map((l, i) => {
    const rateStr = [
      l.rates_usd?.hourly ? `$${l.rates_usd.hourly}/hr` : null,
      l.rates_usd?.four_hour ? `$${l.rates_usd.four_hour}/4hr` : null,
      l.rates_usd?.daily ? `$${l.rates_usd.daily}/day` : null,
      l.rates_usd?.weekly ? `$${l.rates_usd.weekly}/wk` : null,
      l.rates_usd?.monthly ? `$${l.rates_usd.monthly}/mo` : null,
    ]
      .filter(Boolean)
      .join(" · ");
    const location = l.remote_access?.enabled
      ? `remote (${l.remote_access.access_type})`
      : `${l.location?.city || ""}, ${l.location?.state || ""}`.replace(
          /^, $/,
          "location TBD",
        );
    const arch = l.compute_architecture ? ` · ${l.compute_architecture}` : "";
    const mfa = l.remote_access?.requires_mfa ? " · MFA required" : "";
    const metered =
      l.billing?.mode === "METERED"
        ? " · METERED: billed per minute, booking needs budget_usd"
        : "";
    return [
      `${i + 1}. ${l.title} (${l.division}/${l.category})`,
      `   ${rateStr}${rateStr ? " · " : ""}${location}${arch}${mfa}${metered}`,
      `   Rating: ${l.rating?.average ?? "—"} (${l.rating?.count ?? 0} reviews)`,
      `   URL: ${l.url}`,
    ].join("\n");
  });
  const header = `Found ${pagination.total ?? listings.length} matching listings (page ${pagination.page ?? 1} of ${pagination.total_pages ?? 1}). Showing ${listings.length} on this page:`;
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

  const billing =
    l.billing?.mode === "METERED"
      ? `Billing: METERED — billed per minute of session time at $${l.billing.metered_rate_usd_per_hour ?? "?"}/hr. Booking authorizes a budget (pass budget_usd to rigshare_create_booking); only actual usage is charged, no deposit.`
      : null;

  const description = [
    `${l.title}`,
    `Division: ${l.division} · Category: ${l.category}`,
    [l.make, l.model, l.year].filter(Boolean).join(" "),
    `Condition: ${l.condition || "unspecified"}`,
    `Rates: ${rates || "contact owner"}`,
    billing,
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
    "- Renters pay up to a 7% service fee on top of your rental total (reduced to 3% for verified students) — doesn't reduce your payout",
    "- 15% security-deposit authorization hold (minimum $100) on physical/FIXED rentals, released within 48h of clean return — protects you against damage. METERED per-minute Tech sessions have NO deposit — the renter authorizes a usage budget instead",
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
      "- **Optional owner delivery** — owners can deliver gear to the renter for a fee",
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
    "RIGShare is **draft-first** — start building your listing immediately; no verification is required up front.",
    "",
    looksRoboticsAi
      ? "1. Sign up at **https://www.rigshare.app/robotics-ai/register** (or log in if you already have an account)."
      : "1. Sign up at **https://www.rigshare.app/signup** (or log in if you already have an account).",
    looksRoboticsAi
      ? "2. Start your listing right away at **https://www.rigshare.app/robotics-ai/list** — no verification needed to DRAFT: add your title, rates, photos, and specs. For remote-access gear, configure your endpoint URL (HTTPS required) + optional API key; RIGShare encrypts everything server-side and proxies renter traffic through a managed gateway with SSRF protection and per-session rate limits."
      : "2. Start your listing right away at **https://www.rigshare.app/list-equipment** — no verification needed to DRAFT: add your title, hourly/daily/weekly/monthly rates, photos (front, sides, back; 5 required for engine-based categories), and specs. Set availability and delivery radius.",
    "3. When you hit **Publish**, RIGShare walks you through the one-time setup just-in-time: identity verification (Stripe Identity, ~3 min) and Stripe Connect payout onboarding (~5 min). You only do this once.",
    "4. Publish — your listing goes live, renters can book immediately, and you get a notification on each booking.",
    "",
    "**Listing directly from this chat:** if you have a RIGShare API key with the `equipment:write` scope (create one at https://www.rigshare.app/profile#api-keys), the agent can publish a listing for you right now via the `rigshare_create_listing` tool — title, rates, photos (https URLs), and remote-access config for tech hardware. Note: the direct API path has **no draft step — it publishes immediately**, so for that path your identity verification and Stripe Connect payout setup must already be done once on the web first (the tool's error tells you where if not).",
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
    // The agent API wraps every success payload as { data, success: true }
    // (apiSuccess in app/_lib/api-auth.ts) — unwrap here so tool code reads
    // payload fields directly. Pre-1.2.0 this was NOT unwrapped, which made
    // list_my_bookings / list_my_sessions always report "none found" and
    // create_booking report "—" for every field of a successfully created
    // booking.
    const payload =
      data && typeof data === "object" && "success" in (data as any) && "data" in (data as any)
        ? (data as any).data
        : data;
    return { data: payload, status: res.status };
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
    const isMetered = b.billingMode === "METERED";
    const moneyLine = isMetered
      ? b.meterBilledCents != null
        ? `   Metered (per-minute) · Settled: $${(b.meterBilledCents / 100).toFixed(2)} of $${((b.meterBudgetCents || 0) / 100).toFixed(2)} budget`
        : `   Metered (per-minute) · Budget authorized: $${((b.meterBudgetCents || b.totalAmount || 0) / 100).toFixed(2)} — charged only for minutes used`
      : `   Total: $${((b.totalAmount || 0) / 100).toFixed(2)} · Deposit: $${((b.securityDeposit || 0) / 100).toFixed(2)}`;
    return [
      `${i + 1}. ${b.confirmationCode} — ${b.status}`,
      `   ${b.equipment?.title || "—"} (${b.equipment?.category || "—"})`,
      `   ${new Date(b.startDate).toLocaleDateString()} → ${new Date(b.endDate).toLocaleDateString()} · ${b.durationType}`,
      moneyLine,
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
  // METERED listings: dollars → cents for the authorized session budget.
  if (typeof args.budget_usd === "number") {
    body.meter_budget_cents = Math.round(args.budget_usd * 100);
  }
  // Coverage + qualification passthrough (physical equipment).
  if (args.coverage_path) body.coverage_path = args.coverage_path;
  if (args.waiver_version) body.waiver_version = args.waiver_version;
  if (args.qualification_answers) body.qualification_answers = args.qualification_answers;
  if (args.qualification_version) body.qualification_version = args.qualification_version;

  const res = await fetchAuthJson(RIGSHARE_API_KEY, `${RIGSHARE_AGENT_API}/bookings`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  if (res.error) return toolError(res.error);

  // Response payload is FLAT (apiSuccess envelope already unwrapped by
  // fetchAuthJson): booking_id, confirmation_code, status, total_amount,
  // security_deposit, billing_mode, meter_budget_cents, url, payment{...}.
  const d = (res.data || {}) as any;
  const idempotent = d.idempotent ? " (idempotent — matched existing booking)" : "";
  const bookingId = d.booking_id || "—";
  const viewUrl = d.url || `https://www.rigshare.app/booking/${bookingId}`;
  const isMetered = d.billing_mode === "METERED";

  const moneyLines = isMetered
    ? [
        `Billing: METERED (per minute) — budget authorized: $${((d.meter_budget_cents || d.total_amount || 0) / 100).toFixed(2)}`,
        `You are only charged for minutes used; no security deposit.`,
      ]
    : [
        `Total: $${((d.total_amount || 0) / 100).toFixed(2)}`,
        `Security deposit hold: $${((d.security_deposit || 0) / 100).toFixed(2)}`,
      ];

  const payment = d.payment || {};
  const paymentLine =
    payment.status === "paid"
      ? "Payment: charged via auto-pay — booking is CONFIRMED."
      : payment.status === "authorized"
        ? "Payment: session budget hold authorized via auto-pay — booking is CONFIRMED."
        : payment.status === "failed"
          ? `Payment: auto-pay FAILED — ${payment.error || "complete payment manually"}. The renter must finish checkout at the booking URL.`
          : "Payment: pending — the renter completes checkout after owner approval.";

  return toolText(
    [
      `Booking created${idempotent}:`,
      ``,
      `Confirmation code: ${d.confirmation_code || "—"}`,
      `Booking ID: ${bookingId}`,
      `Status: ${d.status || "PENDING"}`,
      ...(d.idempotent ? [] : [...moneyLines, paymentLine]),
      ``,
      `View at: ${viewUrl}`,
      ``,
      `Next steps: ${d.status === "CONFIRMED" ? "the booking is confirmed" : "the owner will approve or decline"}. Use rigshare_list_my_bookings to check status${isMetered ? ", and rigshare_start_session to begin the remote session" : ""}.`,
    ].join("\n"),
  );
}

/** Create an equipment listing on behalf of the authenticated owner. */
async function createListing(args: Record<string, unknown>) {
  if (!RIGSHARE_API_KEY) return toolError(API_KEY_ERROR_MSG);

  for (const field of ["title", "description", "category", "make", "model", "condition", "city", "state", "zip"]) {
    if (!args[field] || typeof args[field] !== "string") {
      return toolError(`${field} is required (string)`);
    }
  }
  if (typeof args.year !== "number") return toolError("year is required (integer)");
  if (typeof args.daily_rate_usd !== "number") return toolError("daily_rate_usd is required (number)");
  const photos = Array.isArray(args.photos) ? args.photos : [];
  if (photos.length === 0) {
    return toolError("At least one photo is required — pass photos: [{url: 'https://…'}]. RIGShare moderates, watermarks, and re-hosts them.");
  }

  const remote = (args.remote_access || undefined) as Record<string, unknown> | undefined;
  // Remote-access listings are legally un-publishable without the security
  // attestation — the backend hard-rejects a remote create when it's falsy
  // (app/_actions/equipment.ts). Fail fast with an actionable message instead
  // of letting the agent eat an opaque backend 400.
  if (remote && remote.security_ack !== true) {
    return toolError(
      "Remote-access listings require security_ack: true — you attest the endpoint is secured and accept the Terms & Liability Waiver.",
    );
  }
  const body: Record<string, unknown> = {
    title: args.title,
    description: args.description,
    category: args.category,
    make: args.make,
    model: args.model,
    year: args.year,
    condition: args.condition,
    daily_rate: args.daily_rate_usd,
    hourly_rate: args.hourly_rate_usd,
    weekly_rate: args.weekly_rate_usd,
    monthly_rate: args.monthly_rate_usd,
    location: { city: args.city, state: args.state, zip: args.zip },
    photos: photos.map((p: any) => (typeof p === "string" ? { url: p } : { url: p.url, angle: p.angle })),
    booking_type: args.booking_type || "REQUEST",
    billing_mode: args.billing_mode,
    external_id: args.external_id,
    ...(remote
      ? {
          remote_access: {
            enabled: true,
            access_type: remote.access_type,
            endpoint: remote.endpoint,
            specs: remote.specs,
            region: remote.region,
            max_concurrent: remote.max_concurrent,
            require_mfa: remote.require_mfa,
            // Legal attestation — threaded through to remoteSecurityAck on the
            // sync route; the shared core rejects a remote create without it.
            security_ack: remote.security_ack,
          },
        }
      : {}),
  };

  const res = await fetchAuthJson(RIGSHARE_API_KEY, `${RIGSHARE_V1_API}/equipment`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  if (res.error) return toolError(res.error);

  const d = (res.data || {}) as any;
  const eq = d.equipment || {};
  const division = String(args.category).match(/GPU|ROBOTIC|HUMANOID|DRONES_TECH|AI_INFRA|ADDITIVE|IOT/)
    ? "robotics-ai"
    : "construction";
  const listingUrl =
    division === "robotics-ai"
      ? `https://www.rigshare.app/robotics-ai/equipment/${eq.id}`
      : `https://www.rigshare.app/equipment/${eq.id}`;
  const photoNote =
    d.photo_errors && d.photo_errors.length > 0
      ? `\nPhotos: ${d.photos_ingested} ingested, ${d.photo_errors.length} FAILED — ${d.photo_errors.map((e: any) => `${e.url}: ${e.error}`).join("; ")}`
      : `\nPhotos: ${d.photos_ingested ?? eq.photos?.length ?? 0} ingested (moderated + watermarked).`;

  return toolText(
    [
      `Listing created:`,
      ``,
      `Listing ID: ${eq.id || "—"}`,
      `Status: ${eq.status || "ACTIVE"}`,
      `${eq.title || args.title} — $${args.daily_rate_usd}/day${eq.billing_mode === "METERED" ? ` · METERED at $${args.hourly_rate_usd}/hr (billed per minute)` : ""}`,
      photoNote,
      ``,
      `Live at: ${listingUrl}`,
      `Manage at: https://www.rigshare.app/dashboard`,
    ].join("\n"),
  );
}

/** Start a remote session on a confirmed Robotics & AI booking. */
async function startSession(args: Record<string, unknown>) {
  if (!RIGSHARE_API_KEY) return toolError(API_KEY_ERROR_MSG);

  if (typeof args.booking_id !== "string" || !/^[0-9a-f-]{36}$/i.test(args.booking_id)) {
    return toolError("booking_id must be a valid UUID");
  }

  const res = await fetchAuthJson(RIGSHARE_API_KEY, `${RIGSHARE_AGENT_API}/sessions`, {
    method: "POST",
    body: JSON.stringify({ booking_id: args.booking_id }),
  });
  if (res.error) return toolError(res.error);

  const s = (res.data || {}) as any;
  const specs = [
    s.gpu_allocation ? `GPU: ${s.gpu_allocation}` : null,
    s.cpu_cores ? `CPU cores: ${s.cpu_cores}` : null,
    s.ram_gb ? `RAM: ${s.ram_gb} GB` : null,
    s.storage_gb ? `Storage: ${s.storage_gb} GB` : null,
  ].filter(Boolean);

  return toolText(
    [
      `Remote session started:`,
      ``,
      `Session ID: ${s.session_id || "—"}`,
      `Status: ${s.status || "provisioning"}`,
      `Access type: ${s.access_type || "—"}`,
      s.connection_url ? `Connection URL: ${s.connection_url}` : null,
      s.access_token
        ? `Access token (shown ONCE — store it securely, it cannot be retrieved again): ${s.access_token}`
        : null,
      specs.length ? specs.join(" · ") : null,
      ``,
      `If this booking is METERED, the per-minute clock is now running — call rigshare_end_session when done to settle for exact usage.`,
    ]
      .filter((l) => l !== null)
      .join("\n"),
  );
}

/**
 * End a metered booking's per-minute clock and settle for exact usage.
 * Money-safety counterpart to startSession — the server recomputes the charge
 * (client amounts are never trusted) and releases the unused budget.
 */
async function endSession(args: Record<string, unknown>) {
  if (!RIGSHARE_API_KEY) return toolError(API_KEY_ERROR_MSG);

  if (typeof args.booking_id !== "string" || !/^[0-9a-f-]{36}$/i.test(args.booking_id)) {
    return toolError("booking_id must be a valid UUID");
  }

  const res = await fetchAuthJson(
    RIGSHARE_API_KEY,
    `${RIGSHARE_AGENT_API}/bookings/${encodeURIComponent(args.booking_id)}/end`,
    { method: "POST", body: JSON.stringify({}) },
  );
  if (res.error) return toolError(res.error);

  // Response payload is FLAT (envelope unwrapped by fetchAuthJson):
  // booking_id, settled, billed_cents, billed_usd, used_minutes, compute_hours.
  const d = (res.data || {}) as any;
  const billedUsd =
    typeof d.billed_usd === "number" ? d.billed_usd : (d.billed_cents || 0) / 100;
  const computeHours =
    d.compute_hours != null
      ? d.compute_hours
      : d.used_minutes != null
        ? Number((d.used_minutes / 60).toFixed(2))
        : null;

  return toolText(
    [
      `Metered session settled:`,
      ``,
      `Booking ID: ${d.booking_id || args.booking_id}`,
      `Compute hours used: ${computeHours ?? "—"}${d.used_minutes != null ? ` (${d.used_minutes} min)` : ""}`,
      `Settled cost: $${Number(billedUsd).toFixed(2)}`,
      `The per-minute meter has stopped; the unused portion of the authorized budget has been released.`,
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
