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
 * The three tools above are READ-ONLY and unauthenticated — they hit
 * RIGShare's public API at /api/public/v1/*. Additional authenticated
 * tools (booking, listing, sessions) unlock with a RIGSHARE_API_KEY.
 *
 * RESOURCES (canonical, single-source-of-truth copy):
 *   - rigshare://pricing, rigshare://owner-onboarding — backed by the
 *     app's /api/public/v1/policy endpoint (so pricing/fee/onboarding copy
 *     never drifts from the code that charges money)
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
const VERSION = "2.0.0";
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
      // Resources expose the canonical pricing / onboarding / category / terms
      // copy (see registerResource calls near the bottom). Prompts expose 3
      // guided workflows (rent-gpu / list-my-equipment / check-my-rentals).
      resources: {},
      prompts: {},
    },
  },
);

// ─── In-memory TTL cache for the public GET surface (P-9) ────────────
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

// Bundled fallback for the canonical pricing/fee copy. Mirrors the enforced
// constants (app/_lib/subscriptions.ts + app/_lib/stripe.ts) EXACTLY, so the
// owner-onboarding tool renders identical copy whether it sourced the live
// /policy endpoint or fell back here. This is ONLY a fallback — the live path
// is authoritative and is what keeps copy from drifting after a price change.
const BUNDLED_POLICY = {
  version: "bundled",
  commission: { free: 0.15, pro: 0.1, enterprise: 0.07, student: 0.07 },
  renter_service_fee: { standard: 0.07, student: 0.03 },
  subscription_prices: {
    pro: { monthly_cents: 4999, yearly_cents: 49900 },
    enterprise: { monthly_cents: 14999, yearly_cents: 149900 },
  },
  listing_caps: { free: 5, pro: 15, enterprise: -1, student: 2 },
  // `rate` is the flat STANDARD/default tier (backward compat). `tiers` is the
  // owner-selectable set (Stage E2); the live /policy payload provides the same
  // shape, and this bundled copy is the graceful fallback when it's unreachable.
  security_deposit: {
    rate: 0.15,
    min_cents: 10000,
    min_usd: 100,
    metered: false,
    owner_selectable: true,
    tiers: [
      { id: "NONE", label: "None", rate: 0 },
      { id: "STANDARD_15", label: "Standard", rate: 0.15 },
      { id: "HIGHER_25", label: "Higher", rate: 0.25 },
    ],
  },
  // Damage-claim + referral facts (additive, mirrors the live /policy payload's
  // `damage_claims` / `claim_settlement` / `referral_program` keys) so a caller
  // still gets accurate copy even when the live endpoint is unreachable.
  damage_claims: {
    ai_never_charges_alone: true,
    owner_review_required: true,
    cap: "security_deposit",
    sanity_ceiling_usd: 100_000,
    owner_review_deadline_hours: 168,
    renter_response_window_hours: 72,
    renter_response_window_note:
      "An explicit accept always starts collection. On silence, collection starts only if RIGShare's AI plausibility check clears the owner-approved amount as proportionate to the photos and deposit; an anomalous, unverifiable, or unchecked claim is routed to direct_resolution instead of being charged.",
    environmental_grime_excluded: true,
    collection: { max_attempts: 3, window_days: 14 },
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
    methods: ["card", "afterpay_clearpay", "klarna", "affirm", "zip"],
    partial_payments_allowed: true,
    auto_resolves_on_full_payment: true,
    renter_pays_processing_fee: true,
    owner_receives_full_balance: true,
    fee_disclosure: "itemized before the renter pays",
  },
  referral_program: {
    referrer_reward_usd: 50,
    referee_reward_usd: 25,
    qualifying_event: "referred user completes a qualifying rental",
    credit_use: "applied automatically at a future checkout; never applies to the security deposit",
    clawback_on_refund_or_chargeback: true,
    abuse_policy: "self-referral and referral farming are prohibited",
    pages: {
      construction: "https://www.rigshare.app/referrals",
      robotics_ai: "https://www.rigshare.app/robotics-ai/referrals",
    },
  },
} as const;
type DepositTier = { id: string; label: string; rate: number };
type NormalizedPolicy = {
  version: string;
  commission: { free: number; pro: number; enterprise: number; student: number };
  renter_service_fee: { standard: number; student: number };
  subscription_prices: {
    pro: { monthly_cents: number; yearly_cents: number };
    enterprise: { monthly_cents: number; yearly_cents: number };
  };
  listing_caps: { free: number; pro: number; enterprise: number; student: number };
  // `owner_selectable` + `tiers` are additive (Stage E2) — optional so a live
  // payload that predates them still normalizes cleanly and falls back to `rate`.
  security_deposit: {
    rate: number;
    min_cents: number;
    min_usd: number;
    metered: boolean;
    owner_selectable?: boolean;
    tiers?: DepositTier[];
  };
};

// Shape of every tool's return payload (a single text block, optionally an
// error) — structurally the MCP CallToolResult content shape. `structuredContent`
// is additive (P-4): read tools that declare an `outputSchema` also return the
// normalized object here alongside the unchanged text. The SDK skips output
// validation for `isError` results, so error paths may omit it.
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
      // Additive (P-4): only present on the read tools that return conforming
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

// ─── structuredContent output schemas (P-4) ─────────────────────────
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
      division: z.enum(["all", "construction", "robotics-ai"]).optional(),
      category: z.string().optional(),
      remote_only: z.boolean().optional(),
      access_type: z.enum(["SSH", "JUPYTER", "DESKTOP", "API"]).optional(),
      compute_architecture: z
        .enum(["CUDA", "ROCM", "APPLE_SILICON", "TPU", "TRAINIUM", "CPU"])
        .optional(),
      search: z.string().optional(),
      min_price_daily_usd: z.number().optional(),
      max_price_daily_usd: z.number().optional(),
      city: z.string().optional(),
      state: z.string().optional(),
      sort: z.enum(["newest", "price_asc", "price_desc", "rating"]).optional(),
      page: z.number().int().min(1).optional(),
      limit: z.number().int().min(1).max(100).optional(),
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
      "Fetch full details for a single RIGShare equipment listing by its UUID. Returns specs, pricing, owner info, images, and a deep-link URL for booking.",
    inputSchema: {
      id: z.string().uuid(),
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
      "Returns all equipment categories that have at least one active listing, with per-category listing counts and descriptions. Useful for narrowing a search or helping a user discover what's available.",
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
      equipment_type: z.string().optional(),
      division_hint: z.enum(["construction", "robotics-ai", "unknown"]).optional(),
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
      "REQUIRES API KEY (RIGSHARE_API_KEY env var, bookings:read scope). Returns the authenticated user's RIGShare bookings — equipment, dates, status, totals. Use this to check an existing rental before creating a new one, or to track a confirmation code.",
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
        .optional(),
      limit: z.number().int().min(1).max(100).optional(),
      page: z.number().int().min(1).optional(),
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
      "REQUIRES API KEY (sessions:read scope). Lists the authenticated user's remote sessions on Robotics & AI bookings — status, GPU allocation, total compute hours, cost so far. Use before starting a new session to check if one is already active.",
    inputSchema: {
      booking_id: z.string().uuid().optional(),
      status: z
        .enum(["provisioning", "active", "paused", "terminated", "failed"])
        .optional(),
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
      "moves: rental subtotal, renter service fee (student 3% vs 7% resolved",
      "server-side), the security-deposit authorization hold (owner-set per",
      "listing: 0% None, 15% Standard, or 25% Higher of rental total, min $100",
      "when a deposit applies; 0 for METERED), delivery, coverage/egress, and the",
      "grand total, all in cents",
      "plus formatted USD. Prices are recomputed server-side from the equipment's",
      "canonical rates and the renter's tier — identical to what booking charges;",
      "no client price is trusted. METERED (per-minute Tech) listings return the",
      "per-hour rate, the minimum session budget, and budget presets instead of a",
      "fixed total (no deposit). Sales tax is added at checkout and not included",
      "in the estimate. Same inputs as rigshare_create_booking minus",
      "idempotency_key.",
    ].join(" "),
    inputSchema: {
      equipment_id: z.string().uuid(),
      start_date: z.string().refine((d) => !isNaN(Date.parse(d)), "must be a valid date or date-time"),
      end_date: z.string().refine((d) => !isNaN(Date.parse(d)), "must be a valid date or date-time"),
      duration_type: z.enum(["HOURLY", "FOUR_HOURS", "DAILY", "WEEKLY", "MONTHLY"]),
      pickup_type: z
        .enum(["SELF_PICKUP", "OWNER_DELIVERY", "REMOTE_ACCESS"])
        .optional(),
      budget_usd: z.number().min(0.5).max(25000).optional(),
      coverage_path: z.enum(["WAIVER", "BYOCOI"]).optional(),
      waiver_version: z.string().max(50).optional(),
      qualification_answers: z.record(z.string().max(500)).optional(),
      qualification_version: z.string().max(50).optional(),
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
      equipment_id: z.string().uuid(),
      start_date: z.string().refine((d) => !isNaN(Date.parse(d)), "must be a valid date or date-time"),
      end_date: z.string().refine((d) => !isNaN(Date.parse(d)), "must be a valid date or date-time"),
      duration_type: z.enum(["HOURLY", "FOUR_HOURS", "DAILY", "WEEKLY", "MONTHLY"]),
      pickup_type: z
        .enum(["SELF_PICKUP", "OWNER_DELIVERY", "REMOTE_ACCESS"])
        .optional(),
      budget_usd: z.number().min(0.5).max(25000).optional(),
      coverage_path: z.enum(["WAIVER", "BYOCOI"]).optional(),
      waiver_version: z.string().max(50).optional(),
      qualification_answers: z.record(z.string().max(500)).optional(),
      qualification_version: z.string().max(50).optional(),
      idempotency_key: z.string().max(100).optional(),
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
      title: z.string().min(5).max(120),
      description: z.string().min(10).max(5000),
      category: z.string(),
      make: z.string().max(80),
      model: z.string().max(80),
      year: z.number().int().min(1950).max(2035),
      condition: z.enum(["EXCELLENT", "GOOD", "FAIR"]),
      daily_rate_usd: z.number().min(1).max(100000),
      hourly_rate_usd: z.number().min(0).max(100000).optional(),
      weekly_rate_usd: z.number().min(0).max(500000).optional(),
      monthly_rate_usd: z.number().min(0).max(2000000).optional(),
      city: z.string(),
      state: z.string(),
      zip: z.string(),
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
        .optional(),
      booking_type: z.enum(["INSTANT", "REQUEST"]).optional(),
      remote_access: z
        .object({
          access_type: z.enum(["SSH", "JUPYTER", "DESKTOP", "API"]).optional(),
          endpoint: z.string().url().optional(),
          specs: z.string().max(2000).optional(),
          region: z.string().max(100).optional(),
          max_concurrent: z.number().int().min(1).max(1000).optional(),
          require_mfa: z.boolean().optional(),
          security_ack: z.boolean(),
        })
        .optional(),
      billing_mode: z.enum(["FIXED", "METERED"]).optional(),
      external_id: z.string().max(100).optional(),
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
      external_id: z.string().max(120),
      starts_at: z.string().refine((d) => !isNaN(Date.parse(d)), "must be a valid date or date-time").optional(),
      ends_at: z.string().refine((d) => !isNaN(Date.parse(d)), "must be a valid date or date-time").optional(),
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
      "array to clear them). Windows that overlap a CONFIRMED RIGShare booking",
      "are rejected and reported back (you can't retroactively block a day a",
      "renter already paid for). Owner-created blocks set in the RIGShare UI are",
      "left untouched. Returns the applied count + any conflicts.",
    ].join(" "),
    inputSchema: {
      external_id: z.string().max(120),
      blocks: z
        .array(
          z.object({
            starts_at: z.string().datetime({ offset: true, local: true }),
            ends_at: z.string().datetime({ offset: true, local: true }),
            reason: z.string().max(200).optional(),
          }),
        )
        .max(365),
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
      "CONFIRMED Robotics & AI booking (SSH / Jupyter / VNC / API access).",
      "Returns the session access token — shown ONCE, store it securely —",
      "plus the connection URL and allocated specs. For METERED bookings the",
      "per-minute clock runs while the session is active; call",
      "rigshare_end_session (or end the booking) to settle for exact usage.",
      "Equipment that requires MFA cannot be started via API key — the renter",
      "must use the web app.",
    ].join(" "),
    inputSchema: {
      booking_id: z.string().uuid(),
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
      booking_id: z.string().uuid(),
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
      "for the authenticated user AND issues any refund per RIGShare's published",
      "cancellation policy. The refund is computed ENTIRELY server-side from the",
      "booking's canonical charges and how far out the cancellation is (physical:",
      "7+ days 100% / 3-6 days 75% / 1-2 days 50% / same-day 0%, with a 25%",
      "high-value exception on >$5k multi-day rentals; Tech remote-access:",
      "before-session 100% / within first hour 75% / after 0%). The 7% renter",
      "service fee is non-refundable on renter cancellations, EXCEPT the share of",
      "it charged on an owner delivery fee that is itself being refunded: a",
      "booking that ends before pickup is confirmed returns the delivery fee in",
      "full and the service fee charged on it with it. The client CANNOT",
      "dictate the refund amount or reason code — pass only the booking id. The",
      "security-deposit authorization hold is released (never captured). Safe on",
      "terminal state: cancelling an already-cancelled/completed/disputed booking",
      "returns an error, never a double refund. Returns the refund breakdown",
      "(refunded, retained, deposit disposition). For a METERED session prefer",
      "rigshare_end_session (settles exact usage); cancelling a metered booking",
      "with usage settles like an early end.",
    ].join(" "),
    inputSchema: {
      booking_id: z.string().uuid(),
      reason: z.string().max(500).optional(),
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
      "so a renter whose budget is about to exhaust can keep going. The additional",
      "authorization hold is placed and the budget raised SERVER-SIDE from the",
      "equipment's canonical per-minute rate — the client never sets the charge.",
      "Only the booking's RENTER can extend. Choose one of the fixed extension",
      "lengths: 15, 30, or 60 minutes. Only actual usage is ever charged; call",
      "rigshare_end_session when done to settle exact usage and release the unused",
      "budget. Pairs with rigshare_get_session_usage (check remaining budget",
      "first). Returns the newly authorized budget.",
    ].join(" "),
    inputSchema: {
      booking_id: z.string().uuid(),
      additional_minutes: z.preprocess((v) => (typeof v === "string" ? Number(v) : v), z.union([z.literal(15), z.literal(30), z.literal(60)])),
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
      booking_id: z.string().uuid(),
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
      "listing as a DRAFT on behalf of the authenticated OWNER — the same fields",
      "as rigshare_create_listing, but nothing goes live. Drafts are UNGATED: no",
      "identity verification and no Stripe Connect payout setup are needed to",
      "DRAFT (matching RIGShare's draft-first flow). Those gates — plus at least",
      "one photo — are required only when you PUBLISH (done on the web, or via the",
      "drafts publish endpoint). No security_ack is required to draft a remote-",
      "access listing; it's required at publish. Idempotent per draft_session_id",
      "(repeat calls with the same id update the same draft). Returns the draft id",
      "+ the draft_session_id to resume it. Use this when the owner isn't verified",
      "yet or wants to finish the listing later.",
    ].join(" "),
    inputSchema: {
      draft_session_id: z.string().min(8).max(128).optional(),
      title: z.string().min(1).max(200).optional(),
      description: z.string().max(5000).optional(),
      category: z.string().optional(),
      make: z.string().max(120).optional(),
      model: z.string().max(120).optional(),
      year: z.number().int().min(1950).max(2035).optional(),
      condition: z.enum(["EXCELLENT", "GOOD", "FAIR"]).optional(),
      daily_rate_usd: z.number().min(0).max(100000).optional(),
      hourly_rate_usd: z.number().min(0).max(100000).optional(),
      weekly_rate_usd: z.number().min(0).max(500000).optional(),
      monthly_rate_usd: z.number().min(0).max(2000000).optional(),
      city: z.string().max(120).optional(),
      state: z.string().optional(),
      zip: z.string().optional(),
      booking_type: z.enum(["INSTANT", "REQUEST"]).optional(),
      billing_mode: z.enum(["FIXED", "METERED"]).optional(),
      remote_access: z
        .object({
          access_type: z.enum(["SSH", "JUPYTER", "DESKTOP", "API"]).optional(),
          endpoint: z.string().url().optional(),
          specs: z.string().max(2000).optional(),
          region: z.string().max(120).optional(),
          max_concurrent: z.number().int().min(1).max(1000).optional(),
          require_mfa: z.boolean().optional(),
        })
        .optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  saveDraftListing,
);

// ─── MCP RESOURCES (canonical copy — single source of truth) ─────────
// Backed by the app's public endpoints so the copy can never drift from the
// code that enforces it. `rigshare://pricing` + `rigshare://owner-onboarding`
// pull /api/public/v1/policy; `rigshare://categories` pulls the categories
// endpoint; `rigshare://terms` + `rigshare://how-it-works` are static URL
// pointers to the web pages.

server.registerResource(
  "rigshare-pricing",
  "rigshare://pricing",
  {
    title: "RIGShare pricing & fees (canonical)",
    description:
      "Live commission tiers, renter service fee (incl. student 3%), subscription prices, listing caps, security-deposit rules, and cancellation schedules — sourced from RIGShare's enforced constants via /api/public/v1/policy. Falls back to bundled copy if unreachable.",
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
              "2. If I have a RIGShare API key, call rigshare_save_draft_listing to capture the listing as a draft (no verification needed to draft) — collect title, rates, photos, and (for tech gear) remote-access config from me first.",
              "3. When I'm ready to go live, call rigshare_create_listing to publish. Identity verification + Stripe Connect payout setup are required once at publish (the tool's error tells me where if they aren't done).",
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
    return toolData(
      `No active RIGShare listings matched those filters. Try broadening (remove location, widen price range, or switch division to "all"). Total in the matching category: 0.${divisionNote}`,
      { listings: [], pagination, total: (pagination as any).total ?? 0 },
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

/** List categories + counts. Cached ~10 min in-memory (P-9). */
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
 * Owner recruitment pitch. No auth. Fetches current pricing/onboarding copy
 * from /policy (short TTL cache, bounded timeout) and gracefully falls back to
 * bundled copy if unreachable — so it never blocks or breaks.
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
async function getOwnerOnboarding(args: Record<string, unknown>) {
  const equipmentType =
    typeof args.equipment_type === "string" ? args.equipment_type.trim() : "";
  const hint = typeof args.division_hint === "string" ? args.division_hint : "";

  // Source the pricing/fee/commission copy LIVE from the app's /policy endpoint
  // (the single source of truth), so a price change never leaves this
  // independently-published package stale. getPolicy() ALWAYS returns a usable
  // object — on any fetch failure it falls back to BUNDLED_POLICY (which mirrors
  // the enforced constants), so this tool can never break on unreachable policy.
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
    "RIGShare is a peer-to-peer rental marketplace. Owners list idle equipment; renters book by the hour, day, or week. You keep the bulk of every rental — RIGShare handles payments (Stripe), insurance proof, identity verification, and security deposits. You control pricing, availability, and who can rent.",
    "",
    // Rendered from the canonical /policy copy (falls back to bundled values).
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
      "- **Session audit logs** (immutable SessionEvent records) for compliance/disputes",
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
      ? "2. Start your listing right away at **https://www.rigshare.app/robotics-ai/list** — no verification needed to DRAFT: add your title, rates, photos, and specs. For remote-access-eligible gear (AI compute, AI infrastructure, IoT sensors), configure your endpoint URL (HTTPS required) + optional API key; RIGShare encrypts everything server-side and proxies renter traffic through a managed gateway with SSRF protection and per-session rate limits."
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
    "- If damage is reported on return, the security deposit (owner-selectable per listing: 0% None, 15% Standard, or 25% Higher of rental total, min $100 when a deposit applies) covers most cases; the dispute flow is AI-assisted and human-reviewed",
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
      signal: init.signal ?? AbortSignal.timeout(FETCH_TIMEOUT_MS),
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
    return toolData(
      `No bookings found${args.status ? ` with status ${args.status}` : ""}.`,
      { bookings: [] },
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
 * POSTs to the /quote endpoint, which recomputes the breakdown server-side via
 * the SAME core createBooking uses and STOPS before creating/charging anything.
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
    `Security deposit (refundable authorization hold): ${f.security_deposit || dollars(d.security_deposit_cents)}`,
    `Grand total incl. deposit hold: ${f.total_amount || dollars(d.total_amount_cents)}`,
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

  // Required scalar fields (title/description/category/make/model/year/condition/
  // daily_rate_usd/city/state/zip) are validated by the Zod input schema before
  // this handler runs. The "at least one photo" rule below is a business rule the
  // schema can't express (photos is optional, but must be non-empty to create).
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
  const blocks = (args.blocks as any[]).map((b) => ({
    starts_at: b?.starts_at,
    ends_at: b?.ends_at,
    ...(b?.reason ? { reason: b.reason } : {}),
  }));

  const res = await fetchAuthJson(RIGSHARE_API_KEY, `${RIGSHARE_V1_API}/availability`, {
    method: "POST",
    body: JSON.stringify({ items: [{ external_id: externalId, blocks }] }),
  });
  if (res.error) return toolError(res.error);

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
      `Conflicts (skipped — a confirmed RIGShare booking already exists): ${result.blocks_conflicting ?? summary.conflicts ?? 0}`,
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
 * note); it never accepts a client-dictated amount, releases the deposit hold,
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
    `Booking cancelled:`,
    ``,
    `Booking ID: ${d.booking_id || args.booking_id}`,
    `Status: ${d.status || "CANCELLED"}`,
    d.policy_rule ? `Policy applied: ${d.policy_rule}` : null,
    ``,
    `Refunded to renter: ${usd(refund.amount_usd, refund.amount_cents)}`,
    (refund.retained_cents || 0) > 0
      ? `Retained (non-refundable per policy, e.g. service fee): ${usd(refund.retained_usd, refund.retained_cents)}`
      : null,
    deposit.had_hold
      ? `Security deposit hold: ${usd(deposit.amount_usd, deposit.amount_cents)} — ${deposit.disposition === "released" ? "released (not charged)" : deposit.disposition}`
      : `Security deposit: none held`,
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
  if (res.error) return toolError(res.error);

  const d = (res.data || {}) as any;
  const usd = (u: any, cents: any) =>
    typeof u === "number" ? `$${u.toFixed(2)}` : `$${(((cents as number) || 0) / 100).toFixed(2)}`;

  return toolText(
    [
      `Session budget extended:`,
      ``,
      `Booking ID: ${d.booking_id || args.booking_id}`,
      `Added: ${d.added_minutes ?? args.additional_minutes} minutes of budget`,
      `Additional authorization hold: ${usd(d.added_authorization_usd, d.added_authorization_cents)}`,
      `New total authorized budget: ${usd(d.new_authorized_budget_usd, d.new_authorized_budget_cents)}`,
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
      // P-8: parse the server's JSON error body (aligns with fetchAuthJson's
      // `data.error` extraction) and classify retryable (5xx) vs terminal (4xx),
      // reflecting a machine-readable code in the message. S2: the request URL
      // is logged to stderr, NEVER surfaced to the model.
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
    // S2: log the URL to stderr; keep it out of the client-facing string.
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
 * fetchJson with a short in-memory TTL (P-9). Only clean successes are cached —
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
 * Fetch the canonical policy JSON (pricing/fee/deposit/onboarding facts) from
 * the app — the single source of truth. Returns the raw parsed body, or null if
 * the endpoint is unreachable (so callers fall back to BUNDLED_POLICY).
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

// ─── Canonical-copy render helpers (sourced from /policy) ────────────
function pctLabel(rate: number): string {
  const v = rate * 100;
  return `${Number.isInteger(v) ? v : Number(v.toFixed(2))}%`;
}
function usdFromCents(cents: number): string {
  if (!cents) return "$0";
  return `$${(cents / 100).toFixed(2)}`;
}
function capLabel(n: number): string {
  return n === -1 || n == null ? "Unlimited" : `${n} listing${n === 1 ? "" : "s"}`;
}
/**
 * Render the owner-selectable deposit tiers (Stage E2) as "None 0% / Standard
 * 15% / Higher 25%". Falls back to the flat `rate` if a policy payload predates
 * the `tiers` field (backward compatible).
 */
function depositTierLabel(dep: NormalizedPolicy["security_deposit"]): string {
  if (dep.tiers && dep.tiers.length) {
    return dep.tiers.map((t) => `${t.label} ${pctLabel(t.rate)}`).join(" / ");
  }
  return pctLabel(dep.rate);
}

/**
 * Render the "## Economics" block from the canonical policy. Reproduces the
 * previously-hardcoded copy EXACTLY when the policy matches the enforced
 * constants — the whole point being that a price change in the app now flows
 * here WITHOUT republishing this npm package.
 */
function renderEconomics(policy: NormalizedPolicy): string[] {
  const c = policy.commission;
  const fee = policy.renter_service_fee;
  const sp = policy.subscription_prices;
  const caps = policy.listing_caps;
  const dep = policy.security_deposit;
  return [
    "## Economics",
    "",
    "| Tier | Monthly fee | Platform commission | Listings cap |",
    "|---|---|---|---|",
    `| Free | $0 | ${pctLabel(c.free)} | ${capLabel(caps.free)} |`,
    `| Pro | ${usdFromCents(sp.pro.monthly_cents)} | ${pctLabel(c.pro)} | ${capLabel(caps.pro)} |`,
    `| Enterprise | ${usdFromCents(sp.enterprise.monthly_cents)} | ${pctLabel(c.enterprise)} | ${capLabel(caps.enterprise)} |`,
    "",
    `- Renters pay up to a ${pctLabel(fee.standard)} service fee on top of your rental total (reduced to ${pctLabel(fee.student)} for verified students); doesn't reduce your payout`,
    `- Security deposit is owner-selectable per listing (${depositTierLabel(dep)} of rental total, minimum $${dep.min_usd} when a deposit applies) on physical/FIXED rentals, placed as an authorization hold and released within 48h of clean return. METERED per-minute Tech sessions have NO deposit; the renter authorizes a usage budget instead`,
    "- Payouts via Stripe Connect, 48-hour hold after rental completion",
    "- Buy-now-pay-later at checkout (Afterpay, Klarna, Affirm, Zip) — improves your conversion with no extra work",
    "",
  ];
}

function toolText(text: string) {
  return {
    content: [{ type: "text" as const, text }],
  };
}

/**
 * Text + structuredContent (P-4). Used by the READ tools that declare an
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
