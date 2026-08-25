// Behavior-parity smoke test for the v2.0.0 McpServer migration.
//
// Boots the exported server over an in-memory transport (no stdio), lists the
// registered tools, asserts all 17 expected tool NAMES are present with an
// inputSchema + annotations, and then invokes 3 representative tools (one public
// read, one authed read, one authed write) through the MCP call path with a
// MOCKED global fetch — asserting the rendered output text matches the
// pre-migration format. Run: `node test/tools.test.mjs` (after `npx tsc`).

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

// The server module captures RIGSHARE_API_KEY at import time — set it first so
// the authed tools are enabled, THEN dynamically import the built server.
process.env.RIGSHARE_API_KEY = "test-key-123";
const { server } = await import("../dist/index.js");

const EXPECTED_TOOLS = {
  rigshare_search_equipment: [
    "division", "category", "remote_only", "access_type", "compute_architecture",
    "search", "min_price_daily_usd", "max_price_daily_usd", "city", "state",
    "sort", "page", "limit",
  ],
  rigshare_get_equipment: ["id"],
  rigshare_list_categories: [],
  rigshare_get_owner_onboarding: ["equipment_type", "division_hint"],
  rigshare_list_my_bookings: ["status", "limit", "page"],
  rigshare_list_my_sessions: ["booking_id", "status"],
  rigshare_quote_booking: [
    "equipment_id", "start_date", "end_date", "duration_type", "pickup_type",
    "budget_usd", "coverage_path", "waiver_version", "qualification_answers",
    "qualification_version",
  ],
  rigshare_create_booking: [
    "equipment_id", "start_date", "end_date", "duration_type", "pickup_type",
    "budget_usd", "coverage_path", "waiver_version", "qualification_answers",
    "qualification_version", "idempotency_key",
  ],
  rigshare_create_listing: [
    "title", "description", "category", "make", "model", "year", "condition",
    "daily_rate_usd", "hourly_rate_usd", "weekly_rate_usd", "monthly_rate_usd",
    "city", "state", "zip", "photos", "booking_type", "remote_access",
    "billing_mode", "external_id",
  ],
  rigshare_check_availability: ["external_id", "starts_at", "ends_at"],
  rigshare_sync_availability: ["external_id", "blocks"],
  rigshare_start_session: ["booking_id"],
  rigshare_end_session: ["booking_id"],
  rigshare_cancel_booking: ["booking_id", "reason"],
  rigshare_extend_session: ["booking_id", "additional_minutes"],
  rigshare_get_session_usage: ["booking_id"],
  rigshare_save_draft_listing: [
    "draft_session_id", "title", "description", "category", "make", "model",
    "year", "condition", "daily_rate_usd", "hourly_rate_usd", "weekly_rate_usd",
    "monthly_rate_usd", "city", "state", "zip", "booking_type", "billing_mode",
    "remote_access",
  ],
};

let failures = 0;
function check(label, cond) {
  if (cond) {
    console.log(`  PASS  ${label}`);
  } else {
    console.error(`  FAIL  ${label}`);
    failures++;
  }
}

// Wire the server to an in-memory client (no stdio boot).
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: "parity-test", version: "1.0.0" });
await server.connect(serverTransport);
await client.connect(clientTransport);

// ── (a) Enumerate registered tools ──────────────────────────────────
const { tools } = await client.listTools();
const byName = new Map(tools.map((t) => [t.name, t]));

console.log(`\nRegistered tools (${tools.length}):`);
console.log("─".repeat(72));
for (const t of tools) {
  const a = t.annotations || {};
  const hints = [
    a.readOnlyHint !== undefined ? `ro=${a.readOnlyHint}` : null,
    a.destructiveHint !== undefined ? `destr=${a.destructiveHint}` : null,
    a.idempotentHint !== undefined ? `idem=${a.idempotentHint}` : null,
    a.openWorldHint !== undefined ? `open=${a.openWorldHint}` : null,
  ].filter(Boolean).join(" ");
  const fields = Object.keys(t.inputSchema?.properties || {}).length;
  console.log(
    `  ${t.name.padEnd(32)} title="${t.title || ""}" fields=${fields}  [${hints}]`,
  );
}
console.log("─".repeat(72));

console.log("\n[a] Tool inventory parity:");
check(`exactly 17 tools registered (got ${tools.length})`, tools.length === 17);
for (const [name, fields] of Object.entries(EXPECTED_TOOLS)) {
  const t = byName.get(name);
  if (!t) {
    check(`${name} present`, false);
    continue;
  }
  check(`${name} present`, true);
  check(`${name} has inputSchema (object)`, t.inputSchema?.type === "object");
  check(
    `${name} has annotations`,
    t.annotations && typeof t.annotations === "object" &&
      Object.keys(t.annotations).length > 0,
  );
  const actualFields = Object.keys(t.inputSchema?.properties || {}).sort();
  const expectedFields = [...fields].sort();
  check(
    `${name} input fields match [${expectedFields.join(", ") || "none"}]`,
    JSON.stringify(actualFields) === JSON.stringify(expectedFields),
  );
}
check("no unexpected extra tools", tools.every((t) => EXPECTED_TOOLS[t.name] !== undefined));

// Spot-check a few annotation values are correct.
console.log("\n[a] Annotation spot-checks:");
check("search_equipment readOnlyHint=true, openWorldHint=true",
  byName.get("rigshare_search_equipment").annotations.readOnlyHint === true &&
  byName.get("rigshare_search_equipment").annotations.openWorldHint === true);
check("get_owner_onboarding openWorldHint=false",
  byName.get("rigshare_get_owner_onboarding").annotations.openWorldHint === false);
check("create_booking readOnlyHint=false, idempotentHint=false",
  byName.get("rigshare_create_booking").annotations.readOnlyHint === false &&
  byName.get("rigshare_create_booking").annotations.idempotentHint === false);
check("end_session destructiveHint=true",
  byName.get("rigshare_end_session").annotations.destructiveHint === true);
check("cancel_booking destructiveHint=true",
  byName.get("rigshare_cancel_booking").annotations.destructiveHint === true);
check("sync_availability destructiveHint=true",
  byName.get("rigshare_sync_availability").annotations.destructiveHint === true);

// ── (b) Invoke representative tools with a MOCKED fetch ──────────────
function mockFetch(jsonBody, { ok = true, status = 200 } = {}) {
  globalThis.fetch = async () => ({ ok, status, json: async () => jsonBody });
}
const textOf = (res) => (res.content || []).map((c) => c.text).join("\n");

console.log("\n[b] Handler output parity (mocked fetch):");

// (1) Public read — search_equipment
mockFetch({
  data: [
    {
      title: "H100 Rig",
      division: "robotics-ai",
      category: "AI_COMPUTE",
      rates_usd: { hourly: 3, daily: 60 },
      remote_access: { enabled: true, access_type: "SSH" },
      compute_architecture: "CUDA",
      rating: { average: 4.9, count: 12 },
      url: "https://www.rigshare.app/robotics-ai/equipment/x",
    },
  ],
  pagination: { total: 1, page: 1, total_pages: 1 },
});
const searchRes = await client.callTool({
  name: "rigshare_search_equipment",
  arguments: { division: "robotics-ai", limit: 10 },
});
const searchTxt = textOf(searchRes);
check("search: header 'Found 1 matching listings (page 1 of 1)'",
  searchTxt.includes("Found 1 matching listings (page 1 of 1). Showing 1 on this page:"));
check("search: row '1. H100 Rig (robotics-ai/AI_COMPUTE)'",
  searchTxt.includes("1. H100 Rig (robotics-ai/AI_COMPUTE)"));
check("search: renders '$3/hr' + 'remote (SSH)' + 'CUDA'",
  searchTxt.includes("$3/hr") && searchTxt.includes("remote (SSH)") && searchTxt.includes("CUDA"));

// (2) Authed read — quote_booking (FIXED breakdown)
mockFetch({
  rental_days: 2,
  rental_subtotal_cents: 12000,
  service_fee_cents: 840,
  charged_subtotal_cents: 12840,
  security_deposit_cents: 2000,
  total_amount_cents: 14840,
});
const quoteRes = await client.callTool({
  name: "rigshare_quote_booking",
  arguments: {
    equipment_id: "11111111-1111-1111-1111-111111111111",
    start_date: "2026-08-01T10:00:00Z",
    end_date: "2026-08-03T10:00:00Z",
    duration_type: "DAILY",
  },
});
const quoteTxt = textOf(quoteRes);
check("quote: 'Booking quote (estimate — nothing is charged):'",
  quoteTxt.includes("Booking quote (estimate — nothing is charged):"));
check("quote: 'Rental (2 days): $120.00'", quoteTxt.includes("Rental (2 days): $120.00"));
check("quote: 'Renter service fee: $8.40'", quoteTxt.includes("Renter service fee: $8.40"));
check("quote: 'Grand total incl. deposit hold: $148.40'",
  quoteTxt.includes("Grand total incl. deposit hold: $148.40"));

// (2b) Behavior-parity: date-only start/end must be ACCEPTED (backend is
// Date.parse-lenient; the old tool forwarded any string). A stricter Zod
// .datetime() would wrongly reject these — this locks the parity fix.
mockFetch({
  rental_days: 2, rental_subtotal_cents: 12000, service_fee_cents: 840,
  charged_subtotal_cents: 12840, security_deposit_cents: 2000, total_amount_cents: 14840,
});
const quoteDateOnly = await client.callTool({
  name: "rigshare_quote_booking",
  arguments: {
    equipment_id: "11111111-1111-1111-1111-111111111111",
    start_date: "2026-08-01",
    end_date: "2026-08-03",
    duration_type: "DAILY",
  },
});
check("quote: date-only start/end accepted (not rejected by Zod)",
  quoteDateOnly.isError !== true && textOf(quoteDateOnly).includes("Booking quote"));

// (3) Authed write — end_session (metered settle)
mockFetch({
  booking_id: "22222222-2222-2222-2222-222222222222",
  settled: true,
  billed_cents: 500,
  used_minutes: 30,
  compute_hours: 0.5,
});
const endRes = await client.callTool({
  name: "rigshare_end_session",
  arguments: { booking_id: "22222222-2222-2222-2222-222222222222" },
});
const endTxt = textOf(endRes);
check("end_session: 'Metered session settled:'", endTxt.includes("Metered session settled:"));
check("end_session: 'Compute hours used: 0.5 (30 min)'",
  endTxt.includes("Compute hours used: 0.5 (30 min)"));
check("end_session: 'Settled cost: $5.00'", endTxt.includes("Settled cost: $5.00"));

// (4) Input validation now runs BEFORE the handler (Zod) — a bad UUID is rejected.
mockFetch({}); // should never be reached
const badRes = await client.callTool({
  name: "rigshare_get_equipment",
  arguments: { id: "not-a-uuid" },
});
check("get_equipment: invalid uuid rejected (isError)", badRes.isError === true);

// ── (c) Resources + prompts registered (P2-b modern MCP surface) ─────
console.log("\n[c] Resources + prompts registered:");
const { resources } = await client.listResources();
const resUris = new Set(resources.map((r) => r.uri));
for (const uri of [
  "rigshare://pricing",
  "rigshare://owner-onboarding",
  "rigshare://categories",
  "rigshare://terms",
  "rigshare://how-it-works",
]) {
  check(`resource ${uri} registered`, resUris.has(uri));
}

const { prompts } = await client.listPrompts();
const promptNames = new Set(prompts.map((p) => p.name));
for (const n of ["rent-gpu", "list-my-equipment", "check-my-rentals"]) {
  check(`prompt ${n} registered`, promptNames.has(n));
}
// A prompt renders a template referencing the real tool names.
const rentGpu = await client.getPrompt({
  name: "rent-gpu",
  arguments: { workload: "LLM fine-tuning", budget: "$200/day", region: "us-west" },
});
const rentGpuTxt = (rentGpu.messages || [])
  .map((m) => (m.content?.text ? m.content.text : ""))
  .join("\n");
check(
  "rent-gpu prompt references the real tool names",
  rentGpuTxt.includes("rigshare_search_equipment") &&
    rentGpuTxt.includes("rigshare_quote_booking") &&
    rentGpuTxt.includes("rigshare_create_booking"),
);
check("rent-gpu prompt weaves in the args", rentGpuTxt.includes("LLM fine-tuning"));

// A resource read returns JSON contents.
const termsRes = await client.readResource({ uri: "rigshare://terms" });
check(
  "rigshare://terms read returns the terms URL",
  (termsRes.contents || []).some((c) => (c.text || "").includes("rigshare.app/terms")),
);

// ── (d) structuredContent (P-4) on the READ tools ───────────────────
console.log("\n[d] structuredContent (P-4):");
check(
  "search: structuredContent.listings has 1 row",
  Array.isArray(searchRes.structuredContent?.listings) &&
    searchRes.structuredContent.listings.length === 1,
);
check("search: structuredContent.total === 1", searchRes.structuredContent?.total === 1);
check(
  "search: structuredContent preserves the upstream row (title H100 Rig)",
  searchRes.structuredContent?.listings?.[0]?.title === "H100 Rig",
);
check(
  "quote: structuredContent carries total_amount_cents 14840",
  quoteRes.structuredContent?.total_amount_cents === 14840,
);
// end_session is a WRITE tool — it has NO outputSchema and returns no structuredContent.
check(
  "end_session (write): no structuredContent (text-only, by design)",
  endRes.structuredContent === undefined,
);

// ── (e) Owner-onboarding graceful fallback when /policy is unreachable ─
console.log("\n[e] Owner-onboarding graceful fallback (/policy unreachable):");
// Every fetch FAILS (503). The onboarding tool must still return the BUNDLED
// pricing copy — never error, never hang. (/policy is not cached on failure.)
globalThis.fetch = async () => ({
  ok: false,
  status: 503,
  json: async () => ({ error: "policy endpoint down" }),
});
const onboardFallback = await client.callTool({
  name: "rigshare_get_owner_onboarding",
  arguments: { equipment_type: "H100 GPU server" },
});
const fallbackTxt = textOf(onboardFallback);
check("onboarding: NOT an error despite /policy 503", onboardFallback.isError !== true);
check(
  "onboarding: renders bundled economics (Free 15% / Pro 10% / Enterprise 7%)",
  fallbackTxt.includes("| Free | $0 | 15% | 5 listings |") &&
    fallbackTxt.includes("| Pro | $49.99 | 10% | 15 listings |") &&
    fallbackTxt.includes("| Enterprise | $149.99 | 7% | Unlimited |"),
);
check(
  // The bundled fallback CANNOT know whether RIGShare's student rate is
  // currently switched on (STUDENT_RATE_DISABLED lives in the app), so
  // `student_rate_active` is null there and the copy must NOT assert 3%.
  // It names the live field instead. Asserting the reduction from a null is
  // exactly the drift this fallback is not allowed to reintroduce.
  "onboarding: bundled fee copy does NOT promise 3% from an unknown state",
  !fallbackTxt.includes("reduced to 3% for verified students") &&
    fallbackTxt.includes("student_rate_active") &&
    fallbackTxt.includes("minimum $100"),
);
check(
  "onboarding: signup URL still present",
  fallbackTxt.includes("rigshare.app/robotics-ai/register"),
);

// ── (f) Owner-onboarding renders LIVE /policy values when reachable ──
console.log("\n[f] Owner-onboarding renders LIVE /policy values:");
// Distinct-from-bundled values prove the copy is sourced from /policy, not the
// hardcoded fallback. (Fallback above failed, so /policy is uncached.)
globalThis.fetch = async () => ({
  ok: true,
  status: 200,
  json: async () => ({
    version: "live-test",
    commission: { free: 0.2, pro: 0.12, enterprise: 0.08, student: 0.07 },
    renter_service_fee: { standard: 0.07, student: 0.03 },
    // The live payload is the ONLY place this can be known. `true` here is what
    // licenses the "reduced to 3%" clause below.
    student_rate_active: true,
    subscription_prices: {
      pro: { monthly_cents: 5999, yearly_cents: 59900 },
      enterprise: { monthly_cents: 14999, yearly_cents: 149900 },
    },
    listing_caps: { free: 5, pro: 15, enterprise: -1, student: null },
    security_deposit: { rate: 0.15, min_cents: 10000, min_usd: 100, metered: false },
  }),
});
const onboardLive = await client.callTool({
  name: "rigshare_get_owner_onboarding",
  arguments: { equipment_type: "excavator" },
});
const liveTxt = textOf(onboardLive);
check(
  "onboarding: renders LIVE commission (Free 20% / Pro 12% / Enterprise 8%)",
  liveTxt.includes("| Free | $0 | 20% |") &&
    liveTxt.includes("12%") &&
    liveTxt.includes("8%"),
);
check("onboarding: renders LIVE Pro price $59.99", liveTxt.includes("$59.99"));
check(
  "onboarding: quotes the student reduction ONLY because /policy said the rate is active",
  liveTxt.includes("reduced to 3% for verified students"),
);

await client.close();
await server.close();

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : failures + " CHECK(S) FAILED"}`);
process.exit(failures === 0 ? 0 : 1);
