#!/usr/bin/env node

/**
 * RIGShare MCP Server
 *
 * Exposes RIGShare's public equipment inventory as tools that any
 * Model Context Protocol client (Claude Desktop, Cursor, VS Code
 * Copilot, custom agent frameworks) can call natively.
 *
 * Read-only tools (no API key; RIGShare's public API at /api/public/v1/*):
 *   - rigshare_search_equipment      — list / filter equipment by division,
 *                                      category, price, location, remote-access
 *   - rigshare_get_equipment         — full details for one listing
 *   - rigshare_list_categories       — available categories with listing counts
 *   - rigshare_get_owner_onboarding  — listing guide for equipment owners
 *
 * 16 more tools (booking, listing, availability and remote sessions) require
 * a RIGSHARE_API_KEY with the matching scopes; they call /api/v1/agent/* and
 * /api/v1/*. The README lists every tool and its scope.
 *
 * RESOURCES:
 *   - rigshare://pricing, rigshare://owner-onboarding — backed by the
 *     public /api/public/v1/policy endpoint, so pricing, fee and onboarding
 *     copy always matches what RIGShare currently publishes
 *   - rigshare://categories — backed by /api/public/v1/categories
 *   - rigshare://terms, rigshare://how-it-works — static URL pointers
 *
 * PROMPTS (guided workflows): rent-gpu, list-my-equipment, check-my-rentals.
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

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The RIGShare host. Every API base derives from it, so pointing the server at
// another environment is one env var. Trailing slashes are tolerated. The
// default serves the API for both divisions (tech.rigshare.app uses the same
// API).
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
const VERSION = "2.1.2";
const USER_AGENT = `rigshare-mcp/${VERSION}`;
// Bounded per-request timeout — a stalled endpoint must never block a tool.
const FETCH_TIMEOUT_MS = 10_000;

const server = new McpServer(
  {
    name: "rigshare-mcp",
    version: VERSION,
  },
  {
    capabilities: {
      tools: {},
      // Resources expose the pricing / onboarding / category / terms copy (see
      // the registerResource calls below). Prompts expose 3 guided workflows
      // (rent-gpu / list-my-equipment / check-my-rentals).
      resources: {},
      prompts: {},
    },
  },
);

// ─── In-memory TTL cache for the public GET surface ─────────────────
// Categories + the /policy copy endpoint change slowly; cache them ~10 min so
// the resources + owner-onboarding tool don't hammer the API on every call.
const PUBLIC_CACHE_TTL_MS = 10 * 60 * 1000;
type FetchResult = {
  data?: any;
  status?: number;
  error?: string;
  code?: string;
  retryable?: boolean;
};
const publicJsonCache = new Map<string, { expires: number; value: FetchResult }>();

// Bundled fallback for the pricing/fee copy. Mirrors the live
// /api/public/v1/policy payload, so the owner-onboarding tool renders identical
// copy whether it read the live endpoint or fell back here. This is ONLY a
// fallback — the live endpoint is authoritative and is what keeps the copy
// current after a price change. When the live payload changes shape or values,
// update this block in the same release, because it is what agents see
// whenever /policy is unreachable.
const BUNDLED_POLICY = {
  version: "bundled",
  commission: { free: 0.15, pro: 0.1, enterprise: 0.07, student: 0.07 },
  renter_service_fee: { standard: 0.07, student: 0.03 },
  // The reduced student rate is not always in effect. The two `student` rates
  // above are what a verified student is charged WHILE it is on; with it off
  // they pay the standard figures. This fallback cannot know which — it renders
  // precisely when /policy is unreachable — so it says so: `null` means
  // UNKNOWN, and no renderer may turn it into "students pay 3%". Never hardcode
  // `true` here to make the copy read better; a 3% promise against a 7%
  // checkout would be wrong.
  student_rate_active: null as boolean | null,
  subscription_prices: {
    pro: { monthly_cents: 4999, yearly_cents: 49900 },
    enterprise: { monthly_cents: 14999, yearly_cents: 149900 },
  },
  // `student: null` — no student-specific listing cap is published. null means
  // "no student-specific cap exists"; it is not zero and must never be rendered
  // as "unlimited".
  listing_caps: { free: 5, pro: 15, enterprise: -1, student: null as number | null },
  // RIGShare holds NO deposit on any new booking. Mirrors the live /policy
  // payload's security_deposit block. `rate`/`min_cents` are kept as keys (0)
  // for older consumers; `tiers` are dormant — no tier is applied to any
  // booking.
  security_deposit: {
    held: false,
    rate: 0,
    min_cents: 0,
    min_usd: 0,
    metered: false,
    owner_selectable: true,
    model: "owner_displayed_not_held",
    display_field: "deposit_display_cents",
    max_pct_of_replacement_value: 10,
    max_cents: 100_000,
    min_display_cents: 2_500,
    requires_replacement_value: true,
    default_tier: "STANDARD_15",
    tiers: [
      { id: "NONE", label: "None", rate: 0, dormant: true },
      { id: "STANDARD_15", label: "Standard", rate: 0, dormant: true },
      { id: "HIGHER_25", label: "Higher", rate: 0, dormant: true },
    ],
    note:
      "RIGShare is a facilitator and holds no deposit funds. The owner states a deposit figure that is " +
      "displayed on the listing and bounded at 10% of the item's replacement value (floor $25, cap $1,000). " +
      "It is never authorized or charged on its own. It caps only what RIGShare collects automatically, and " +
      "RIGShare collects automatically only when the renter explicitly accepts a damage claim. Renter " +
      "silence never moves money; those claims go to owner-renter direct resolution, where the renter's " +
      "liability for actual damage remains full and contractual.",
  },
  // Damage-claim + referral facts (mirrors the live /policy payload's
  // `damage_claims` / `claim_settlement` / `referral_program` keys) so a caller
  // still gets accurate copy even when the live endpoint is unreachable.
  damage_claims: {
    ai_never_charges_alone: true,
    owner_review_required: true,
    cap: "owner_displayed_deposit_figure",
    sanity_ceiling_usd: 100_000,
    owner_review_deadline_hours: 168,
    renter_response_window_hours: 72,
    renter_response_window_note:
      "An explicit accept is the ONLY trigger for collection. On silence RIGShare charges nothing and routes the claim to direct_resolution. An AI plausibility check still runs and is included as evidence in the resolution packet, but it never authorizes a charge.",
    environmental_grime_excluded: true,
    collection: { max_attempts: 1, window_days: 0, requires_explicit_renter_acceptance: true },
    direct_resolution: {
      description:
        "If the approved amount cannot be collected, or a silent claim was not cleared by the plausibility check, RIGShare shares contact info and the evidence between owner and renter, opens a message thread, and stops charging. RIGShare facilitates the transaction and does not adjudicate the claim.",
      on_platform_settlement_available: true,
    },
    renter_booking_gate: {
      block_outstanding_usd: 2_500,
      block_claim_count: 3,
      note:
        "A claim the renter never responded to AND that the AI never cleared as plausible does not count toward this gate.",
    },
  },
  claim_settlement: {
    available: true,
    optional: true,
    methods: ["card", "klarna", "affirm", "zip"],
    partial_payments_allowed: true,
    auto_resolves_on_full_payment: true,
    renter_pays_processing_fee: true,
    owner_receives_full_balance: true,
    fee_disclosure:
      "flat administrative fee, identical on every payment method, itemized before the renter pays; each payment (including each partial payment) carries one fee",
  },
  referral_program: {
    referrer_reward_usd: 50,
    referee_reward_usd: 25,
    qualifying_event: "referred user completes a qualifying rental",
    credit_use: "applied automatically at a future checkout",
    clawback_on_refund_or_chargeback: true,
    abuse_policy: "self-referral and referral farming are prohibited",
    pages: {
      construction: "https://www.rigshare.app/referrals",
      robotics_ai: "https://www.rigshare.app/robotics-ai/referrals",
    },
  },
} as const;
type PolicyDepositTierEntry = { id: string; label: string; rate: number; dormant?: boolean };
type NormalizedPolicy = {
  version: string;
  commission: { free: number; pro: number; enterprise: number; student: number };
  renter_service_fee: { standard: number; student: number };
  /** Tri-state. true = the reduced student rates above are being charged;
   *  false = they are not, and a student pays the standard figures; null =
   *  unknown (the bundled fallback, or a /policy payload predating the field).
   *  Renderers must only make the student claim on `true`. */
  student_rate_active: boolean | null;
  subscription_prices: {
    pro: { monthly_cents: number; yearly_cents: number };
    enterprise: { monthly_cents: number; yearly_cents: number };
  };
  listing_caps: { free: number; pro: number; enterprise: number; student: number | null };
  // `owner_selectable` + `tiers` are optional so an older live payload that
  // predates them still normalizes cleanly and falls back to `rate`. The
  // held/model/display-bound/note keys are optional for the same reason; the
  // bundled fallback always supplies them.
  security_deposit: {
    rate: number;
    min_cents: number;
    min_usd: number;
    metered: boolean;
    owner_selectable?: boolean;
    tiers?: PolicyDepositTierEntry[];
    held?: boolean;
    model?: string;
    display_field?: string;
    max_pct_of_replacement_value?: number;
    max_cents?: number;
    min_display_cents?: number;
    requires_replacement_value?: boolean;
    default_tier?: string;
    note?: string;
  };
};

// Shape of every tool's return payload (a single text block, optionally an
// error) — structurally the MCP CallToolResult content shape. Read tools that
// declare an `outputSchema` also return the normalized object as
// `structuredContent` alongside the text. The SDK skips output validation for
// `isError` results, so error paths may omit it.
type ToolResult = {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

/**
 * Thin wrapper over McpServer.registerTool that preserves the pre-2.0 top-level
 * error behavior: any throw inside a tool handler is logged to stderr (stdout is
 * reserved for MCP protocol traffic) and surfaced to the model as a single
 * generic, non-leaky message — identical to the old CallTool try/catch. Input is
 * auto-validated against `inputSchema` (Zod) before the handler runs.
 */
function registerRigTool(
  name: string,
  config: {
    title: string;
    description: string;
    inputSchema: z.ZodRawShape;
    outputSchema?: z.ZodRawShape;
    annotations: ToolAnnotations;
  },
  handler: (args: Record<string, unknown>) => ToolResult | Promise<ToolResult>,
): void {
  server.registerTool(
    name,
    {
      title: config.title,
      description: config.description,
      inputSchema: config.inputSchema,
      // Only present on the read tools that return conforming
      // structuredContent. Declaring an outputSchema makes the SDK REQUIRE
      // structuredContent on every non-error return path.
      ...(config.outputSchema ? { outputSchema: config.outputSchema } : {}),
      annotations: config.annotations,
    },
    (async (args: Record<string, unknown>) => {
      try {
        return await handler(args || {});
      } catch (err: any) {
        console.error(
          `[rigshare-mcp] tool "${name}" threw:`,
          err?.stack || err?.message || err,
        );
        return toolError(
          "The RIGShare MCP server hit an unexpected error. Check the server logs (stderr) for details.",
        );
      }
    }) as any,
  );
}

// ─── structuredContent output schemas ───────────────────────────────
// Permissive by design: every field is optional/nullish so the parsed upstream
// JSON (returned verbatim as structuredContent) always conforms. The SDK
// validates structuredContent with z.object(shape), which IGNORES unknown keys
// — so extra upstream fields pass through to the client untouched; declaring the
// salient fields just gives agents a documented shape to parse. Only READ tools
// get these (write tools are left text-only to avoid a declared/returned
// mismatch, which the SDK throws on).
const looseRecord = () => z.record(z.any());

const equipmentItemShape = {
  id: z.string().optional(),
  title: z.string().optional(),
  division: z.string().optional(),
  category: z.string().optional(),
  url: z.string().optional(),
  make: z.string().nullish(),
  model: z.string().nullish(),
  year: z.number().nullish(),
  condition: z.string().nullish(),
  description: z.string().nullish(),
  compute_architecture: z.string().nullish(),
  rates_usd: looseRecord().nullish(),
  remote_access: looseRecord().nullish(),
  billing: looseRecord().nullish(),
  rating: looseRecord().nullish(),
  location: looseRecord().nullish(),
  owner: looseRecord().nullish(),
} as const;

const searchOutputSchema = {
  listings: z.array(z.object(equipmentItemShape).passthrough()),
  pagination: z
    .object({
      total: z.number().optional(),
      page: z.number().optional(),
      total_pages: z.number().optional(),
      limit: z.number().optional(),
    })
    .passthrough()
    .optional(),
  total: z.number().optional(),
} as const;

const quoteOutputSchema = {
  billing_mode: z.string().optional(),
  // FIXED-listing breakdown (cents + a `formatted` USD mirror).
  rental_days: z.number().nullish(),
  rental_subtotal_cents: z.number().nullish(),
  delivery_fee_cents: z.number().nullish(),
  service_fee_cents: z.number().nullish(),
  basic_insurance_cents: z.number().nullish(),
  estimated_egress_cents: z.number().nullish(),
  charged_subtotal_cents: z.number().nullish(),
  security_deposit_cents: z.number().nullish(),
  total_amount_cents: z.number().nullish(),
  formatted: looseRecord().nullish(),
  tax: looseRecord().nullish(),
  disclaimer: z.string().nullish(),
  // METERED-listing budget shape.
  rate_hourly_cents: z.number().nullish(),
  rate_hourly_usd: z.string().nullish(),
  min_budget_cents: z.number().nullish(),
  min_budget_usd: z.string().nullish(),
  presets: z.array(looseRecord()).nullish(),
} as const;

const bookingsOutputSchema = {
  bookings: z.array(looseRecord()),
} as const;

const sessionsOutputSchema = {
  sessions: z.array(looseRecord()),
} as const;

const usageOutputSchema = {
  booking_id: z.string().optional(),
  finalized: z.boolean().nullish(),
  billedCents: z.number().nullish(),
  budgetCents: z.number().nullish(),
  usageCents: z.number().nullish(),
  serviceFeeCents: z.number().nullish(),
  totalCents: z.number().nullish(),
  rateHourlyCents: z.number().nullish(),
  usedMinutes: z.number().nullish(),
  remainingMinutes: z.number().nullish(),
  hasActiveSession: z.boolean().nullish(),
  lowBudget: z.boolean().nullish(),
  extensionOptions: z.array(looseRecord()).nullish(),
} as const;

const availabilityOutputSchema = {
  external_id: z.string().optional(),
  equipment_id: z.string().nullish(),
  blocks: z.array(looseRecord()).optional(),
  requested_range: z
    .object({
      starts_at: z.string().optional(),
      ends_at: z.string().optional(),
      available: z.boolean().optional(),
    })
    .nullish(),
} as const;

// Parameter descriptions shared by rigshare_quote_booking and
// rigshare_create_booking, which take the same booking inputs.
const BOOKING_PARAM_DOCS = {
  equipment_id: "Listing UUID.",
  start_date:
    "ISO 8601 date or date-time. A date alone is read as UTC midnight (the previous afternoon or evening in US time zones), so for HOURLY and FOUR_HOURS send a date-time with a UTC offset in the equipment's local time, e.g. 2026-09-15T08:00:00-05:00.",
  end_date: "ISO 8601 date or date-time, after start_date. Same format rules as start_date.",
  duration_type:
    "Pricing unit. HOURLY bills every started hour between start and end; FOUR_HOURS bills 4-hour blocks and must start by 4:00 PM equipment-local time; DAILY bills per day; WEEKLY per started 7 days; MONTHLY per started 30 days.",
  pickup_type:
    "SELF_PICKUP, or OWNER_DELIVERY (adds the owner's delivery fee). rigshare_create_booking refuses OWNER_DELIVERY on a listing that does not offer delivery and on any remote-access listing; rigshare_quote_booking does not check this, so a quote can succeed for a booking that will be refused. Omitted = REMOTE_ACCESS, which is treated as self pickup; whether a booking is remote comes from the listing itself.",
  budget_usd:
    "METERED listings only, and required for them: the maximum session spend to authorize, in USD, fees included. Only the minutes actually used are charged. rigshare_quote_booking returns the minimum budget and presets.",
  coverage_path:
    "Required for physical (non-remote) equipment. WAIVER = the renter accepts RIGShare's Liability Acknowledgment Waiver (only with the renter's explicit, informed consent); BYOCOI = the renter will provide their own certificate of insurance.",
  waiver_version: "Version of the waiver the renter accepted. Omit to use the current version.",
  qualification_answers:
    "Answers to the renter-qualification questionnaire, required only when the listing requires renter qualification. The questionnaire is not available through this API, so if a booking is refused for qualification the renter must book that listing on the web; retrying here will not get past it.",
  qualification_version: "Version of the questionnaire the answers were given against; must match the current version.",
  idempotency_key:
    "Optional, recommended: a new value for each booking you intend, the same value when retrying it (printable ASCII, up to 100 characters — a UUID works). A request that matches a pending, approved or confirmed booking you created in the last 5 minutes (same equipment, same dates — for a same-day remote session, the same UTC day — same duration type, and the same price, usage budget, compute environment, pickup/delivery choice and coverage choice) is never booked or charged a second time: with the same key, or with no key, you get that booking back, marked idempotent, with its payment state and next action; with a different key it is normally refused with HTTP 409 IDENTICAL_BOOKING_RECENT, which names the existing booking — confirm with the user before booking the same thing again (if the original request's key isn't on record, you get the booking back instead). Reusing a key for a request that doesn't match its booking is refused with HTTP 422 IDEMPOTENCY_KEY_REUSED: check that booking before booking again. For a per-minute (metered) listing, two requests with the same usage budget match whatever their length; a listing that serves one renter at a time has no room for a second same-day session anyway.",
} as const;

// Every category a listing may use (the server rejects any other value).
// rigshare_list_categories only returns the ones that currently have listings.
const LISTING_CATEGORIES = [
  "EXCAVATORS", "LOADERS_SKID_STEERS", "CRANES_LIFTS", "EARTHMOVING", "COMPACTION",
  "PAVEMENT_HIGHWAY", "TRAILERS", "GENERATORS_POWER", "AIR_PUMPS", "CONCRETE_MASONRY",
  "TRENCHING_BORING", "WELDING_METALWORK", "POWER_TOOLS", "OIL_GAS", "DRONES_TECH",
  "SCAFFOLDING_ACCESS", "MOWERS_LANDSCAPING", "FARMING", "UTV", "TELEHANDLER",
  "TREE_CARE", "FORESTRY", "DUMPSTERS", "ATTACHMENTS", "ROBOTICS_AI", "AI_COMPUTE",
  "AI_INFRASTRUCTURE", "ADDITIVE_MANUFACTURING", "IOT_SENSORS", "HUMANOID_ROBOTS", "OTHER",
] as const;

// The categories whose listing pages live under /robotics-ai/.
const ROBOTICS_AI_CATEGORIES: ReadonlySet<string> = new Set([
  "AI_COMPUTE", "AI_INFRASTRUCTURE", "ROBOTICS_AI", "HUMANOID_ROBOTS",
  "ADDITIVE_MANUFACTURING", "IOT_SENSORS", "DRONES_TECH",
]);

// Parameter descriptions shared by rigshare_create_listing and
// rigshare_save_draft_listing.
const LISTING_PARAM_DOCS = {
  category:
    "Listing category. Remote access is available only for AI_COMPUTE, AI_INFRASTRUCTURE and IOT_SENSORS; robots, drones and 3D printers are physical rentals.",
  hourly_rate_usd: "Hourly rate in USD. Required for billing_mode METERED, where it is the rate the per-minute meter bills at.",
  replacement_value_usd:
    "What the item costs to replace, in USD. Required to publish a physical (non-remote) listing. It bounds the deposit figure the listing may display: 10% of this value, at least $25 and at most $1,000.",
  deposit_display_usd:
    "Deposit figure displayed on the listing, in USD. RIGShare never holds or charges it on its own; it is the most RIGShare will collect if a renter expressly accepts a damage claim. 0 = the owner requires no deposit; omit to state no figure. Must be within the bound set by replacement_value_usd. Not used on remote-access listings.",
  state: "Two-letter US state code, e.g. TX.",
  zip: "5-digit or ZIP+4 US postal code.",
  booking_type:
    "REQUEST: the owner approves each booking. INSTANT: renters are confirmed without approval; a physical INSTANT listing needs a street address, which the agent API cannot set.",
  billing_mode:
    "FIXED (default): upfront pricing. METERED: per-minute session billing, for remote-access listings only; requires hourly_rate_usd.",
  remote_access: "Network access for AI compute, AI infrastructure or IoT sensor listings. Omit for physical equipment.",
  remote_endpoint: "https URL of the owner's service that renter sessions connect to.",
  remote_max_concurrent: "Maximum simultaneous renter sessions.",
  remote_require_mfa:
    "Require renters to pass TOTP multi-factor authentication to start a session (default true). Agents cannot start sessions on such listings.",
} as const;

// ─── Tool definitions (registered on the modern McpServer surface) ──────

registerRigTool(
  "rigshare_search_equipment",
  {
    title: "Search equipment",
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
      division: z
        .enum(["all", "construction", "robotics-ai"])
        .optional()
        .describe("Division to search (default all). Ignored when category is set."),
      category: z
        .string()
        .optional()
        .describe(
          "Exact category value, e.g. AI_COMPUTE or EXCAVATORS; rigshare_list_categories returns the values that currently have listings. Overrides division. An unknown value is an error.",
        ),
      remote_only: z
        .boolean()
        .optional()
        .describe("true = only listings rented over the network (AI compute, AI infrastructure and IoT sensor listings)."),
      access_type: z
        .enum(["SSH", "JUPYTER", "DESKTOP", "API"])
        .optional()
        .describe("How renters connect to a remote-access listing; matches remote-access listings only."),
      compute_architecture: z
        .enum(["CUDA", "ROCM", "APPLE_SILICON", "TPU", "TRAINIUM", "CPU"])
        .optional()
        .describe("Accelerator family of an AI compute listing."),
      search: z
        .string()
        .optional()
        .describe("Case-insensitive substring match on the listing title only (not the description, make/model or location)."),
      min_price_daily_usd: z.number().optional().describe("Lower bound on the listing's daily rate, in USD."),
      max_price_daily_usd: z.number().optional().describe("Upper bound on the listing's daily rate, in USD."),
      city: z.string().optional().describe("Exact city name, case-insensitive. There is no radius search."),
      state: z.string().optional().describe("Two-letter US state code, e.g. TX (exact match)."),
      sort: z
        .enum(["newest", "price_asc", "price_desc", "rating"])
        .optional()
        .describe("Default newest. price_asc / price_desc sort by daily rate; rating = highest average rating first."),
      page: z.number().int().min(1).optional().describe("1-based page number (default 1)."),
      limit: z.number().int().min(1).max(100).optional().describe("Results per page (default 25)."),
    },
    outputSchema: searchOutputSchema,
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  searchEquipment,
);

registerRigTool(
  "rigshare_get_equipment",
  {
    title: "Get equipment details",
    description:
      "Fetch full details for a single RIGShare equipment listing by its UUID. Returns specs, pricing, owner info, images, and a deep-link URL for booking. Only ACTIVE listings are returned; a draft, paused or removed listing reads as not found. The structured result carries the owner's displayed deposit as deposit_usd (null = the owner stated no figure, 0 = the owner requires no deposit); RIGShare never holds it, so deposit_held is always false.",
    inputSchema: {
      id: z.string().uuid().describe("Listing UUID (the id field from rigshare_search_equipment)."),
    },
    outputSchema: equipmentItemShape,
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  getEquipment,
);

registerRigTool(
  "rigshare_list_categories",
  {
    title: "List categories",
    description:
      "Returns all equipment categories that have at least one active listing, with per-category listing counts and descriptions. Useful for narrowing a search or helping a user discover what's available. Categories with no active listing are omitted, so this is not the full set of categories a new listing may use.",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  () => listCategories(),
);

registerRigTool(
  "rigshare_get_owner_onboarding",
  {
    title: "Owner onboarding guide",
    description: [
      "Returns RIGShare's guide for equipment OWNERS who want to rent out",
      "their hardware: commission tiers, renter fees, payout timing and the",
      "deposit model (read live from RIGShare's published policy, with a",
      "bundled fallback when that is unreachable), division-specific",
      "capabilities, the steps to list, and the signup URL. Use it when the",
      "user owns equipment (a GPU server, humanoid robot, drone, 3D printer,",
      "excavator, etc.) and is considering renting it out. No API key needed;",
      "read-only.",
    ].join(" "),
    inputSchema: {
      equipment_type: z
        .string()
        .optional()
        .describe("Free-text description of the owner's equipment, e.g. \"H100 server\" or \"mini excavator\"; used to pick the division-specific section."),
      division_hint: z
        .enum(["construction", "robotics-ai", "unknown"])
        .optional()
        .describe("Set when the division is known; otherwise it is inferred from equipment_type."),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  getOwnerOnboarding,
);

registerRigTool(
  "rigshare_list_my_bookings",
  {
    title: "List my bookings",
    description:
      "REQUIRES API KEY (RIGSHARE_API_KEY env var, bookings:read scope). Returns the bookings in which the authenticated user is the RENTER, newest first — confirmation code, status, equipment, dates, totals, and for METERED bookings the authorized budget and settled amount. Bookings on listings the user owns are not included; read one of those with rigshare_get_booking. Use this to check an existing rental before creating a new one, or to find a booking by confirmation code.",
    inputSchema: {
      status: z
        .enum([
          "PENDING",
          "APPROVED",
          "CONFIRMED",
          "IN_PROGRESS",
          "RETURN_PENDING",
          "COMPLETED",
          "CANCELLED",
          "REFUNDED",
          "DISPUTED",
        ])
        .optional()
        .describe("Only bookings in this status."),
      limit: z.number().int().min(1).max(100).optional().describe("Bookings per page (default 20)."),
      page: z.number().int().min(1).optional().describe("1-based page number (default 1)."),
    },
    outputSchema: bookingsOutputSchema,
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  listMyBookings,
);

registerRigTool(
  "rigshare_list_my_sessions",
  {
    title: "List my sessions",
    description:
      "REQUIRES API KEY (sessions:read scope). Lists remote sessions on Robotics & AI bookings the authenticated user RENTS (the 50 most recent; no paging) — status, health, GPU allocation, total compute hours, cost so far. Use before starting a new session to check if one is already active.",
    inputSchema: {
      booking_id: z.string().uuid().optional().describe("Only sessions on this booking."),
      status: z
        .enum(["provisioning", "active", "paused", "terminated", "failed"])
        .optional()
        .describe("Only sessions in this status."),
    },
    outputSchema: sessionsOutputSchema,
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  listMySessions,
);

registerRigTool(
  "rigshare_quote_booking",
  {
    title: "Quote booking (dry run)",
    description: [
      "REQUIRES API KEY (bookings:read scope). DRY-RUN price quote — computes the",
      "EXACT cost a rigshare_create_booking would charge, but creates nothing and",
      "charges nothing. Call this FIRST, before rigshare_create_booking, to show",
      "the renter the full breakdown and get their consent before any money",
      "moves: rental subtotal, renter service fee (7%, or RIGShare's reduced",
      "verified-student rate where that rate is in effect \u2014 always resolved",
      "server-side, never quoted from here), delivery, coverage/egress, and the",
      "grand total, all in cents",
      "plus formatted USD. NO security deposit is held, authorized, or charged on",
      "any new booking — security_deposit_cents is 0, and deposit_display_cents",
      "is the owner's DISPLAYED figure only (null = owner stated none, 0 = owner",
      "requires none): the ceiling RIGShare would charge ONLY if the renter later",
      "expressly accepts a damage claim; it is never part of the total. Prices",
      "are recomputed server-side from the equipment's canonical rates and the",
      "renter's tier — identical to what booking charges; no client price is",
      "trusted. METERED (per-minute Tech) listings return the per-hour rate, the",
      "minimum session budget, and budget presets instead of a fixed total (no",
      "deposit figure either). Sales tax is added at checkout and not included",
      "in the estimate. Same inputs as rigshare_create_booking minus",
      "idempotency_key.",
    ].join(" "),
    inputSchema: {
      equipment_id: z.string().uuid().describe(BOOKING_PARAM_DOCS.equipment_id),
      start_date: z
        .string()
        .refine((d) => !isNaN(Date.parse(d)), "must be a valid date or date-time")
        .describe(BOOKING_PARAM_DOCS.start_date),
      end_date: z
        .string()
        .refine((d) => !isNaN(Date.parse(d)), "must be a valid date or date-time")
        .describe(BOOKING_PARAM_DOCS.end_date),
      duration_type: z
        .enum(["HOURLY", "FOUR_HOURS", "DAILY", "WEEKLY", "MONTHLY"])
        .describe(BOOKING_PARAM_DOCS.duration_type),
      pickup_type: z
        .enum(["SELF_PICKUP", "OWNER_DELIVERY", "REMOTE_ACCESS"])
        .optional()
        .describe(BOOKING_PARAM_DOCS.pickup_type),
      budget_usd: z.number().min(0.5).max(25000).optional().describe(BOOKING_PARAM_DOCS.budget_usd),
      coverage_path: z.enum(["WAIVER", "BYOCOI"]).optional().describe(BOOKING_PARAM_DOCS.coverage_path),
      waiver_version: z.string().max(50).optional().describe(BOOKING_PARAM_DOCS.waiver_version),
      qualification_answers: z
        .record(z.string().max(500))
        .optional()
        .describe(BOOKING_PARAM_DOCS.qualification_answers),
      qualification_version: z.string().max(50).optional().describe(BOOKING_PARAM_DOCS.qualification_version),
    },
    outputSchema: quoteOutputSchema,
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  quoteBooking,
);

registerRigTool(
  "rigshare_create_booking",
  {
    title: "Create booking",
    description: [
      "REQUIRES API KEY (bookings:write scope). Creates a new RIGShare booking",
      "for the authenticated user. Call rigshare_quote_booking FIRST to preview",
      "the exact cost (dry-run, nothing charged) and confirm it with the renter",
      "before committing money here. Server computes all prices from the",
      "equipment's canonical rates — client-side price hints are ignored.",
      "Enforces identity verification and, when the API key has them, its",
      "per-transaction and daily spend caps (both optional; a new key has",
      "neither, and there is no monthly cap). The caps are checked against",
      "the pre-tax amount, so sales tax can take the charge above them; for a",
      "METERED booking the full budget_usd counts against them.",
      "METERED listings (billing.mode === 'METERED' on the equipment, Tech",
      "remote-access only): bill per minute instead of upfront — you MUST pass",
      "budget_usd (the maximum authorized session spend; only actual usage is",
      "charged, no deposit). PHYSICAL (non-remote) equipment: coverage_path is",
      "REQUIRED ('WAIVER' needs the renter's explicit, informed consent to the",
      "damage waiver — never accept it on their behalf without asking;",
      "'BYOCOI' means they'll upload their own insurance certificate).",
      "START TIME RULE: for FOUR_HOURS bookings pass start_date / end_date as",
      "ISO date-times WITH a UTC offset in the equipment's local time (e.g.",
      "2026-09-15T08:00:00-05:00 → 2026-09-15T12:00:00-05:00); four-hour",
      "sessions must start by 4:00 PM local. A date-only start is read as UTC",
      "midnight, the previous afternoon or evening in the US: it is usually",
      "refused, but where UTC midnight is at or before 4:00 PM local (Pacific",
      "time in winter, Alaska, Hawaii) it books a four-hour block on the",
      "previous afternoon. HOURLY",
      "bookings are billed for every started hour between the two instants,",
      "so send real date-times there too (date-only values are UTC midnights,",
      "so a date-only start and end are billed 24 hours per day between them).",
      "Returns confirmation code + booking ID + payment status + a next_action",
      "(who acts next and the exact URL). A request matched as a duplicate (see",
      "idempotency_key) returns the existing booking, or a 409 when its key differs. An agent",
      "NEVER enters a card. Auto-pay is off on a new API key. With auto-pay",
      "enabled on the key and a saved card, an instant-book listing is paid",
      "when the booking is created (a METERED budget is authorized as a card",
      "hold, not charged). Otherwise the renter pays at the booking URL: right",
      "away for an instant-book listing, and after the owner approves for a",
      "request-to-book listing, where auto-pay never applies. Poll",
      "rigshare_get_booking afterwards.",
    ].join(" "),
    inputSchema: {
      equipment_id: z.string().uuid().describe(BOOKING_PARAM_DOCS.equipment_id),
      start_date: z
        .string()
        .refine((d) => !isNaN(Date.parse(d)), "must be a valid date or date-time")
        .describe(BOOKING_PARAM_DOCS.start_date),
      end_date: z
        .string()
        .refine((d) => !isNaN(Date.parse(d)), "must be a valid date or date-time")
        .describe(BOOKING_PARAM_DOCS.end_date),
      duration_type: z
        .enum(["HOURLY", "FOUR_HOURS", "DAILY", "WEEKLY", "MONTHLY"])
        .describe(BOOKING_PARAM_DOCS.duration_type),
      pickup_type: z
        .enum(["SELF_PICKUP", "OWNER_DELIVERY", "REMOTE_ACCESS"])
        .optional()
        .describe(BOOKING_PARAM_DOCS.pickup_type),
      budget_usd: z.number().min(0.5).max(25000).optional().describe(BOOKING_PARAM_DOCS.budget_usd),
      coverage_path: z.enum(["WAIVER", "BYOCOI"]).optional().describe(BOOKING_PARAM_DOCS.coverage_path),
      waiver_version: z.string().max(50).optional().describe(BOOKING_PARAM_DOCS.waiver_version),
      qualification_answers: z
        .record(z.string().max(500))
        .optional()
        .describe(BOOKING_PARAM_DOCS.qualification_answers),
      qualification_version: z.string().max(50).optional().describe(BOOKING_PARAM_DOCS.qualification_version),
      idempotency_key: z
        .string()
        .max(100)
        .regex(/^[\x20-\x7E]*$/, "printable ASCII only, e.g. a UUID")
        .optional()
        .describe(BOOKING_PARAM_DOCS.idempotency_key),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  createBooking,
);

registerRigTool(
  "rigshare_create_listing",
  {
    title: "Create listing",
    description: [
      "REQUIRES API KEY (equipment:write scope). Creates and immediately",
      "publishes an equipment listing on behalf of the authenticated OWNER —",
      "the one-step alternative to rigshare_save_draft_listing +",
      "rigshare_publish_listing. Works for both divisions: construction",
      "equipment and Robotics & AI hardware. remote_access (network rental)",
      "is accepted only for AI_COMPUTE, AI_INFRASTRUCTURE and IOT_SENSORS;",
      "robots, drones and 3D printers are physical rentals. billing_mode",
      "METERED (per-minute session billing) requires remote_access and",
      "hourly_rate_usd. Requirements enforced server-side: the owner account",
      "must have completed Stripe Identity verification AND Stripe Connect",
      "payout onboarding (one-time, web only — the error tells you where), the",
      "account's plan must have listing capacity, a physical (non-remote)",
      "listing needs replacement_value_usd (refused with",
      "REPLACEMENT_VALUE_REQUIRED otherwise), and at least one photo URL is",
      "required; photos are fetched, content-moderated, watermarked, and",
      "stored by RIGShare (https URLs only, max 8, JPEG/PNG/WebP, 12MB).",
      "If external_id matches a listing you already own, this call UPDATES",
      "that listing's title, description, make/model/year/condition, rates",
      "and replacement value instead of creating a new one; photos, deposit,",
      "location, booking type and remote-access settings are not changed on",
      "that path. Confirm price and details with the owner before calling —",
      "this publishes to a live marketplace.",
    ].join(" "),
    inputSchema: {
      title: z.string().min(5).max(120),
      description: z.string().min(10).max(5000),
      category: z.enum(LISTING_CATEGORIES).describe(LISTING_PARAM_DOCS.category),
      make: z.string().max(80),
      model: z.string().max(80),
      year: z.number().int().min(1950).max(2035),
      condition: z.enum(["EXCELLENT", "GOOD", "FAIR"]),
      daily_rate_usd: z.number().min(1).max(100000),
      hourly_rate_usd: z.number().min(0).max(100000).optional().describe(LISTING_PARAM_DOCS.hourly_rate_usd),
      weekly_rate_usd: z.number().min(0).max(500000).optional(),
      monthly_rate_usd: z.number().min(0).max(2000000).optional(),
      // Bounds mirror the server ($50–$5M).
      replacement_value_usd: z
        .number()
        .min(50)
        .max(5_000_000)
        .optional()
        .describe(LISTING_PARAM_DOCS.replacement_value_usd),
      deposit_display_usd: z.number().min(0).max(1_000).optional().describe(LISTING_PARAM_DOCS.deposit_display_usd),
      city: z.string(),
      state: z.string().describe(LISTING_PARAM_DOCS.state),
      zip: z.string().describe(LISTING_PARAM_DOCS.zip),
      photos: z
        .array(
          z.union([
            z.string().url(),
            z.object({
              url: z.string().url(),
              angle: z.string().max(32).optional(),
            }),
          ]),
        )
        .max(8)
        .optional()
        .describe("1-8 photos as https URLs, or {url, angle} objects where angle labels the shot (e.g. front, side, back). At least one is required."),
      booking_type: z
        .enum(["INSTANT", "REQUEST"])
        .optional()
        .describe(`${LISTING_PARAM_DOCS.booking_type} Default REQUEST.`),
      remote_access: z
        .object({
          access_type: z.enum(["SSH", "JUPYTER", "DESKTOP", "API"]).optional().describe("How renters connect."),
          endpoint: z.string().url().optional().describe(LISTING_PARAM_DOCS.remote_endpoint),
          specs: z.string().max(2000).optional().describe("Hardware specs shown to renters."),
          region: z.string().max(100).optional(),
          max_concurrent: z.number().int().min(1).max(1000).optional().describe(LISTING_PARAM_DOCS.remote_max_concurrent),
          require_mfa: z.boolean().optional().describe(LISTING_PARAM_DOCS.remote_require_mfa),
          security_ack: z
            .boolean()
            .describe(
              "The owner's attestation that the endpoint is secured and that they accept the Terms and Liability Waiver. Must be true to publish; send it only when the owner has actually given it.",
            ),
        })
        .optional()
        .describe(LISTING_PARAM_DOCS.remote_access),
      billing_mode: z.enum(["FIXED", "METERED"]).optional().describe(LISTING_PARAM_DOCS.billing_mode),
      external_id: z
        .string()
        .max(100)
        .optional()
        .describe(
          "Your own inventory/SKU id; rigshare_check_availability and rigshare_sync_availability find the listing by it. If you already own a listing with this external_id, this call updates that listing instead of creating a new one.",
        ),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  createListing,
);

registerRigTool(
  "rigshare_check_availability",
  {
    title: "Check availability",
    description: [
      "REQUIRES API KEY (equipment:read scope). Returns the unavailability",
      "windows (blocked date ranges) RIGShare holds for one of YOUR listings,",
      "identified by its external_id — the inventory/SKU id you listed it under",
      "(via rigshare_create_listing's external_id). Use this to reconcile your",
      "ERP/fleet calendar with RIGShare, or to check whether a date range is",
      "open before pushing new blocks with rigshare_sync_availability. If you",
      "pass starts_at + ends_at, the tool also reports whether that specific",
      "range overlaps a blocked window. NOTE: the endpoint keys ONLY on",
      "external_id (an owner-scoped lookup) — it does not accept an equipment",
      "UUID, and the windows returned are availability blocks, not renter",
      "bookings.",
    ].join(" "),
    inputSchema: {
      external_id: z
        .string()
        .max(120)
        .describe("The inventory/SKU id the listing was created with (rigshare_create_listing's external_id)."),
      starts_at: z
        .string()
        .refine((d) => !isNaN(Date.parse(d)), "must be a valid date or date-time")
        .optional()
        .describe("Start of a range to test against the blocked windows (ISO 8601). Needs ends_at."),
      ends_at: z
        .string()
        .refine((d) => !isNaN(Date.parse(d)), "must be a valid date or date-time")
        .optional()
        .describe("End of the range to test (ISO 8601). Needs starts_at."),
    },
    outputSchema: availabilityOutputSchema,
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  checkAvailability,
);

registerRigTool(
  "rigshare_sync_availability",
  {
    title: "Sync availability",
    description: [
      "REQUIRES API KEY (equipment:write scope). Pushes your ERP/fleet calendar",
      "to RIGShare: marks date ranges UNAVAILABLE on one of your listings so no",
      "new RIGShare booking can be created during them. The listing is",
      "identified by external_id (the inventory/SKU id from",
      "rigshare_create_listing). SNAPSHOT semantics: the blocks you send REPLACE",
      "all previously-synced blocks for that external_id (pass an empty blocks",
      "array to clear them). Windows that overlap an APPROVED, CONFIRMED or",
      "IN_PROGRESS RIGShare booking are rejected and reported back (you can't",
      "retroactively block days already promised to a renter); the other",
      "windows are still applied. Every block must end after it starts and",
      "carry Z or a UTC offset; otherwise the whole sync is refused and nothing",
      "changes. Owner-created blocks set in the RIGShare UI are left untouched.",
      "Returns the applied count + any conflicts.",
    ].join(" "),
    inputSchema: {
      external_id: z
        .string()
        .max(120)
        .describe("The inventory/SKU id the listing was created with (rigshare_create_listing's external_id)."),
      blocks: z
        .array(
          z.object({
            starts_at: z
              .string()
              .datetime({ offset: true, local: true })
              .describe("ISO 8601 date-time the window starts, with Z or a UTC offset (e.g. 2026-09-15T08:00:00-05:00); sent to RIGShare as UTC. A time with neither is refused."),
            ends_at: z
              .string()
              .datetime({ offset: true, local: true })
              .describe("ISO 8601 date-time the window ends, after starts_at. Same format as starts_at."),
            reason: z.string().max(200).optional().describe("Note stored on the block, prefixed \"External sync:\" unless it already starts with \"ERP:\"."),
          }),
        )
        .max(365)
        .describe("The complete set of unavailable windows for this listing; replaces the previously synced set."),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
  syncAvailability,
);

registerRigTool(
  "rigshare_start_session",
  {
    title: "Start remote session",
    description: [
      "REQUIRES API KEY (sessions:write scope). Starts a remote session on a",
      "CONFIRMED or IN_PROGRESS Robotics & AI booking (SSH / Jupyter / VNC /",
      "API access) that the authenticated user rents. Sessions open 15 minutes",
      "before the booking's start time. Returns the session access token —",
      "shown ONCE, store it securely — plus the connection URL and allocated",
      "specs. Calling it again for the same booking while its session is live",
      "returns that session instead of starting a second one; for SSH and API",
      "access that issues a new token and the previous one stops working.",
      "Starting a new session also needs the rental agreement signed by both",
      "renter and owner; the error says who has not signed (they sign on the",
      "booking page on the web). For METERED bookings the per-minute clock",
      "runs while the session is active; call rigshare_end_session (or end the",
      "booking) to settle for exact usage. Equipment that requires MFA cannot",
      "be started via API key — the renter must use the web app.",
    ].join(" "),
    inputSchema: {
      booking_id: z.string().uuid().describe("The booking to start a session on."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  startSession,
);

registerRigTool(
  "rigshare_end_session",
  {
    title: "End remote session",
    description: [
      "REQUIRES API KEY (sessions:write scope). Ends a METERED (per-minute)",
      "Robotics & AI booking that is CONFIRMED or IN_PROGRESS: the server",
      "stops the per-minute billing clock, settles the charge for EXACT usage,",
      "releases the unused portion of the authorized budget, and marks the",
      "booking COMPLETED — no further session can be started on it. Callable",
      "by the booking's renter or the listing's owner. Call this as soon as",
      "the renter is done — otherwise the per-minute meter keeps running until",
      "a heartbeat hard-stop or the budget is exhausted, overcharging the",
      "renter. Returns the final compute hours + settled cost. Safe to retry:",
      "a booking whose billing is already settled returns an error, never a",
      "double charge (the server recomputes everything; client amounts are",
      "ignored). Not for FIXED-price bookings.",
    ].join(" "),
    inputSchema: {
      booking_id: z.string().uuid().describe("The METERED booking to end and settle."),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
  endSession,
);

registerRigTool(
  "rigshare_cancel_booking",
  {
    title: "Cancel booking",
    description: [
      "REQUIRES API KEY (bookings:write scope). MONEY PATH — cancels a booking",
      "the authenticated user rents or owns AND issues any refund per RIGShare's",
      "published cancellation policy. When the listing's owner cancels a",
      "fixed-price booking the renter is refunded in full, and cancelling a still-PENDING request as",
      "the owner declines it (the result reports declined: true). The rules",
      "below apply when the renter cancels.",
      "The refund is computed ENTIRELY server-side from the",
      "booking's canonical charges and how far out the cancellation is (physical:",
      "7+ days 100% / 3-6 days 75% / 1-2 days 50% / same-day 0%, with a 25%",
      "high-value exception on >$5k multi-day rentals; Tech remote-access:",
      "before-session 100% / within first hour 75% / after 0%). The 7% renter",
      "service fee is non-refundable on renter cancellations, EXCEPT the share of",
      "it charged on an owner delivery fee that is itself being refunded: a",
      "booking that ends before pickup is confirmed returns the delivery fee in",
      "full and the service fee charged on it with it. The client CANNOT",
      "dictate the refund amount or the refund rule — the optional reason is",
      "an audit note only.",
      "Bookings made under the current model carry NO deposit hold (RIGShare",
      "holds none), so there is nothing to release; a LEGACY pre-model booking's",
      "real historical hold is released, never captured — the returned deposit",
      "block reports what actually happened (had_hold/disposition). Safe on",
      "terminal state: cancelling an already-cancelled/completed/disputed booking",
      "returns an error, never a double refund. Returns the refund breakdown",
      "(refunded, retained, deposit disposition) and the refund status; a",
      "refund_pending status means a refund may be owed that could not be",
      "issued automatically (including when no charge could be confirmed);",
      "RIGShare staff are alerted and complete it by hand, so the amounts are",
      "not final. For",
      "a METERED session prefer rigshare_end_session (settles exact usage);",
      "cancelling a metered booking with usage settles like an early end.",
    ].join(" "),
    inputSchema: {
      booking_id: z.string().uuid().describe("The booking to cancel."),
      reason: z
        .string()
        .max(500)
        .optional()
        .describe("Free-text note recorded in the audit log. It does not affect the refund."),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
  cancelBooking,
);

registerRigTool(
  "rigshare_extend_session",
  {
    title: "Extend session budget",
    description: [
      "REQUIRES API KEY (sessions:write scope). MONEY PATH — raises the authorized",
      "per-minute budget on a running METERED (per-minute) Robotics & AI session,",
      "so a renter whose budget is about to exhaust can keep going. The server",
      "places an additional authorization hold on the renter's saved card and",
      "raises the budget, computing the amount from the booking's per-minute",
      "rate — the client never sets the charge. Only the booking's RENTER can",
      "extend. Refused (HTTP 403) before any hold is placed when auto-pay is not",
      "enabled on the API key (it is off on a new key; the renter can then extend",
      "from the booking page) or when the extension would exceed the key's",
      "per-transaction or daily spend cap; refused (401) when the key is",
      "invalid, revoked or expired. Choose one of the fixed extension",
      "lengths: 15, 30, or 60 minutes. Only actual usage is ever charged; call",
      "rigshare_end_session when done to settle exact usage and release the unused",
      "budget. Pairs with rigshare_get_session_usage (check remaining budget",
      "first). Returns the added hold and the new total authorized budget. If the",
      "new total cannot be read back it is reported as unknown; the hold was",
      "still placed, so check rigshare_get_session_usage instead of extending",
      "again.",
    ].join(" "),
    inputSchema: {
      booking_id: z.string().uuid().describe("The METERED booking whose running session to extend."),
      additional_minutes: z
        .preprocess((v) => (typeof v === "string" ? Number(v) : v), z.union([z.literal(15), z.literal(30), z.literal(60)]))
        .describe("Minutes of extra budget to authorize at the listing's per-minute rate: 15, 30 or 60."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  extendSession,
);

registerRigTool(
  "rigshare_get_session_usage",
  {
    title: "Get session usage",
    description: [
      "REQUIRES API KEY (sessions:read scope). Live budget snapshot for a METERED",
      "(per-minute) Robotics & AI booking: authorized budget vs. what's been used,",
      "accrued cost so far, a low-budget warning, and the available extension",
      "options. Read-only — moves no money. Call this before a session runs out to",
      "decide whether to rigshare_extend_session. Visible to the booking's renter",
      "or the equipment owner.",
    ].join(" "),
    inputSchema: {
      booking_id: z.string().uuid().describe("The METERED booking to report on."),
    },
    outputSchema: usageOutputSchema,
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  getSessionUsage,
);

registerRigTool(
  "rigshare_save_draft_listing",
  {
    title: "Save draft listing",
    description: [
      "REQUIRES API KEY (equipment:write scope). Saves a HALF-FINISHED equipment",
      "listing as a DRAFT on behalf of the authenticated OWNER — the listing",
      "fields of rigshare_create_listing except photos, external_id and",
      "security_ack, and nothing goes live. Drafts are UNGATED: no",
      "identity verification and no Stripe Connect payout setup are needed to",
      "DRAFT (matching RIGShare's draft-first flow). Those gates — plus at least",
      "one photo — are required only when you PUBLISH (on the web, or with",
      "rigshare_publish_listing). No security_ack is required to draft a remote-",
      "access listing; it's required at publish. Idempotent per draft_session_id:",
      "repeat calls with the same id update the same draft, writing only the",
      "fields you pass and leaving everything else, including photos already",
      "added in the app, as it was. Once the draft is published the id no",
      "longer refers to it, and a save with it starts a new draft. Returns the draft id",
      "+ the draft_session_id to resume it. Use this when the owner isn't verified",
      "yet or wants to finish the listing later. To PUBLISH later the listing",
      "needs at least one camera photo added in the RIGShare app (agents",
      "cannot upload photos). A physical (non-remote) listing needs a",
      "replacement value (replacement_value_usd) to publish — the server",
      "refuses with REPLACEMENT_VALUE_REQUIRED; displaying a deposit above $0",
      "also needs it (DEPOSIT_ABOVE_LIMIT), which caps the figure at 10% of",
      "the value ($25–$1,000, never held). Drafts default to INSTANT booking,",
      "and a physical INSTANT listing also needs a street address to publish,",
      "which is added in the RIGShare app; save booking_type REQUEST to avoid",
      "that. An owner can hold at most 10 drafts. Then call",
      "rigshare_publish_listing.",
    ].join(" "),
    inputSchema: {
      draft_session_id: z
        .string()
        .min(8)
        .max(128)
        .optional()
        .describe(
          "Resume key. Omit on the first save: the server generates one and returns it. Pass that value on every later save to update the same draft until it is published; each save without it creates a new draft.",
        ),
      title: z.string().min(1).max(200).optional(),
      description: z.string().max(5000).optional(),
      category: z.enum(LISTING_CATEGORIES).optional().describe(LISTING_PARAM_DOCS.category),
      make: z.string().max(120).optional(),
      model: z.string().max(120).optional(),
      year: z.number().int().min(1950).max(2035).optional(),
      condition: z.enum(["EXCELLENT", "GOOD", "FAIR"]).optional(),
      daily_rate_usd: z.number().min(0).max(100000).optional(),
      hourly_rate_usd: z.number().min(0).max(100000).optional().describe(LISTING_PARAM_DOCS.hourly_rate_usd),
      weekly_rate_usd: z.number().min(0).max(500000).optional(),
      monthly_rate_usd: z.number().min(0).max(2000000).optional(),
      city: z.string().max(120).optional(),
      state: z.string().optional().describe(LISTING_PARAM_DOCS.state),
      zip: z.string().optional().describe(LISTING_PARAM_DOCS.zip),
      booking_type: z
        .enum(["INSTANT", "REQUEST"])
        .optional()
        .describe(`${LISTING_PARAM_DOCS.booking_type} Drafts default to INSTANT.`),
      billing_mode: z.enum(["FIXED", "METERED"]).optional().describe(LISTING_PARAM_DOCS.billing_mode),
      replacement_value_usd: z
        .number()
        .min(50)
        .max(5_000_000)
        .optional()
        .describe(LISTING_PARAM_DOCS.replacement_value_usd),
      deposit_display_usd: z.number().min(0).max(1_000).optional().describe(LISTING_PARAM_DOCS.deposit_display_usd),
      remote_access: z
        .object({
          access_type: z.enum(["SSH", "JUPYTER", "DESKTOP", "API"]).optional().describe("How renters connect."),
          endpoint: z.string().url().optional().describe(LISTING_PARAM_DOCS.remote_endpoint),
          specs: z.string().max(2000).optional().describe("Hardware specs shown to renters."),
          region: z.string().max(120).optional(),
          max_concurrent: z.number().int().min(1).max(1000).optional().describe(LISTING_PARAM_DOCS.remote_max_concurrent),
          require_mfa: z.boolean().optional().describe(LISTING_PARAM_DOCS.remote_require_mfa),
        })
        .optional()
        .describe(LISTING_PARAM_DOCS.remote_access),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  saveDraftListing,
);

registerRigTool(
  "rigshare_get_booking",
  {
    title: "Get booking status & next step",
    description: [
      "REQUIRES API KEY (bookings:read scope). Returns ONE booking the",
      "authenticated user rents or owns: status, whether payment is settled,",
      "the money snapshot, the active remote session (if any) and — most",
      "useful — next_action: who has to act next (renter / owner / nobody),",
      "a plain-language instruction you can relay verbatim, and the exact URL",
      "where the human does it. Poll this after rigshare_create_booking. For a",
      "request-to-book listing the flow is owner approves → renter pays at the",
      "URL (an agent never enters a card) → booking CONFIRMED → (Tech) start",
      "the remote session. An instant-book listing skips the approval: the",
      "renter pays at the URL right away, unless auto-pay already paid at",
      "creation.",
    ].join(" "),
    inputSchema: {
      booking_id: z.string().uuid().describe("Booking UUID (the booking_id returned by rigshare_create_booking)."),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  getBooking,
);

registerRigTool(
  "rigshare_get_session",
  {
    title: "Get remote session status",
    description: [
      "REQUIRES API KEY (sessions:read scope). Status, health, the server-side",
      "connect handoff URL, usage so far (compute hours, billed minutes, cost),",
      "the metered budget vs billed, and the latest telemetry snapshot (CPU /",
      "GPU / memory / latency / GPU temperature) for ONE remote session on a",
      "booking the authenticated user rents. Telemetry is null until the node",
      "reports — it is never fabricated. The one-time access token is shown",
      "only by rigshare_start_session and is never returned again.",
    ].join(" "),
    inputSchema: {
      session_id: z
        .string()
        .uuid()
        .describe("Session UUID, from rigshare_start_session, rigshare_list_my_sessions or rigshare_get_booking."),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  getSession,
);

registerRigTool(
  "rigshare_publish_listing",
  {
    title: "Publish a draft listing",
    description: [
      "REQUIRES API KEY (equipment:write scope). Flips a DRAFT saved with",
      "rigshare_save_draft_listing to ACTIVE on the marketplace, through the",
      "SAME gate the web and mobile apps use: identity verification, Stripe",
      "Connect payout setup, the tier listing limit, completeness (basics,",
      "rates, location — including a street address for a physical INSTANT",
      "listing — and at least one camera photo added in the RIGShare app),",
      "and content moderation. A physical (non-remote) listing needs a",
      "replacement value to publish (the server refuses with",
      "REPLACEMENT_VALUE_REQUIRED); displaying a deposit above $0 also needs it",
      "(DEPOSIT_ABOVE_LIMIT), which caps the figure at 10% of the value. If a",
      "gate fails you get the failure code back verbatim (ID_NOT_VERIFIED /",
      "STRIPE_CONNECT_REQUIRED / TIER_LIMIT / INCOMPLETE /",
      "REPLACEMENT_VALUE_REQUIRED / DEPOSIT_ABOVE_LIMIT / MODERATION_FLAGGED /",
      "PHOTO_REVIEW_UNAVAILABLE) so you can tell the owner exactly what to",
      "finish on the web. Retrying without that change fails the same way;",
      "the exception is PHOTO_REVIEW_UNAVAILABLE, which means the photos could",
      "not be reviewed: usually a temporary outage, so retry in a few minutes,",
      "but if it keeps failing the owner should replace the photos in the app",
      "or contact support@rigshare.app. Remote-access (Tech) drafts require",
      "security_ack=true (the owner attests the endpoint is secured and accepts",
      "the Terms/Waiver); every listing may carry ownership_ack=true (the owner",
      "attests they own or are authorized to rent the equipment and it is in",
      "safe working condition). Only send an ack the owner has actually given.",
    ].join(" "),
    inputSchema: {
      draft_id: z.string().uuid().describe("The draft_id returned by rigshare_save_draft_listing."),
      security_ack: z
        .boolean()
        .optional()
        .describe("Remote-access drafts: the owner's attestation that the endpoint is secured and that they accept the Terms and Liability Waiver."),
      ownership_ack: z
        .boolean()
        .optional()
        .describe("The owner's attestation that they own or are authorized to rent the equipment and that it is in safe working condition."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  publishListing,
);

// ─── MCP RESOURCES ──────────────────────────────────────────────────
// Backed by RIGShare's public endpoints so the copy stays current.
// `rigshare://pricing` + `rigshare://owner-onboarding` pull
// /api/public/v1/policy; `rigshare://categories` pulls the categories
// endpoint; `rigshare://terms` + `rigshare://how-it-works` are static URL
// pointers to the web pages.

server.registerResource(
  "rigshare-pricing",
  "rigshare://pricing",
  {
    title: "RIGShare pricing & fees (canonical)",
    description:
      "Live commission tiers, renter service fee (including the reduced verified-student rate and `student_rate_active`, which says whether that rate is currently being charged at all), subscription prices, listing caps, security-deposit rules, and cancellation schedules — sourced live from /api/public/v1/policy. Falls back to bundled copy if unreachable, in which case `student_rate_active` is null: unknown, not yes.",
    mimeType: "application/json",
  },
  async (uri) => {
    const raw = await fetchPolicyRaw();
    const payload = raw ?? {
      ...BUNDLED_POLICY,
      source: "bundled-fallback",
      note: "Live /policy endpoint unreachable — bundled pricing/fee copy only (cancellation & onboarding steps omitted).",
    };
    return {
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(payload, null, 2),
        },
      ],
    };
  },
);

server.registerResource(
  "rigshare-owner-onboarding",
  "rigshare://owner-onboarding",
  {
    title: "RIGShare owner onboarding (canonical)",
    description:
      "Draft-first owner onboarding steps + the canonical economics (commission, fees, deposit) an owner sees — sourced from /api/public/v1/policy. Pair with the rigshare_get_owner_onboarding tool for the full division-specific pitch + signup URLs.",
    mimeType: "application/json",
  },
  async (uri) => {
    const raw = await fetchPolicyRaw();
    const policy = coercePolicy(raw);
    const payload = {
      source: raw ? "live" : "bundled-fallback",
      economics: {
        commission: policy.commission,
        renter_service_fee: policy.renter_service_fee,
        subscription_prices: policy.subscription_prices,
        listing_caps: policy.listing_caps,
        security_deposit: policy.security_deposit,
      },
      owner_onboarding_steps:
        raw?.owner_onboarding_steps ??
        "Draft-first: sign up → start your listing (no verification needed to draft) → at Publish, complete one-time identity + Stripe Connect setup → go live. See the rigshare_get_owner_onboarding tool for the full guide.",
      signup: {
        construction: "https://www.rigshare.app/signup",
        robotics_ai: "https://www.rigshare.app/robotics-ai/register",
      },
    };
    return {
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(payload, null, 2),
        },
      ],
    };
  },
);

server.registerResource(
  "rigshare-categories",
  "rigshare://categories",
  {
    title: "RIGShare equipment categories",
    description:
      "All equipment categories with at least one active listing, grouped by division, with per-category listing counts — sourced from /api/public/v1/categories (cached ~10 min).",
    mimeType: "application/json",
  },
  async (uri) => {
    const res = await fetchJsonCached(
      `${RIGSHARE_API}/categories`,
      PUBLIC_CACHE_TTL_MS,
    );
    const payload = res.error
      ? { error: res.error, categories: [] }
      : { categories: (res.data?.data || []) as any[] };
    return {
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(payload, null, 2),
        },
      ],
    };
  },
);

server.registerResource(
  "rigshare-terms",
  "rigshare://terms",
  {
    title: "RIGShare Terms & policies",
    description:
      "Links to the authoritative Terms of Service, Privacy Policy, and Refund & Cancellation policies for both divisions.",
    mimeType: "text/markdown",
  },
  async (uri) => ({
    contents: [
      {
        uri: uri.href,
        mimeType: "text/markdown",
        text: [
          "# RIGShare Terms & Policies",
          "",
          "- Terms of Service: https://www.rigshare.app/terms",
          "- Privacy Policy: https://www.rigshare.app/privacy",
          "- Refund & Cancellation (Construction): https://www.rigshare.app/refund-policy",
          "- Terms of Service (Robotics & AI): https://www.rigshare.app/robotics-ai/terms",
          "- Refund & Cancellation (Robotics & AI): https://www.rigshare.app/robotics-ai/refund-policy",
        ].join("\n"),
      },
    ],
  }),
);

server.registerResource(
  "rigshare-how-it-works",
  "rigshare://how-it-works",
  {
    title: "How RIGShare works",
    description:
      "Links to the 'How it works' pages for renting and listing on each division.",
    mimeType: "text/markdown",
  },
  async (uri) => ({
    contents: [
      {
        uri: uri.href,
        mimeType: "text/markdown",
        text: [
          "# How RIGShare works",
          "",
          "- Construction (renting & listing): https://www.rigshare.app/how-it-works",
          "- Robotics & AI (remote-access sessions): https://www.rigshare.app/robotics-ai/how-it-works",
        ].join("\n"),
      },
    ],
  }),
);

// ─── MCP PROMPTS (guided workflows) ─────────────────────────────────
// Concise templates that reference the REAL tool names so a client can drop the
// user straight into a search→quote→book / onboarding / status flow.

server.registerPrompt(
  "rent-gpu",
  {
    title: "Rent a GPU / compute instance",
    description:
      "Guided flow to find, price (dry-run), and book Robotics & AI compute (GPU / robot / drone) for a workload.",
    argsSchema: {
      workload: z.string().optional(),
      budget: z.string().optional(),
      region: z.string().optional(),
    },
  },
  (args: Record<string, unknown>) => {
    const workload =
      typeof args.workload === "string" && args.workload.trim()
        ? args.workload.trim()
        : "(describe the workload — e.g. LLM fine-tuning, inference, rendering)";
    const budget =
      typeof args.budget === "string" && args.budget.trim() ? args.budget.trim() : "(optional)";
    const region =
      typeof args.region === "string" && args.region.trim() ? args.region.trim() : "(optional)";
    return {
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: [
              "I want to rent GPU / compute on RIGShare's Robotics & AI division.",
              `- Workload: ${workload}`,
              `- Budget: ${budget}`,
              `- Region: ${region}`,
              "",
              "Please:",
              "1. Call rigshare_search_equipment (division: \"robotics-ai\", plus compute_architecture / max_price_daily_usd / city / remote_only filters as relevant) to find matching instances.",
              "2. Call rigshare_get_equipment on the best candidate for full specs, remote-access type, and whether it is METERED (per-minute) billing.",
              "3. Call rigshare_quote_booking to show me the EXACT cost (dry run — nothing is charged) and confirm it with me before booking.",
              "4. Only after I confirm, call rigshare_create_booking. For METERED listings pass budget_usd (my authorized session spend). Then rigshare_start_session to begin, and rigshare_get_session_usage / rigshare_extend_session / rigshare_end_session to track, extend, and settle.",
            ].join("\n"),
          },
        },
      ],
    };
  },
);

server.registerPrompt(
  "list-my-equipment",
  {
    title: "List my equipment on RIGShare",
    description:
      "Guided owner-onboarding flow: pitch → save a draft → publish a listing (construction or Robotics & AI).",
    argsSchema: {
      equipment_type: z.string().optional(),
    },
  },
  (args: Record<string, unknown>) => {
    const et =
      typeof args.equipment_type === "string" && args.equipment_type.trim()
        ? args.equipment_type.trim()
        : "equipment";
    return {
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: [
              `I own ${et} and want to list it on RIGShare to earn rental income.`,
              "",
              "Please:",
              `1. Call rigshare_get_owner_onboarding (equipment_type: "${et}") for the current pitch, commission tiers, and the right signup URL.`,
              "2. If I have a RIGShare API key, call rigshare_save_draft_listing to capture the listing as a draft (no verification needed to draft) — collect title, description, rates, location, replacement value, and (for remote-access gear) remote-access config from me first. Photos can't be sent with a draft; I add at least one camera photo in the RIGShare app.",
              "3. When I'm ready to go live, call rigshare_publish_listing with the draft_id. Identity verification + Stripe Connect payout setup are required once at publish (the tool's error tells me where if they aren't done). If my verification and payout setup are already done and I have photo URLs, rigshare_create_listing publishes in one step instead of the draft flow.",
            ].join("\n"),
          },
        },
      ],
    };
  },
);

server.registerPrompt(
  "check-my-rentals",
  {
    title: "Check my RIGShare rentals & sessions",
    description:
      "Guided status overview: bookings + remote sessions + live metered usage for the authenticated user.",
  },
  () => ({
    messages: [
      {
        role: "user" as const,
        content: {
          type: "text" as const,
          text: [
            "Give me a status overview of my RIGShare activity.",
            "",
            "Please:",
            "1. Call rigshare_list_my_bookings to list my bookings (equipment, dates, status, totals).",
            "2. Call rigshare_list_my_sessions to list my active and past remote sessions.",
            "3. For any METERED booking with a live session, call rigshare_get_session_usage to show remaining budget, and suggest rigshare_extend_session if it's running low.",
          ].join("\n"),
        },
      },
    ],
  }),
);

// ─── Tool implementations ───────────────────────────────────────────

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
    // An empty result means no one lists this kind of equipment yet.
    // Point the agent at the owner pitch in case the user OWNS one and
    // would like to be the first listing in this category.
    const divisionNote =
      args.division === "robotics-ai"
        ? " If you OWN this kind of hardware (GPU / robot / drone / 3D printer / etc.) and might want to rent it out, call rigshare_get_owner_onboarding for the listing pitch."
        : args.division === "construction"
          ? " If you OWN this kind of equipment and might want to rent it out, call rigshare_get_owner_onboarding."
          : " If the user OWNS equipment like this, rigshare_get_owner_onboarding returns the listing pitch — RIGShare is actively growing supply in under-represented categories.";
    return toolData(
      `No active RIGShare listings matched those filters. Try broadening (remove location, widen price range, or switch division to "all"). Total in the matching category: 0.${divisionNote}`,
      { listings: [], pagination, total: (pagination as any).total ?? 0 },
    );
  }

  // Compact text output — MCP clients render this directly in the chat.
  // Render EVERY row this page returned: the caller's `limit` alone decides
  // how many come back (page 2 starts after the full `limit`, so hiding rows
  // here would make them unreachable).
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
  return toolData(`${header}\n\n${lines.join("\n\n")}`, {
    listings,
    pagination,
    total: pagination.total ?? listings.length,
  });
}

/** Fetch a single listing by UUID. */
async function getEquipment(args: Record<string, unknown>) {
  // Zod validated args.id as a UUID before this handler ran.
  const id = args.id as string;
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

  // structuredContent = the parsed upstream listing (passthrough); the SDK
  // ignores the extra keys not declared in equipmentItemShape.
  return toolData(description, l as Record<string, unknown>);
}

/** List categories + counts. Cached ~10 min in-memory. */
async function listCategories() {
  const res = await fetchJsonCached(`${RIGSHARE_API}/categories`, PUBLIC_CACHE_TTL_MS);
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
 * Owner onboarding guide. No auth. Fetches current pricing/onboarding copy
 * from /policy (short TTL cache, bounded timeout) and gracefully falls back to
 * bundled copy if unreachable — so it never blocks or breaks.
 * Called by AI agents when a user mentions they OWN equipment, or
 * when a search comes back empty (no listings in that category yet).
 *
 * Returns a tailored Markdown-ish blurb with:
 *   - The economics (commission rates, fees, payout timing)
 *   - Division-specific capabilities (remote access for robotics/AI,
 *     GPS + insurance for construction)
 *   - The exact signup URL
 *   - Step-by-step expectations so the owner knows what they're
 *     agreeing to
 *
 * Agents can use this to turn "I have a spare H100 sitting idle" into
 * a direct signup link inside their MCP client.
 */
async function getOwnerOnboarding(args: Record<string, unknown>) {
  const equipmentType =
    typeof args.equipment_type === "string" ? args.equipment_type.trim() : "";
  const hint = typeof args.division_hint === "string" ? args.division_hint : "";

  // Read the pricing/fee/commission copy LIVE from the public /policy endpoint,
  // so a price change never leaves this package stale. getPolicy() ALWAYS
  // returns a usable object — on any fetch failure it falls back to
  // BUNDLED_POLICY, so this tool can never break on an unreachable endpoint.
  const policy = await getPolicy();

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
    "RIGShare is a peer-to-peer rental marketplace. Owners list idle equipment; renters book by the hour, day, or week. You keep the bulk of every rental — RIGShare handles payments (Stripe), insurance proof, and identity verification. RIGShare does NOT hold security deposits \u2014 you state a deposit figure that is displayed on your listing and only charged if a renter accepts a damage claim. You control pricing, availability, and who can rent.",
    "",
    // Rendered from the live /policy copy (falls back to bundled values).
    ...renderEconomics(policy),
  );

  if (looksRoboticsAi) {
    sections.push(
      "## Why RIGShare for Robotics & AI hardware",
      "",
      "The Robotics & AI division supports remote-access rentals for AI compute, AI infrastructure, and IoT sensors: that hardware never ships — renters connect over the network and you keep the gear on your rack. Humanoid robots, industrial robots, drones, and 3D printers are PHYSICAL rentals on RIGShare — renters pick them up or you deliver them, and remote operation is not offered for machines that move.",
      "",
      "- **Four remote-access modes** on a remote-eligible listing (AI compute, AI infrastructure, IoT sensors): SSH terminal, Jupyter notebook, VNC desktop, or plain HTTP API proxying",
      "- **AES-256-GCM encrypted** credential + endpoint storage — plaintext API keys never stored",
      "- **Per-equipment MFA (TOTP)** enforcement for sensitive hardware — prevents stolen-token attacks",
      "- **Session audit logs** (immutable session event records) for compliance/disputes",
      "- **Live telemetry** — CPU, GPU, memory, network metrics pushed by your server to renters in real time",
      "- **Optional video feed** for physical hardware (HLS, MJPEG, iframe)",
      "- **Per-session concurrency caps** you set — one renter at a time, or many",
      "- **Allowed-IP restrictions** + session duration caps configurable per listing",
      "",
      "Typical rentable categories — remote-access eligible: GPU compute (H100 / A100 / RTX 5090 / L40S / MI300), AI infrastructure, IoT sensor rigs. Physical-only: humanoid robots (Unitree / Figure-class), industrial arms, drones, 3D printers (FDM / SLA / SLS).",
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
      "- **Robotics & AI** — GPU compute, AI infrastructure, and IoT sensors rent with remote access via SSH/Jupyter/VNC/API and never ship. Humanoid robots, industrial robots, drones, and 3D printers are physical-only: in-person pickup or owner delivery, no remote operation.",
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
      ? "2. Start your listing right away at **https://www.rigshare.app/robotics-ai/list** — no verification needed to DRAFT: add your title, rates, photos, and specs. For remote-access-eligible gear (AI compute, AI infrastructure, IoT sensors), configure your endpoint URL (HTTPS required) + optional API key; RIGShare encrypts everything server-side and proxies renter traffic through a managed gateway with request validation and per-session rate limits."
      : "2. Start your listing right away at **https://www.rigshare.app/list-equipment** — no verification needed to DRAFT: add your title, hourly/daily/weekly/monthly rates, photos (front, sides, back; 5 required for engine-based categories), and specs. Set availability and delivery radius.",
    "3. When you hit **Publish**, RIGShare walks you through the one-time setup just-in-time: identity verification (Stripe Identity, ~3 min) and Stripe Connect payout onboarding (~5 min). You only do this once.",
    "4. Publish — your listing goes live, renters can book immediately, and you get a notification on each booking.",
    "",
    "**Listing directly from this chat:** with a RIGShare API key that has the `equipment:write` scope (create one at https://www.rigshare.app/enterprise; API keys need a Pro or Enterprise plan), the agent can either save your listing as a draft with `rigshare_save_draft_listing` (no verification needed; you add a camera photo in the RIGShare app, then the agent publishes it with `rigshare_publish_listing`), or publish in one step with `rigshare_create_listing` — title, rates, photos (https URLs), and remote-access config for tech hardware. The one-step path has **no draft — it publishes immediately**, so your identity verification and Stripe Connect payout setup must already be done once on the web (the tool's error tells you where if not).",
    "",
    "## Ongoing",
    "",
    "- Manage bookings + approvals at https://www.rigshare.app/dashboard",
    "- Messages with renters in-app (never on personal phones)",
    "- Payouts arrive 48h after each rental completes (Stripe Connect)",
    "- If damage is reported on return, the owner reviews it and may approve a charge. RIGShare charges the renter ONLY if the renter expressly accepts it, and never above the deposit figure displayed on the listing. RIGShare holds no deposit funds; renter silence never results in a charge, and the renter remains fully liable to the owner for actual damage.",
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
  "This operation requires a RIGShare API key. Set RIGSHARE_API_KEY in your MCP client's env config. Get a key at https://www.rigshare.app/enterprise (API keys need a Pro or Enterprise plan) or contact support@rigshare.app.";

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
      signal: init.signal ?? AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      // Keep the error body: gate routes return a machine `code` (and the
      // drafts route a resumable draft_id) alongside `error`.
      return {
        status: res.status,
        data,
        error:
          (data as any)?.error ||
          `RIGShare Agent API returned HTTP ${res.status}`,
      };
    }
    // The agent API wraps every success payload as { data, success: true } —
    // unwrap here so tool code reads payload fields directly. Before 1.2.0 this
    // was NOT unwrapped, which made list_my_bookings / list_my_sessions always
    // report "none found" and create_booking report "—" for every field of a
    // successfully created booking.
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
    return toolData(
      `No bookings found${args.status ? ` with status ${args.status}` : ""}.`,
      { bookings: [] },
    );
  }
  const lines = bookings.map((b, i) => {
    const isMetered = b.billingMode === "METERED";
    // The displayed deposit is TRI-STATE (null = the owner stated no figure,
    // 0 = no deposit required, >0 = the displayed figure, never held). It is
    // rendered only when the payload actually carries the field; the legacy
    // held-deposit amount is 0 on every current booking and must not be shown
    // as the owner's deposit.
    const depositPart = !("depositDisplayCents" in b)
      ? ""
      : b.depositDisplayCents == null
        ? " · Deposit: none stated by the owner"
        : b.depositDisplayCents === 0
          ? " · Deposit: none required by this owner"
          : ` · Deposit (displayed, never held): $${(b.depositDisplayCents / 100).toFixed(2)}`;
    const moneyLine = isMetered
      ? b.meterBilledCents != null
        ? `   Metered (per-minute) · Settled: $${(b.meterBilledCents / 100).toFixed(2)} of $${((b.meterBudgetCents || 0) / 100).toFixed(2)} budget`
        : `   Metered (per-minute) · Budget authorized: $${((b.meterBudgetCents || b.totalAmount || 0) / 100).toFixed(2)} — charged only for minutes used`
      : `   Total: $${((b.totalAmount || 0) / 100).toFixed(2)}${depositPart}`;
    return [
      `${i + 1}. ${b.confirmationCode} — ${b.status}`,
      `   ${b.equipment?.title || "—"} (${b.equipment?.category || "—"})`,
      `   ${new Date(b.startDate).toLocaleDateString()} → ${new Date(b.endDate).toLocaleDateString()} · ${b.durationType}`,
      moneyLine,
      `   Booking ID: ${b.id}`,
    ].join("\n");
  });
  return toolData(`Your bookings:\n\n${lines.join("\n\n")}`, { bookings });
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
    return toolData("No remote sessions found.", { sessions: [] });
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
  return toolData(`Your remote sessions:\n\n${lines.join("\n\n")}`, { sessions });
}

/**
 * DRY-RUN price quote. Same inputs as createBooking (minus idempotency_key);
 * POSTs to the /quote endpoint, which computes the breakdown server-side exactly
 * as booking creation would and STOPS before creating/charging anything.
 * Renders the readable breakdown so an agent can confirm cost with the renter
 * before committing money. No client price is sent or trusted.
 */
async function quoteBooking(args: Record<string, unknown>) {
  if (!RIGSHARE_API_KEY) return toolError(API_KEY_ERROR_MSG);

  // Required fields (equipment_id UUID, start/end ISO datetimes, duration_type
  // enum) are validated by the Zod input schema before this handler runs.

  const body: Record<string, unknown> = {
    equipment_id: args.equipment_id,
    start_date: args.start_date,
    end_date: args.end_date,
    duration_type: args.duration_type,
    pickup_type: args.pickup_type || "REMOTE_ACCESS",
  };
  // Passthrough for input-shape parity with createBooking. None of these change
  // the quoted price (the server recomputes from canonical rates + tier), but
  // forwarding them keeps the quote request identical to what a booking submits.
  if (typeof args.budget_usd === "number") {
    body.meter_budget_cents = Math.round(args.budget_usd * 100);
  }
  if (args.coverage_path) body.coverage_path = args.coverage_path;
  if (args.waiver_version) body.waiver_version = args.waiver_version;
  if (args.qualification_answers) body.qualification_answers = args.qualification_answers;
  if (args.qualification_version) body.qualification_version = args.qualification_version;

  const res = await fetchAuthJson(RIGSHARE_API_KEY, `${RIGSHARE_AGENT_API}/quote`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  if (res.error) return toolError(res.error);

  const d = (res.data || {}) as any;
  const dollars = (cents: number) => `$${((cents || 0) / 100).toFixed(2)}`;

  // METERED (per-minute) listings quote a budget shape, not a fixed total.
  if (d.billing_mode === "METERED") {
    const presets = Array.isArray(d.presets) ? d.presets : [];
    const presetLines = presets.map(
      (p: any) =>
        `   ${p.hours}h of usage ≈ ${p.budget_usd || dollars(p.budget_cents)}`,
    );
    return toolData(
      [
        `Booking quote (METERED — billed per minute):`,
        ``,
        `Rate: ${d.rate_hourly_usd || dollars(d.rate_hourly_cents)}/hr`,
        `Minimum session budget: ${d.min_budget_usd || dollars(d.min_budget_cents)}`,
        `Security deposit: $0.00 (metered sessions have no deposit)`,
        presetLines.length ? `\nBudget presets:\n${presetLines.join("\n")}` : "",
        ``,
        d.disclaimer ||
          "This is an estimate; nothing is charged. You authorize a budget and pay only for the minutes actually used.",
        ``,
        `To book, call rigshare_create_booking with budget_usd set to your authorized session spend.`,
      ]
        .filter(Boolean)
        .join("\n"),
      d as Record<string, unknown>,
    );
  }

  // FIXED listing: full pre-tax breakdown (server-computed).
  const f = d.formatted || {};
  const lines = [
    `Booking quote (estimate — nothing is charged):`,
    ``,
    `Rental (${d.rental_days ?? "?"} day${d.rental_days === 1 ? "" : "s"}): ${f.rental_subtotal || dollars(d.rental_subtotal_cents)}`,
    (d.delivery_fee_cents || 0) > 0 ? `Delivery: ${f.delivery_fee || dollars(d.delivery_fee_cents)}` : null,
    `Renter service fee: ${f.service_fee || dollars(d.service_fee_cents)}`,
    (d.basic_insurance_cents || 0) > 0 ? `Basic coverage: ${f.basic_insurance || dollars(d.basic_insurance_cents)}` : null,
    (d.estimated_egress_cents || 0) > 0 ? `Estimated network egress: ${f.estimated_egress || dollars(d.estimated_egress_cents)}` : null,
    `Charged now (pre-tax): ${f.charged_now || dollars(d.charged_subtotal_cents)}`,
    // RIGShare holds no deposit. TRI-STATE — null (owner
    // states no figure) renders nothing; 0 renders the owner's affirmative
    // no-deposit statement; >0 the displayed figure. Never coerce null to $0.
    d.deposit_display_cents == null
      ? null
      : d.deposit_display_cents === 0
        ? `Deposit: none required by this owner`
        : `Deposit (displayed on the listing — never held; charged only if you expressly accept a damage claim, and never more than this figure): ${f.deposit_display || dollars(d.deposit_display_cents)}`,
    `Grand total: ${f.total_amount || dollars(d.total_amount_cents)}`,
    ``,
    d.tax?.note || "Sales tax is calculated at checkout and not included in this estimate.",
    ``,
    d.disclaimer || "This is an estimate; nothing is charged. Book with rigshare_create_booking.",
  ].filter((l) => l !== null);
  return toolData(lines.join("\n"), d as Record<string, unknown>);
}

async function createBooking(args: Record<string, unknown>) {
  if (!RIGSHARE_API_KEY) return toolError(API_KEY_ERROR_MSG);

  // Required fields (equipment_id UUID, start/end ISO datetimes, duration_type
  // enum) are validated by the Zod input schema before this handler runs.

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

  // Response payload is FLAT (success envelope already unwrapped by
  // fetchAuthJson): booking_id, confirmation_code, status, total_amount,
  // security_deposit, billing_mode, meter_budget_cents, url, payment{...}.
  const d = (res.data || {}) as any;
  // A duplicate replay returns the EXISTING booking (see idempotency_key); it
  // was not created by this call.
  const bookingId = d.booking_id || "—";
  const viewUrl = d.url || `https://www.rigshare.app/booking/${bookingId}`;
  const isMetered = d.billing_mode === "METERED";

  const moneyLines = isMetered
    ? [
        `Billing: METERED (per minute) — budget authorized: $${((d.meter_budget_cents || d.total_amount || 0) / 100).toFixed(2)}`,
        `You are only charged for minutes used; no deposit is held.`,
      ]
    : [
        `Total: $${((d.total_amount || 0) / 100).toFixed(2)}`,
        // TRI-STATE: an absent/null figure must render as "not stated", never
        // as a fabricated $0.00 — null and 0 are different owner statements.
        d.deposit_display_cents == null
          ? `Deposit: this owner has not stated a deposit figure (nothing is held either way)`
          : d.deposit_display_cents === 0
            ? `Deposit: none required by this owner`
            : `Deposit (displayed on the listing — never held; charged only if you expressly accept a damage claim): $${(d.deposit_display_cents / 100).toFixed(2)}`,
      ];

  const payment = d.payment || {};
  // A duplicate replay reports the booking's state as it is NOW; it decides
  // on the server's next-action CODE, not its wording, and never claims how a
  // payment was made (it may have been paid by hand).
  const replayPaymentLine = payment.settled
    ? "Payment: already settled."
    : d.next_action?.code === "PAY"
      ? "Payment: none has been recorded yet — see the next step below."
      : d.status === "PENDING"
        ? "Payment: none yet — the owner approves the request first; see the next step below."
        : "Payment: not settled yet — do not pay again; see the next step below.";
  const paymentLine =
    payment.status === "paid"
      ? "Payment: charged via auto-pay — booking is CONFIRMED."
      : payment.status === "authorized"
        ? "Payment: session budget hold authorized via auto-pay — booking is CONFIRMED."
        : payment.status === "failed"
          ? `Payment: auto-pay FAILED — ${payment.error || "complete payment manually"}. The renter must finish checkout at the booking URL.`
          : /payment is processing|do not pay again/i.test(d.next_action?.description || "")
            ? "Payment: in progress. Do not pay again; check the booking again shortly for the outcome."
            : d.status === "APPROVED"
              ? "Payment: not yet paid — no owner approval is needed; the renter completes checkout at the booking URL now."
              : "Payment: pending — the renter completes checkout at the booking URL after the owner approves.";

  return toolText(
    [
      d.idempotent
        ? "This matches a booking you created in the last few minutes, so nothing new was booked or charged. The existing booking:"
        : "Booking created:",
      ``,
      `Confirmation code: ${d.confirmation_code || "—"}`,
      `Booking ID: ${bookingId}`,
      `Status: ${d.status || "PENDING"}`,
      // A replay carries no totals, only its payment state.
      ...(d.idempotent ? [replayPaymentLine] : [...moneyLines, paymentLine]),
      ``,
      `View at: ${viewUrl}`,
      ``,
      renderNextAction(d.next_action, d.status),
    ].join("\n"),
  );
}

/** Create an equipment listing on behalf of the authenticated owner. */
async function createListing(args: Record<string, unknown>) {
  if (!RIGSHARE_API_KEY) return toolError(API_KEY_ERROR_MSG);

  // Required scalar fields (title/description/category/make/model/year/condition/
  // daily_rate_usd/city/state/zip) are validated by the Zod input schema before
  // this handler runs. The "at least one photo" rule below is a business rule the
  // schema can't express (photos is optional, but must be non-empty to create).
  const photos = Array.isArray(args.photos) ? args.photos : [];
  if (photos.length === 0) {
    return toolError("At least one photo is required — pass photos: [{url: 'https://…'}]. RIGShare moderates, watermarks, and re-hosts them.");
  }

  const remote = (args.remote_access || undefined) as Record<string, unknown> | undefined;
  // Remote-access listings cannot be published without the security
  // attestation — the API rejects a remote create when it's falsy. Fail fast
  // with an actionable message instead of returning an opaque 400.
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
    replacement_value: args.replacement_value_usd,
    deposit_display: args.deposit_display_usd,
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
            // The owner's security attestation; the API rejects a remote
            // create without it.
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
  // The saved listing's category decides the page; the external_id update path
  // keeps the existing listing's category, which may differ from the one sent.
  const listingUrl = ROBOTICS_AI_CATEGORIES.has(String(eq.category || args.category))
    ? `https://www.rigshare.app/robotics-ai/equipment/${eq.id}`
    : `https://www.rigshare.app/equipment/${eq.id}`;
  const listingStatus = String(eq.status || "ACTIVE");
  // A create reports photos_ingested; the external_id match path updates the
  // existing listing, ingests no photos and returns no such field.
  const updatedExisting = d.photos_ingested === undefined;
  const photoNote = updatedExisting
    ? `\nPhotos: unchanged (an existing listing with this external_id was updated; the photos sent were not applied).`
    : d.photo_errors && d.photo_errors.length > 0
      ? `\nPhotos: ${d.photos_ingested} ingested, ${d.photo_errors.length} FAILED — ${d.photo_errors.map((e: any) => `${e.url}: ${e.error}`).join("; ")}`
      : `\nPhotos: ${d.photos_ingested} ingested (moderated + watermarked).`;

  return toolText(
    [
      updatedExisting ? `Existing listing updated (matched external_id):` : `Listing created:`,
      ``,
      `Listing ID: ${eq.id || "—"}`,
      `Status: ${listingStatus}`,
      `${eq.title || args.title} — $${args.daily_rate_usd}/day${eq.billing_mode === "METERED" ? ` · METERED at $${args.hourly_rate_usd}/hr (billed per minute)` : ""}`,
      photoNote,
      ``,
      listingStatus === "ACTIVE"
        ? `Live at: ${listingUrl}`
        : `Listing page (not live while its status is ${listingStatus}): ${listingUrl}`,
      `Manage at: https://www.rigshare.app/dashboard`,
    ].join("\n"),
  );
}

/**
 * Read the unavailability windows RIGShare holds for one of the caller's own
 * listings, keyed by external_id (the GET only supports this key form, and the
 * lookup is scoped to the API key's owner). Optionally reports whether a
 * requested date range overlaps a blocked window.
 */
async function checkAvailability(args: Record<string, unknown>) {
  if (!RIGSHARE_API_KEY) return toolError(API_KEY_ERROR_MSG);

  const externalId =
    typeof args.external_id === "string" ? args.external_id.trim() : "";
  if (!externalId) {
    return toolError(
      "external_id is required — the inventory/SKU id you listed the equipment under (rigshare_create_listing's external_id). The availability endpoint keys only on external_id, not a RIGShare equipment UUID.",
    );
  }

  const params = new URLSearchParams();
  params.set("external_id", externalId);
  const res = await fetchAuthJson(
    RIGSHARE_API_KEY,
    `${RIGSHARE_V1_API}/availability?${params.toString()}`,
  );
  if (res.status === 404) {
    return toolError(
      `No equipment found with external_id=${externalId} under your account. List it first (rigshare_create_listing with external_id) or check the id.`,
    );
  }
  if (res.error) return toolError(res.error);

  const d = (res.data || {}) as any;
  const blocks = (d.blocks || []) as any[];
  const blocked = blocks.filter((b) => b.is_blocked);

  const blockLines =
    blocked.length === 0
      ? ["No unavailability windows — the listing is fully open on RIGShare's calendar."]
      : blocked.map((b, i) => {
          const start = new Date(b.starts_at);
          const end = new Date(b.ends_at);
          return `${i + 1}. ${start.toLocaleDateString()} → ${end.toLocaleDateString()}${b.reason ? ` — ${b.reason}` : ""}`;
        });

  // Optional requested-range check: does [starts_at, ends_at) overlap any
  // blocked window? Half-open overlap: block.start < reqEnd && block.end > reqStart.
  let rangeNote = "";
  let requestedRange: { starts_at?: string; ends_at?: string; available?: boolean } | undefined;
  const reqStart =
    typeof args.starts_at === "string" ? new Date(args.starts_at) : null;
  const reqEnd = typeof args.ends_at === "string" ? new Date(args.ends_at) : null;
  if (
    reqStart &&
    reqEnd &&
    !isNaN(reqStart.getTime()) &&
    !isNaN(reqEnd.getTime())
  ) {
    const overlaps = blocked.some(
      (b) =>
        new Date(b.starts_at).getTime() < reqEnd.getTime() &&
        new Date(b.ends_at).getTime() > reqStart.getTime(),
    );
    rangeNote = overlaps
      ? `\nRequested range ${reqStart.toLocaleDateString()} → ${reqEnd.toLocaleDateString()}: OVERLAPS a blocked window — NOT available.`
      : `\nRequested range ${reqStart.toLocaleDateString()} → ${reqEnd.toLocaleDateString()}: free of blocked windows (subject to any existing renter bookings, which aren't listed here).`;
    requestedRange = {
      starts_at: String(args.starts_at),
      ends_at: String(args.ends_at),
      available: !overlaps,
    };
  }

  return toolData(
    [
      `Availability for external_id=${d.external_id} (equipment ${d.equipment_id}):`,
      ``,
      ...blockLines,
      rangeNote,
    ]
      .filter(Boolean)
      .join("\n"),
    {
      external_id: d.external_id,
      equipment_id: d.equipment_id,
      blocks,
      ...(requestedRange ? { requested_range: requestedRange } : {}),
    },
  );
}

/**
 * Push an ERP/fleet calendar to RIGShare for one listing (snapshot-replace of
 * the external-sync blocks, keyed by external_id). Windows overlapping a
 * confirmed RIGShare booking are rejected and surfaced back to the caller.
 */
async function syncAvailability(args: Record<string, unknown>) {
  if (!RIGSHARE_API_KEY) return toolError(API_KEY_ERROR_MSG);

  const externalId =
    typeof args.external_id === "string" ? args.external_id.trim() : "";
  if (!externalId) {
    return toolError(
      "external_id is required — the inventory/SKU id of the listing whose calendar you're syncing (rigshare_create_listing's external_id).",
    );
  }
  // blocks is validated as an array by the Zod input schema before this handler.
  // The endpoint accepts only UTC ("Z") date-times and refuses the WHOLE request
  // when any block is malformed or ends before it starts, so convert offset
  // times to UTC here and refuse a bad block up front with a message that names
  // it. A time with no offset is ambiguous (whose local time?) and is refused
  // rather than guessed.
  const blocks: { starts_at: string; ends_at: string; reason?: string }[] = [];
  for (const [i, b] of (args.blocks as any[]).entries()) {
    const startsAt = toUtcIso(b?.starts_at);
    const endsAt = toUtcIso(b?.ends_at);
    if (!startsAt || !endsAt) {
      return toolError(
        `Block ${i + 1}: starts_at and ends_at must be ISO 8601 date-times with Z or a UTC offset, e.g. 2026-09-15T08:00:00-05:00. Nothing was synced.`,
      );
    }
    if (Date.parse(endsAt) <= Date.parse(startsAt)) {
      return toolError(`Block ${i + 1}: ends_at must be after starts_at. Nothing was synced.`);
    }
    blocks.push({ starts_at: startsAt, ends_at: endsAt, ...(b?.reason ? { reason: b.reason } : {}) });
  }

  const res = await fetchAuthJson(RIGSHARE_API_KEY, `${RIGSHARE_V1_API}/availability`, {
    method: "POST",
    body: JSON.stringify({ items: [{ external_id: externalId, blocks }] }),
  });
  if (res.error) {
    // A 4xx is a refusal before anything is applied. A timeout or 5xx is not
    // known either way, so it gets no such claim.
    const refused = typeof res.status === "number" && res.status >= 400 && res.status < 500;
    return toolError(
      refused ? `${res.error} Nothing was synced; the previously synced blocks are unchanged.` : res.error,
    );
  }

  const d = (res.data || {}) as any;
  const summary = d.summary || {};
  const result = (Array.isArray(d.results) && d.results[0]) || {};

  // The route reports per-item status; surface not_found as an actionable error.
  if (result.status === "not_found") {
    return toolError(
      result.error ||
        `No equipment found with external_id=${externalId} under your account. Create it first via rigshare_create_listing (with external_id).`,
    );
  }
  // The listing's sync runs as one transaction: an "error" item applied
  // nothing, and its previously synced blocks are still in place.
  if (result.status === "error") {
    return toolError(
      `${result.error || "The availability sync failed"} for external_id=${externalId}. Nothing was changed; the previously synced blocks are still in place. Retry the sync.`,
    );
  }

  const conflicts = Array.isArray(result.conflicts) ? result.conflicts : [];
  const conflictLines = conflicts.map((c: any, i: number) => {
    const start = new Date(c.starts_at);
    const end = new Date(c.ends_at);
    return `   ${i + 1}. ${start.toLocaleDateString()} → ${end.toLocaleDateString()}${c.reason ? ` — ${c.reason}` : ""}`;
  });

  return toolText(
    [
      `Availability synced for external_id=${externalId}:`,
      ``,
      `Status: ${result.status || "synced"}`,
      result.equipment_id ? `Equipment: ${result.equipment_id}` : null,
      `Blocks applied: ${result.blocks_created ?? summary.blocks_created ?? 0}`,
      `Conflicts (skipped — an approved, confirmed or in-progress RIGShare booking already covers them): ${result.blocks_conflicting ?? summary.conflicts ?? 0}`,
      conflictLines.length ? `\nConflicting windows (not blocked):\n${conflictLines.join("\n")}` : "",
      ``,
      `Snapshot semantics: these blocks REPLACED the previously-synced set for this external_id.`,
    ]
      .filter(Boolean)
      .join("\n"),
  );
}

/** Start a remote session on a confirmed Robotics & AI booking. */
async function startSession(args: Record<string, unknown>) {
  if (!RIGSHARE_API_KEY) return toolError(API_KEY_ERROR_MSG);

  // booking_id is validated as a UUID by the Zod input schema before this handler.
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
      // The response does not say whether this is a new session or the one
      // already live on the booking, so the header claims neither.
      `Remote session (new, or the one already live on this booking):`,
      ``,
      `Session ID: ${s.session_id || "—"}`,
      `Status: ${s.status || "provisioning"}`,
      `Access type: ${s.access_type || "—"}`,
      s.connection_url ? `Connection URL: ${s.connection_url}` : null,
      s.access_token
        ? `Access token (shown ONCE — store it securely, it cannot be retrieved again; for SSH/API access, calling rigshare_start_session again while this session is live issues a replacement and this one stops working): ${s.access_token}`
        : null,
      specs.length ? specs.join(" · ") : null,
      ``,
      `If this booking is METERED, the per-minute clock runs while this session is active — call rigshare_end_session when done to settle for exact usage.`,
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

  // booking_id is validated as a UUID by the Zod input schema before this handler.
  const res = await fetchAuthJson(
    RIGSHARE_API_KEY,
    `${RIGSHARE_AGENT_API}/bookings/${encodeURIComponent(args.booking_id as string)}/end`,
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

/**
 * MONEY PATH — cancel a booking and issue any refund per the cancellation
 * policy. The endpoint computes the refund SERVER-SIDE from the booking's
 * canonical charges (the client sends only the booking id + an optional audit
 * note); it never accepts a client-dictated amount (no deposit hold exists to
 * release \u2014 RIGShare holds none),
 * and is terminal-state-safe (no double refund). We render the returned
 * breakdown so an agent can confirm what was refunded/retained with the renter.
 */
async function cancelBooking(args: Record<string, unknown>) {
  if (!RIGSHARE_API_KEY) return toolError(API_KEY_ERROR_MSG);

  // booking_id is validated as a UUID by the Zod input schema before this handler.
  const body: Record<string, unknown> = {};
  if (typeof args.reason === "string" && args.reason.trim()) body.reason = args.reason.trim();

  const res = await fetchAuthJson(
    RIGSHARE_API_KEY,
    `${RIGSHARE_AGENT_API}/bookings/${encodeURIComponent(args.booking_id as string)}/cancel`,
    { method: "POST", body: JSON.stringify(body) },
  );
  if (res.error) return toolError(res.error);

  // Flat payload (envelope unwrapped by fetchAuthJson): booking_id, status,
  // billing_mode, policy_rule, refund{...}, deposit{...}, settled?, billed_*.
  const d = (res.data || {}) as any;
  const refund = d.refund || {};
  const deposit = d.deposit || {};
  const usd = (u: any, cents: any) =>
    typeof u === "number" ? `$${u.toFixed(2)}` : `$${(((cents as number) || 0) / 100).toFixed(2)}`;

  const lines = [
    d.declined ? `Booking request declined by the owner:` : `Booking cancelled:`,
    ``,
    `Booking ID: ${d.booking_id || args.booking_id}`,
    `Status: ${d.status || "CANCELLED"}`,
    d.policy_rule ? `Policy applied: ${d.policy_rule}` : null,
    ``,
    `Refunded to renter: ${usd(refund.amount_usd, refund.amount_cents)}`,
    // refund_pending: a refund may be owed that could not be issued
    // automatically (also when no charge could be confirmed); the amounts here
    // are not final until RIGShare staff complete it.
    refund.status === "refund_pending"
      ? `Refund status: PENDING — a refund may be owed that could not be issued automatically; RIGShare staff are alerted and complete it by hand. The refunded and retained amounts are not final.`
      : refund.status
        ? `Refund status: ${refund.status}`
        : null,
    (refund.retained_cents || 0) > 0
      ? `Retained (non-refundable per policy, e.g. service fee): ${usd(refund.retained_usd, refund.retained_cents)}`
      : null,
    // had_hold means a REAL card authorization existed (an older booking made
    // before RIGShare stopped holding deposits) — say so honestly; "never
    // held" would be false for exactly those bookings.
    deposit.had_hold
      ? `Security deposit hold: ${usd(deposit.amount_usd, deposit.amount_cents)} — ${deposit.disposition === "released" ? "released (not charged)" : deposit.disposition}`
      : `Deposit: none was held (RIGShare holds no deposit on new bookings)`,
    d.settled
      ? `Metered usage settled: ${usd(d.billed_usd, d.billed_cents)} charged for actual usage`
      : null,
    ``,
    `This cancels the booking and issues any refund per policy. The refund was computed server-side; it cannot be re-issued (terminal-safe).`,
  ].filter((l) => l !== null);
  return toolText(lines.join("\n"));
}

/**
 * MONEY PATH — raise the authorized per-minute budget on a running METERED
 * session. The additional hold + budget increase are computed server-side from
 * the canonical per-minute rate; the client only picks a fixed extension length
 * (15/30/60 min). Renders the newly authorized budget.
 */
async function extendSession(args: Record<string, unknown>) {
  if (!RIGSHARE_API_KEY) return toolError(API_KEY_ERROR_MSG);

  // booking_id (UUID) and additional_minutes (15 | 30 | 60) are validated by the
  // Zod input schema before this handler runs.
  const res = await fetchAuthJson(
    RIGSHARE_API_KEY,
    `${RIGSHARE_AGENT_API}/bookings/${encodeURIComponent(args.booking_id as string)}/extend`,
    { method: "POST", body: JSON.stringify({ additional_minutes: Number(args.additional_minutes) }) },
  );
  if (res.error) {
    // The endpoint checks the key (401), its auto-pay setting, spend caps and
    // the caller's role (403) before it places any hold, so these two statuses
    // mean nothing was authorized. Other failures make no such claim.
    const noHold =
      res.status === 401
        ? " The API key is missing, invalid, revoked or expired. No hold was placed and the budget is unchanged."
        : res.status === 403
          ? " No hold was placed and the budget is unchanged."
          : "";
    return toolError(`${res.error}${noHold}`);
  }

  const d = (res.data || {}) as any;
  // null/absent is NOT $0: never render an unknown amount as a figure.
  const usdOrNull = (u: any, cents: any): string | null =>
    typeof u === "number"
      ? `$${u.toFixed(2)}`
      : typeof cents === "number"
        ? `$${(cents / 100).toFixed(2)}`
        : null;
  const added = usdOrNull(d.added_authorization_usd, d.added_authorization_cents);
  const newTotal = usdOrNull(d.new_authorized_budget_usd, d.new_authorized_budget_cents);

  return toolText(
    [
      `Session budget extended:`,
      ``,
      `Booking ID: ${d.booking_id || args.booking_id}`,
      `Added: ${d.added_minutes ?? args.additional_minutes} minutes of budget`,
      `Additional authorization hold: ${added ?? "not reported"}`,
      newTotal
        ? `New total authorized budget: ${newTotal}`
        : `New total authorized budget: could not be read back. The hold above was placed; check rigshare_get_session_usage for the current budget rather than extending again.`,
      ``,
      `Only actual usage is charged — call rigshare_end_session when done to settle and release the unused budget.`,
    ].join("\n"),
  );
}

/**
 * READ — live metered-usage snapshot (authorized vs used budget, accrued cost,
 * low-budget warning, extension options). Pairs with rigshare_extend_session.
 */
async function getSessionUsage(args: Record<string, unknown>) {
  if (!RIGSHARE_API_KEY) return toolError(API_KEY_ERROR_MSG);

  // booking_id is validated as a UUID by the Zod input schema before this handler.
  const res = await fetchAuthJson(
    RIGSHARE_API_KEY,
    `${RIGSHARE_AGENT_API}/bookings/${encodeURIComponent(args.booking_id as string)}/meter`,
  );
  if (res.error) return toolError(res.error);

  // Flat payload: booking_id + the accrual (usedMinutes, usageCents,
  // serviceFeeCents, totalCents, budgetCents, rateHourlyCents, remainingMinutes,
  // hasActiveSession) + finalized, billedCents, lowBudget, extensionOptions.
  const d = (res.data || {}) as any;
  const dollars = (cents: any) => `$${(((cents as number) || 0) / 100).toFixed(2)}`;

  if (d.finalized) {
    return toolData(
      [
        `Metered session — SETTLED (billing closed):`,
        ``,
        `Booking ID: ${d.booking_id || args.booking_id}`,
        `Final settled cost: ${dollars(d.billedCents)}`,
        `Minutes used: ${d.usedMinutes ?? 0}`,
        `Authorized budget: ${dollars(d.budgetCents)}`,
      ].join("\n"),
      d as Record<string, unknown>,
    );
  }

  const options = Array.isArray(d.extensionOptions) ? d.extensionOptions : [];
  const optionLines = options.map(
    (o: any) => `   +${o.minutes} min ≈ ${dollars(o.costCents)}`,
  );

  return toolData(
    [
      `Live metered usage:`,
      ``,
      `Booking ID: ${d.booking_id || args.booking_id}`,
      `Rate: ${dollars(d.rateHourlyCents)}/hr`,
      `Authorized budget: ${dollars(d.budgetCents)}`,
      `Accrued so far: ${dollars(d.totalCents)} (usage ${dollars(d.usageCents)} + fees ${dollars(d.serviceFeeCents)}) over ${d.usedMinutes ?? 0} min`,
      `Remaining budget: ~${d.remainingMinutes ?? 0} more minutes affordable`,
      `Active session: ${d.hasActiveSession ? "yes" : "no"}`,
      d.lowBudget ? `⚠ LOW BUDGET — extend soon (rigshare_extend_session) to avoid an auto-stop.` : null,
      optionLines.length ? `\nExtension options:\n${optionLines.join("\n")}` : "",
    ]
      .filter((l) => l !== null)
      .join("\n"),
    d as Record<string, unknown>,
  );
}

/**
 * Save a half-finished listing as a DRAFT (equipment:write). Same fields as
 * rigshare_create_listing, but nothing publishes — no identity/Connect gate to
 * DRAFT. Publish (which enforces identity + Stripe Connect + a photo) happens
 * later on the web. Idempotent per draft_session_id.
 */
async function saveDraftListing(args: Record<string, unknown>) {
  if (!RIGSHARE_API_KEY) return toolError(API_KEY_ERROR_MSG);

  const body: Record<string, unknown> = {};
  if (args.draft_session_id) body.draft_session_id = args.draft_session_id;
  if (args.category) body.category = args.category;
  if (args.title) body.title = args.title;
  if (args.description) body.description = args.description;
  if (args.make) body.make = args.make;
  if (args.model) body.model = args.model;
  if (typeof args.year === "number") body.year = args.year;
  if (args.condition) body.condition = args.condition;
  if (typeof args.daily_rate_usd === "number") body.daily_rate_usd = args.daily_rate_usd;
  if (typeof args.hourly_rate_usd === "number") body.hourly_rate_usd = args.hourly_rate_usd;
  if (typeof args.weekly_rate_usd === "number") body.weekly_rate_usd = args.weekly_rate_usd;
  if (typeof args.monthly_rate_usd === "number") body.monthly_rate_usd = args.monthly_rate_usd;
  if (args.city) body.city = args.city;
  if (args.state) body.state = args.state;
  if (args.zip) body.zip = args.zip;
  if (args.booking_type) body.booking_type = args.booking_type;
  if (args.billing_mode) body.billing_mode = args.billing_mode;
  if (typeof args.replacement_value_usd === "number") body.replacement_value_usd = args.replacement_value_usd;
  if (typeof args.deposit_display_usd === "number") body.deposit_display_usd = args.deposit_display_usd;
  if (args.remote_access && typeof args.remote_access === "object") {
    const ra = args.remote_access as Record<string, unknown>;
    body.remote_access = {
      access_type: ra.access_type,
      endpoint: ra.endpoint,
      specs: ra.specs,
      region: ra.region,
      max_concurrent: ra.max_concurrent,
      require_mfa: ra.require_mfa,
    };
  }

  const res = await fetchAuthJson(RIGSHARE_API_KEY, `${RIGSHARE_AGENT_API}/drafts`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  // A field-validation failure still returns the draft_id (the row was created
  // and is resumable) — surface it so the agent can fix and retry.
  if (res.error) {
    const draftId = (res.data as any)?.draft_id;
    const sid = (res.data as any)?.draft_session_id;
    return toolError(
      draftId
        ? `${res.error} (draft saved as ${draftId}${sid ? `, session ${sid}` : ""} — fix the field and re-save with the same draft_session_id).`
        : res.error,
    );
  }

  const d = (res.data || {}) as any;
  return toolText(
    [
      `Listing saved as draft:`,
      ``,
      `Draft ID: ${d.draft_id || "—"}`,
      `Resume key (draft_session_id): ${d.draft_session_id || "—"}`,
      d.is_new === false ? `(updated the existing draft for this session)` : null,
      ``,
      d.note ||
        "Saved as draft — publish when ready (identity + payout setup happen at publish, not now).",
    ]
      .filter((l) => l !== null)
      .join("\n"),
  );
}

/** Render the server's next_action block for an agent to relay verbatim. */
function renderNextAction(na: any, status?: string): string {
  if (!na || typeof na !== "object") {
    return `Next steps: ${status === "CONFIRMED" ? "the booking is confirmed" : "the owner will approve or decline"}. Use rigshare_get_booking to check status.`;
  }
  const actor = na.actor === "renter" ? "the renter" : na.actor === "owner" ? "the owner" : "nobody";
  return [
    `Next step (${na.code || "—"}, action by ${actor}): ${na.description || "—"}`,
    na.url ? `Do it here: ${na.url}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

/** READ — one booking + next_action, for polling after create. */
async function getBooking(args: Record<string, unknown>) {
  if (!RIGSHARE_API_KEY) return toolError(API_KEY_ERROR_MSG);
  const res = await fetchAuthJson(
    RIGSHARE_API_KEY,
    `${RIGSHARE_AGENT_API}/bookings/${encodeURIComponent(args.booking_id as string)}`,
  );
  if (res.error) return toolError(res.error);
  const d = (res.data || {}) as any;
  const money = d.money || {};
  const isMetered = d.billing_mode === "METERED";
  const usd = (c: unknown) => (typeof c === "number" ? `$${(c / 100).toFixed(2)}` : "—");
  const depositLine =
    money.deposit_display_cents == null
      ? "Deposit: the owner has not stated a figure (nothing is held either way)"
      : money.deposit_display_cents === 0
        ? "Deposit: none required by this owner"
        : `Deposit (displayed, never held — charged only if the renter expressly accepts a damage claim): ${usd(money.deposit_display_cents)}`;
  return toolText(
    [
      `Booking ${d.confirmation_code || d.booking_id || "—"} (${d.role === "owner" ? "you own the listing" : "you are the renter"}):`,
      ``,
      `Status: ${d.status || "—"}`,
      `Payment: ${d.payment?.settled ? (isMetered ? "budget hold authorized" : "paid") : /payment is processing/i.test(d.next_action?.description || "") ? "processing (do not pay again)" : "not yet paid"}`,
      `Equipment: ${d.equipment?.title || "—"}${d.equipment?.remote_access_enabled ? " (remote access" + (d.equipment?.require_mfa ? ", MFA required — start sessions from the web/mobile app" : "") + ")" : ""}`,
      `Window: ${d.start_date || "—"} → ${d.end_date || "—"} (${d.duration_type || "—"})`,
      isMetered
        ? `Billing: METERED — budget ${usd(money.meter_budget_cents)}, billed so far ${usd(money.meter_billed_cents)}`
        : `Total: ${usd(money.total_amount_cents)} (rental ${usd(money.rental_total_cents)} + service fee ${usd(money.service_fee_cents)})`,
      isMetered ? null : depositLine,
      d.session ? `Active session: ${d.session.active_session_id || "none"}${d.session.status ? ` (${d.session.status})` : ""}` : null,
      ``,
      renderNextAction(d.next_action, d.status),
    ]
      .filter((l) => l !== null)
      .join("\n"),
  );
}

/** READ — one remote session: status, health, usage, latest telemetry. */
async function getSession(args: Record<string, unknown>) {
  if (!RIGSHARE_API_KEY) return toolError(API_KEY_ERROR_MSG);
  const res = await fetchAuthJson(
    RIGSHARE_API_KEY,
    `${RIGSHARE_AGENT_API}/sessions/${encodeURIComponent(args.session_id as string)}`,
  );
  if (res.error) return toolError(res.error);
  const d = (res.data || {}) as any;
  const u = d.usage || {};
  const m = d.latest_metrics;
  const pct = (v: unknown) => (typeof v === "number" ? `${Math.round(v)}%` : "—");
  return toolText(
    [
      `Remote session ${d.session_id || "—"} on booking ${d.booking_id || "—"}:`,
      ``,
      `Status: ${d.status || "—"} · health: ${d.health_status || "unknown"}${d.pause_reason ? ` · paused: ${d.pause_reason}` : ""}${d.error_message ? ` · error: ${d.error_message}` : ""}`,
      `Access: ${d.access_type || "—"}${d.connection_url ? ` — connect via ${d.connection_url}` : ""}`,
      `Started: ${d.started_at || "—"}${d.ended_at ? ` · ended: ${d.ended_at}` : ""}${d.last_heartbeat ? ` · last heartbeat: ${d.last_heartbeat}` : ""}`,
      `Usage: ${u.total_compute_hours ?? "—"} compute hours${u.billed_minutes != null ? ` (${u.billed_minutes} billed min)` : ""} · cost so far $${((u.total_cost_cents || 0) / 100).toFixed(2)}${u.interruption_count ? ` · ${u.interruption_count} interruption(s), ${u.interrupted_seconds}s not billed` : ""}`,
      d.meter ? `Metered budget: $${((d.meter.budget_cents || 0) / 100).toFixed(2)} authorized, $${((d.meter.billed_cents || 0) / 100).toFixed(2)} billed` : null,
      `Resources: ${d.resources?.gpu_allocation || "no GPU allocation recorded"}${d.resources?.cpu_cores ? ` · ${d.resources.cpu_cores} vCPU` : ""}${d.resources?.ram_gb ? ` · ${d.resources.ram_gb} GB RAM` : ""}${d.resources?.storage_gb ? ` · ${d.resources.storage_gb} GB storage` : ""}`,
      m
        ? `Latest telemetry (${m.at || "—"}): CPU ${pct(m.cpu_percent)} · GPU ${pct(m.gpu_percent)} · memory ${pct(m.memory_percent)} · disk ${pct(m.disk_percent)}${m.latency_ms != null ? ` · latency ${m.latency_ms} ms` : ""}${m.gpu_temp_c != null ? ` · GPU ${Math.round(m.gpu_temp_c)}°C` : ""}${m.gpu_mem_used_mb != null && m.gpu_mem_total_mb ? ` · VRAM ${m.gpu_mem_used_mb}/${m.gpu_mem_total_mb} MB` : ""}${m.battery_pct != null ? ` · battery ${Math.round(m.battery_pct)}%` : ""}`
        : `Latest telemetry: none reported yet.`,
      ``,
      d.status === "active"
        ? "When the renter is done, call rigshare_end_session so the per-minute meter stops."
        : "Use rigshare_get_booking for the booking's next step.",
    ]
      .filter((l) => l !== null)
      .join("\n"),
  );
}

/** WRITE — publish a draft through the shared publish gate. */
async function publishListing(args: Record<string, unknown>) {
  if (!RIGSHARE_API_KEY) return toolError(API_KEY_ERROR_MSG);
  // Field names expected by POST /api/v1/agent/drafts/{id}/publish: the tool's
  // agent-facing arg names are mapped here; only an explicit true is sent.
  const body: Record<string, unknown> = {};
  if (args.security_ack === true) body.remote_security_ack = true;
  if (args.ownership_ack === true) body.ownership_attested = true;
  const res = await fetchAuthJson(
    RIGSHARE_API_KEY,
    `${RIGSHARE_AGENT_API}/drafts/${encodeURIComponent(args.draft_id as string)}/publish`,
    { method: "POST", body: JSON.stringify(body) },
  );
  if (res.error) {
    const code = (res.data as any)?.code;
    const hint =
      code === "ID_NOT_VERIFIED"
        ? "The owner must complete identity verification in the RIGShare app, then retry."
        : code === "STRIPE_CONNECT_REQUIRED"
          ? "The owner must finish payout setup (Stripe Connect) in the RIGShare app, then retry."
          : code === "TIER_LIMIT"
            ? "The owner's plan has reached its listing limit — upgrade the plan or pause another listing."
            : code === "REPLACEMENT_VALUE_REQUIRED"
              ? "A physical (non-remote) listing needs a replacement value to publish — re-save the draft with replacement_value_usd and retry."
            : code === "DEPOSIT_ABOVE_LIMIT"
              ? "The deposit figure to display is above what the replacement value allows (10% of it, $25–$1,000) or the replacement value is missing — re-save the draft with a lower deposit_display_usd and/or a replacement_value_usd, then retry."
            : code === "INCOMPLETE"
              ? "The draft is missing basics (title/description/category), rates, location (a physical INSTANT listing also needs a street address, added in the app), or at least one camera photo added in the app."
              : code === "MODERATION_FLAGGED"
                ? "The title/description/photos were flagged by moderation — edit them and retry."
                : code === "PHOTO_REVIEW_UNAVAILABLE"
                  ? "The photos could not be reviewed. This is usually a temporary outage: retry in a few minutes. If it keeps failing, the owner should replace the photos in the RIGShare app or contact support@rigshare.app."
                  : "";
    return toolError(`${res.error}${code ? ` [${code}]` : ""}${hint ? ` ${hint}` : ""}`);
  }
  const d = (res.data || {}) as any;
  return toolText(
    [
      `Listing published:`,
      ``,
      `Listing ID: ${d.equipment_id || d.id || args.draft_id}`,
      `Status: ${d.status || "ACTIVE"}`,
      d.url ? `Live at: ${d.url}` : null,
      ``,
      `Renters can now find and book it. Booking requests on it appear in the owner's dashboard: https://www.rigshare.app/dashboard`,
    ]
      .filter((l) => l !== null)
      .join("\n"),
  );
}

// ─── HTTP + response helpers ────────────────────────────────────────

async function fetchJson(url: string): Promise<FetchResult> {
  try {
    // Bounded timeout so a STALLED endpoint (TCP accepted, response withheld)
    // can't block a caller for ~5 min (undici default) — e.g. get_owner_onboarding
    // fetches /policy and must fall back to bundled copy promptly on a hang.
    const res = await fetch(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": USER_AGENT,
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      // Parse the server's JSON error body (same `data.error` extraction as
      // fetchAuthJson) and classify retryable (5xx) vs terminal (4xx),
      // reflecting a machine-readable code in the message. The request URL
      // is logged to stderr, never surfaced to the model.
      const body = await res.json().catch(() => ({} as any));
      const serverError =
        body && typeof body === "object" ? (body as any).error : undefined;
      const retryable = res.status >= 500;
      const code = retryable ? "upstream_5xx" : "client_4xx";
      console.error(
        `[rigshare-mcp] GET ${url} -> HTTP ${res.status}${serverError ? `: ${serverError}` : ""}`,
      );
      return {
        status: res.status,
        code,
        retryable,
        error: serverError
          ? `RIGShare API error [${code}] (HTTP ${res.status}${retryable ? ", retryable" : ""}): ${serverError}`
          : `RIGShare API returned HTTP ${res.status} [${code}]${retryable ? " — retryable, try again shortly" : ""}.`,
      };
    }
    const data = await res.json();
    return { data, status: res.status };
  } catch (err: any) {
    // Log the URL to stderr; keep it out of the client-facing string.
    console.error(
      `[rigshare-mcp] network error for ${url}:`,
      err?.stack || err?.message || err,
    );
    return {
      code: "network_error",
      retryable: true,
      error:
        "Network error contacting RIGShare API [network_error] — retryable, try again shortly.",
    };
  }
}

/**
 * fetchJson with a short in-memory TTL. Only clean successes are cached —
 * a transient 5xx/network error is never pinned for the whole TTL. Used for the
 * slow-moving public GETs (categories + the /policy copy endpoint).
 */
async function fetchJsonCached(url: string, ttlMs: number): Promise<FetchResult> {
  const now = Date.now();
  const hit = publicJsonCache.get(url);
  if (hit && hit.expires > now) return hit.value;
  const res = await fetchJson(url);
  if (!res.error && res.data !== undefined) {
    publicJsonCache.set(url, { expires: now + ttlMs, value: res });
  }
  return res;
}

/**
 * Fetch the policy JSON (pricing/fee/deposit/onboarding facts) from the public
 * /policy endpoint. Returns the raw parsed body, or null if the endpoint is
 * unreachable (so callers fall back to BUNDLED_POLICY).
 */
async function fetchPolicyRaw(): Promise<any | null> {
  const res = await fetchJsonCached(`${RIGSHARE_API}/policy`, PUBLIC_CACHE_TTL_MS);
  return res.error || res.data === undefined ? null : res.data;
}

/**
 * Merge the fetched policy over the BUNDLED_POLICY defaults, field by field, so
 * the owner-onboarding tool ALWAYS has a complete, correctly-shaped object to
 * render — whether the live endpoint was reachable, unreachable, or returned a
 * partial payload. This is the graceful-fallback core: the tool can never break
 * on missing/absent policy copy.
 */
function coercePolicy(p: any): NormalizedPolicy {
  if (!p || typeof p !== "object") return BUNDLED_POLICY as unknown as NormalizedPolicy;
  const B = BUNDLED_POLICY;
  return {
    version: typeof p.version === "string" ? p.version : B.version,
    commission: { ...B.commission, ...(p.commission || {}) },
    renter_service_fee: { ...B.renter_service_fee, ...(p.renter_service_fee || {}) },
    // Picked explicitly, not spread: this field is the live answer to "is the
    // reduced student rate being charged right now?". Only a real boolean is
    // taken: anything else (absent, a string, an older payload) stays
    // `null` = unknown, never a default of `true`.
    student_rate_active:
      typeof p.student_rate_active === "boolean" ? p.student_rate_active : null,
    subscription_prices: {
      pro: { ...B.subscription_prices.pro, ...(p.subscription_prices?.pro || {}) },
      enterprise: {
        ...B.subscription_prices.enterprise,
        ...(p.subscription_prices?.enterprise || {}),
      },
    },
    listing_caps: { ...B.listing_caps, ...(p.listing_caps || {}) },
    security_deposit: { ...B.security_deposit, ...(p.security_deposit || {}) },
  };
}

/** Always returns a usable, complete policy object (live or bundled fallback). */
async function getPolicy(): Promise<NormalizedPolicy> {
  return coercePolicy(await fetchPolicyRaw());
}

// ─── Copy render helpers (sourced from /policy) ─────────────────────
function pctLabel(rate: number): string {
  const v = rate * 100;
  return `${Number.isInteger(v) ? v : Number(v.toFixed(2))}%`;
}
function usdFromCents(cents: number): string {
  if (!cents) return "$0";
  return `$${(cents / 100).toFixed(2)}`;
}
function capLabel(n: number | null | undefined): string {
  // -1 is the /policy payload's sentinel for "unlimited". null is NOT: it
  // means the payload published no cap for this tier, and rendering that as
  // "Unlimited" would be a positive claim invented out of an absence.
  if (n === -1) return "Unlimited";
  if (n == null) return "Not published";
  return `${n} listing${n === 1 ? "" : "s"}`;
}
/**
 * Render the "## Economics" block from the policy payload, so a published
 * price change reaches agents WITHOUT republishing this npm package.
 */
function renderEconomics(policy: NormalizedPolicy): string[] {
  const c = policy.commission;
  const fee = policy.renter_service_fee;
  const sp = policy.subscription_prices;
  const caps = policy.listing_caps;
  return [
    "## Economics",
    "",
    "| Tier | Monthly fee | Platform commission | Listings cap |",
    "|---|---|---|---|",
    `| Free | $0 | ${pctLabel(c.free)} | ${capLabel(caps.free)} |`,
    `| Pro | ${usdFromCents(sp.pro.monthly_cents)} | ${pctLabel(c.pro)} | ${capLabel(caps.pro)} |`,
    `| Enterprise | ${usdFromCents(sp.enterprise.monthly_cents)} | ${pctLabel(c.enterprise)} | ${capLabel(caps.enterprise)} |`,
    "",
    // The student clause is only ASSERTED when /policy said the rate is on.
    // `false` drops it entirely; `null` (bundled fallback, or a payload that
    // predates the field) says the status is unknown and names where to look,
    // rather than quoting a rate we cannot confirm.
    `- Renters pay up to a ${pctLabel(fee.standard)} service fee on top of your rental total${
      policy.student_rate_active === true
        ? ` (reduced to ${pctLabel(fee.student)} for verified students)`
        : policy.student_rate_active === null
          ? " (RIGShare also runs a reduced verified-student rate; whether it is currently being charged is published live at /api/public/v1/policy \"student_rate_active\", which this copy could not reach)"
          : ""
    }; doesn't reduce your payout`,
    `- RIGShare holds NO security deposit. Physical listings may DISPLAY an owner-stated deposit figure (deposit_display_cents — null means none stated, 0 means the owner requires none); it is never held or charged unless the renter expressly accepts a damage claim, and an accepted claim is never charged above it. METERED per-minute Tech sessions display no figure; the renter authorizes a usage budget instead`,
    "- Payouts via Stripe Connect, 48-hour hold after rental completion",
    "- Buy-now-pay-later at checkout where offered (Klarna, Affirm, Zip) — improves your conversion with no extra work",
    "",
  ];
}

/**
 * An ISO 8601 date-time that carries Z or a UTC offset, as a UTC ("Z") string;
 * null when it carries neither or does not parse.
 */
function toUtcIso(value: unknown): string | null {
  if (typeof value !== "string" || !/T[\d:.]+(?:Z|[+-]\d{2}(?::?\d{2})?)$/i.test(value.trim())) return null;
  const ms = Date.parse(value.trim());
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

function toolText(text: string) {
  return {
    content: [{ type: "text" as const, text }],
  };
}

/**
 * Text + structuredContent. Used by the READ tools that declare an
 * `outputSchema` — the text is unchanged, `structuredContent` is the normalized
 * (mostly passthrough) parsed response so agents can machine-read the result.
 */
function toolData(text: string, structuredContent: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text }],
    structuredContent,
  };
}

function toolError(message: string) {
  return {
    content: [{ type: "text" as const, text: `Error: ${message}` }],
    isError: true,
  };
}

// ─── Boot ────────────────────────────────────────────────────────────

// Exported so tests can introspect the registered tools + invoke handlers via an
// in-memory transport without booting stdio (see test/tools.test.mjs).
export { server };

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Diagnostic to stderr (stdout is reserved for MCP protocol traffic)
  process.stderr.write("rigshare-mcp server running on stdio\n");
}

// Only boot the stdio transport when this file is executed directly as the CLI
// (the published `rigshare-mcp` bin). realpathSync on both sides makes this
// symlink-safe (npm/npx invoke via a .bin symlink), so production boot is
// unchanged; a plain `import` (e.g. from a test) skips it.
function isEntrypoint(): boolean {
  try {
    return (
      !!process.argv[1] &&
      realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
}

if (isEntrypoint()) {
  main().catch((err) => {
    process.stderr.write(`Fatal: ${err?.message || err}\n`);
    process.exit(1);
  });
}
