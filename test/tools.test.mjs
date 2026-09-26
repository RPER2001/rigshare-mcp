// Behavior-parity smoke test for the v2.0.0 McpServer migration.
//
// Boots the exported server over an in-memory transport (no stdio), lists the
// registered tools, asserts all 20 expected tool NAMES are present with an
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
    "daily_rate_usd", "hourly_rate_usd", "weekly_rate_usd", "monthly_rate_usd", "replacement_value_usd", "deposit_display_usd",
    "city", "state", "zip", "photos", "booking_type", "remote_access",
    "billing_mode", "external_id",
  ],
  rigshare_check_availability: ["external_id", "starts_at", "ends_at"],
  rigshare_sync_availability: ["external_id", "blocks"],
  rigshare_start_session: ["booking_id"],
  rigshare_end_session: ["booking_id"],
  rigshare_get_booking: ["booking_id"],
  rigshare_get_session: ["session_id"],
  rigshare_publish_listing: ["draft_id", "security_ack", "ownership_ack"],
  rigshare_cancel_booking: ["booking_id", "reason"],
  rigshare_extend_session: ["booking_id", "additional_minutes"],
  rigshare_get_session_usage: ["booking_id"],
  rigshare_save_draft_listing: [
    "draft_session_id", "title", "description", "category", "make", "model",
    "year", "condition", "daily_rate_usd", "hourly_rate_usd", "weekly_rate_usd",
    "monthly_rate_usd", "city", "state", "zip", "booking_type", "billing_mode",
    "replacement_value_usd", "deposit_display_usd", "remote_access",
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
check(`exactly 20 tools registered (got ${tools.length})`, tools.length === 20);
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
// RIGShare holds no deposit, so the grand total is the charged amount and the
// old "incl. deposit hold" wording is gone.
check("quote: 'Grand total: $148.40'", quoteTxt.includes("Grand total: $148.40"));

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

// ── (c) Resources + prompts registered ───────────────────────────────
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

// ── (d) structuredContent on the READ tools ─────────────────────────
console.log("\n[d] structuredContent:");
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
  // The bundled fallback CANNOT know whether RIGShare's reduced student rate
  // is currently in effect, so `student_rate_active` is null there and the
  // copy must NOT assert 3%. It names the live field instead.
  "onboarding: bundled fee copy does NOT promise 3% from an unknown state",
  !fallbackTxt.includes("reduced to 3% for verified students") &&
    fallbackTxt.includes("student_rate_active"),
);
check(
  "onboarding: signup URL still present",
  fallbackTxt.includes("rigshare.app/robotics-ai/register"),
);

// ── (e2) publish_listing: outbound body uses the SERVER's field names, and a
// gate failure's `code` reaches the hint (fetchAuthJson keeps the error body).
console.log("\n[e2] publish_listing contract:");
{
  let captured = null;
  globalThis.fetch = async (_url, init) => {
    captured = JSON.parse(init?.body || "{}");
    return { ok: true, status: 200, json: async () => ({ success: true, data: { equipment_id: "eq-1", status: "ACTIVE", url: "https://www.rigshare.app/equipment/eq-1" } }) };
  };
  const pubRes = await client.callTool({
    name: "rigshare_publish_listing",
    arguments: { draft_id: "77777777-7777-4777-8777-777777777777", security_ack: true, ownership_ack: true },
  });
  check("publish: sends remote_security_ack + ownership_attested (server keys), nothing else",
    captured !== null &&
      captured.remote_security_ack === true &&
      captured.ownership_attested === true &&
      Object.keys(captured).sort().join(",") === "ownership_attested,remote_security_ack");
  check("publish: renders the live URL on success", textOf(pubRes).includes("Live at: https://www.rigshare.app/equipment/eq-1"));

  globalThis.fetch = async (_url, init) => {
    captured = JSON.parse(init?.body || "{}");
    return { ok: false, status: 403, json: async () => ({ error: "Identity verification required", code: "ID_NOT_VERIFIED" }) };
  };
  const gateRes = await client.callTool({
    name: "rigshare_publish_listing",
    arguments: { draft_id: "77777777-7777-4777-8777-777777777777" },
  });
  const gateTxt = textOf(gateRes);
  check("publish: an unsent ack is omitted (never defaulted)", Object.keys(captured).length === 0);
  check("publish: gate code + hint reach the agent", gateRes.isError === true && gateTxt.includes("[ID_NOT_VERIFIED]") && gateTxt.includes("identity verification"));
}

// ── (e3) Rendered text never invents a deposit or a final refund ─────
console.log("\n[e3] honest money rendering:");
{
  const booking = {
    id: "b-1", confirmationCode: "RS-1", status: "PENDING", billingMode: "FIXED",
    startDate: "2026-10-01T15:00:00Z", endDate: "2026-10-02T15:00:00Z", durationType: "DAILY",
    totalAmount: 10700, securityDeposit: 0, equipment: { title: "Mini excavator", category: "EXCAVATORS" },
  };
  mockFetch({ success: true, data: { bookings: [booking] } });
  const noField = textOf(await client.callTool({ name: "rigshare_list_my_bookings", arguments: {} }));
  check("list_my_bookings: the legacy $0 deposit is not rendered as the owner's deposit",
    noField.includes("Total: $107.00") && !noField.includes("Deposit"));

  mockFetch({ success: true, data: { bookings: [{ ...booking, depositDisplayCents: null }] } });
  const nullField = textOf(await client.callTool({ name: "rigshare_list_my_bookings", arguments: {} }));
  check("list_my_bookings: null displayed deposit reads as none stated, not $0",
    nullField.includes("Deposit: none stated by the owner") && !nullField.includes("$0.00"));

  mockFetch({ success: true, data: { bookings: [{ ...booking, depositDisplayCents: 25000 }] } });
  const figure = textOf(await client.callTool({ name: "rigshare_list_my_bookings", arguments: {} }));
  check("list_my_bookings: a displayed figure is labelled never held",
    figure.includes("Deposit (displayed, never held): $250.00"));

  mockFetch({
    success: true,
    data: {
      booking_id: "33333333-3333-4333-8333-333333333333", cancelled: true, declined: false, status: "CANCELLED",
      billing_mode: "FIXED", refund: { amount_cents: 0, amount_usd: 0, retained_cents: 0, retained_usd: 0, status: "refund_pending" },
      deposit: { had_hold: false, disposition: "none", amount_cents: 0, amount_usd: 0 },
    },
  });
  const pending = textOf(await client.callTool({
    name: "rigshare_cancel_booking",
    arguments: { booking_id: "33333333-3333-4333-8333-333333333333" },
  }));
  check("cancel_booking: refund_pending says the amounts are not final",
    pending.includes("Refund status: PENDING") && pending.includes("not final"));

  mockFetch({ success: true, data: { equipment: { id: "eq-9", status: "ACTIVE", title: "Mini excavator", photos: ["https://x/1.jpg"] } } });
  const upsert = textOf(await client.callTool({
    name: "rigshare_create_listing",
    arguments: {
      title: "Mini excavator", description: "Well kept 3.5 ton mini excavator", category: "EXCAVATORS",
      make: "Kubota", model: "U35", year: 2021, condition: "GOOD", daily_rate_usd: 300,
      replacement_value_usd: 40000, city: "Austin", state: "TX", zip: "78701",
      photos: ["https://example.com/1.jpg"], external_id: "SKU-1",
    },
  }));
  check("create_listing: an external_id match is reported as an update, not a new listing",
    upsert.includes("Existing listing updated") && !upsert.includes("Listing created"));
}

// ── (e4) Money and calendar writes say only what the server did ──────
console.log("\n[e4] extend / sync / booking / listing rendering:");
{
  const BID = "44444444-4444-4444-8444-444444444444";

  // A hold was placed but the new total could not be re-read: null is unknown,
  // never $0.00.
  mockFetch({
    success: true,
    data: {
      booking_id: BID, extended: true, added_minutes: 30,
      added_authorization_cents: 1500, added_authorization_usd: 15,
      new_authorized_budget_cents: null, new_authorized_budget_usd: null,
    },
  });
  const extNull = textOf(await client.callTool({
    name: "rigshare_extend_session",
    arguments: { booking_id: BID, additional_minutes: 30 },
  }));
  check("extend: added hold rendered", extNull.includes("Additional authorization hold: $15.00"));
  check("extend: unknown new total is not rendered as $0.00",
    extNull.includes("could not be read back") && !extNull.includes("$0.00"));

  mockFetch(
    { error: "Auto-pay is not enabled for this API key. The renter can extend the session from the booking page." },
    { ok: false, status: 403 },
  );
  const ext403 = await client.callTool({
    name: "rigshare_extend_session",
    arguments: { booking_id: BID, additional_minutes: 15 },
  });
  check("extend: 403 relays the server reason and says no hold was placed",
    ext403.isError === true &&
      textOf(ext403).includes("Auto-pay is not enabled") &&
      textOf(ext403).includes("No hold was placed"));

  mockFetch({ error: "An internal error occurred" }, { ok: false, status: 500 });
  const ext500 = await client.callTool({
    name: "rigshare_extend_session",
    arguments: { booking_id: BID, additional_minutes: 15 },
  });
  check("extend: a 500 makes no claim about the hold", !textOf(ext500).includes("No hold was placed"));

  // sync_availability: offset times go out as UTC; bad blocks never reach the API.
  let captured = null;
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    calls++;
    captured = JSON.parse(init?.body || "{}");
    return {
      ok: true, status: 200,
      json: async () => ({ success: true, data: { summary: { blocks_created: 1, conflicts: 0 }, results: [{ external_id: "SKU-1", status: "synced", blocks_created: 1, blocks_conflicting: 0 }] } }),
    };
  };
  await client.callTool({
    name: "rigshare_sync_availability",
    arguments: { external_id: "SKU-1", blocks: [{ starts_at: "2026-09-15T08:00:00-05:00", ends_at: "2026-09-15T17:00:00-05:00" }] },
  });
  const sent = captured?.items?.[0]?.blocks?.[0] || {};
  check("sync: offset date-times are sent as UTC",
    sent.starts_at === "2026-09-15T13:00:00.000Z" && sent.ends_at === "2026-09-15T22:00:00.000Z");

  calls = 0;
  const noOffset = await client.callTool({
    name: "rigshare_sync_availability",
    arguments: { external_id: "SKU-1", blocks: [{ starts_at: "2026-09-15T08:00:00", ends_at: "2026-09-15T17:00:00" }] },
  });
  check("sync: a time without Z or an offset is refused before any request",
    noOffset.isError === true && calls === 0 && textOf(noOffset).includes("Nothing was synced"));

  const backwards = await client.callTool({
    name: "rigshare_sync_availability",
    arguments: { external_id: "SKU-1", blocks: [{ starts_at: "2026-09-15T17:00:00Z", ends_at: "2026-09-15T08:00:00Z" }] },
  });
  check("sync: a block that ends before it starts is refused before any request",
    backwards.isError === true && calls === 0 && textOf(backwards).includes("ends_at must be after starts_at"));

  mockFetch({ success: true, data: { summary: { blocks_created: 0, conflicts: 0 }, results: [{ external_id: "SKU-1", status: "error", error: "Failed to sync availability for item", blocks_created: 0, blocks_conflicting: 0 }] } });
  const itemErr = await client.callTool({
    name: "rigshare_sync_availability",
    arguments: { external_id: "SKU-1", blocks: [] },
  });
  check("sync: an item error is an error, not a 'REPLACED' success",
    itemErr.isError === true && !textOf(itemErr).includes("REPLACED"));

  // create_booking on an instant-book listing without auto-pay: no approval step.
  mockFetch({
    success: true,
    data: {
      booking_id: BID, confirmation_code: "RS-9", status: "APPROVED", total_amount: 10700,
      billing_mode: "FIXED", deposit_display_cents: null,
      payment: { status: "pending", auto_pay: false, error: null },
    },
  });
  const instant = textOf(await client.callTool({
    name: "rigshare_create_booking",
    arguments: {
      equipment_id: "55555555-5555-4555-8555-555555555555", start_date: "2026-10-01T08:00:00-05:00",
      end_date: "2026-10-02T08:00:00-05:00", duration_type: "DAILY", coverage_path: "BYOCOI",
    },
  }));
  check("create_booking: an APPROVED (instant-book) booking is not told to wait for the owner",
    instant.includes("no owner approval is needed") && !instant.includes("after the owner approves"));

  // create_booking replay while the original's auto-pay is still running: never "pay now".
  mockFetch({
    success: true,
    data: {
      booking_id: BID, confirmation_code: "RS-9", status: "APPROVED", idempotent: true,
      payment: { settled: false, status: "pending" },
      next_action: { code: "AWAIT_START", actor: "none", description: "Payment in progress — do not pay again. The original request for this booking is still completing." },
    },
  });
  const replay = textOf(await client.callTool({
    name: "rigshare_create_booking",
    arguments: {
      equipment_id: "55555555-5555-4555-8555-555555555555", start_date: "2026-10-01T08:00:00-05:00",
      end_date: "2026-10-02T08:00:00-05:00", duration_type: "DAILY", coverage_path: "BYOCOI",
    },
  }));
  check("create_booking: a duplicate replay says nothing new was booked, and never tells the agent to pay while payment is in progress",
    replay.includes("nothing new was booked or charged") && replay.includes("do not pay again") && !replay.includes("completes checkout at the booking URL now") && !replay.startsWith("Booking created"));

  // A replay of a booking paid by hand never says "via auto-pay"; a failed one still says pay.
  mockFetch({ success: true, data: { booking_id: BID, confirmation_code: "RS-9", status: "CONFIRMED", idempotent: true, payment: { settled: true, status: "paid" }, next_action: { code: "AWAIT_START", actor: "none", description: "Booked." } } });
  const paidReplay = textOf(await client.callTool({ name: "rigshare_create_booking", arguments: { equipment_id: "55555555-5555-4555-8555-555555555555", start_date: "2026-10-01T08:00:00-05:00", end_date: "2026-10-02T08:00:00-05:00", duration_type: "DAILY", coverage_path: "BYOCOI" } }));
  mockFetch({ success: true, data: { booking_id: BID, confirmation_code: "RS-9", status: "APPROVED", idempotent: true, payment: { settled: false, status: "failed" }, next_action: { code: "PAY", actor: "renter", description: "Complete payment." } } });
  const failedReplay = textOf(await client.callTool({ name: "rigshare_create_booking", arguments: { equipment_id: "55555555-5555-4555-8555-555555555555", start_date: "2026-10-01T08:00:00-05:00", end_date: "2026-10-02T08:00:00-05:00", duration_type: "DAILY", coverage_path: "BYOCOI" } }));
  mockFetch({ success: true, data: { booking_id: BID, confirmation_code: "RS-9", status: "PENDING", idempotent: true, payment: { settled: false, status: "pending" }, next_action: { code: "AWAIT_OWNER_APPROVAL", actor: "owner", description: "Waiting for the owner to approve." } } });
  const pendingReplay = textOf(await client.callTool({ name: "rigshare_create_booking", arguments: { equipment_id: "55555555-5555-4555-8555-555555555555", start_date: "2026-10-01T08:00:00-05:00", end_date: "2026-10-02T08:00:00-05:00", duration_type: "DAILY", coverage_path: "BYOCOI" } }));
  check("create_booking: a replay decides on the next-action code — settled says settled (no 'auto-pay' claim), PAY says none recorded, a request-to-book says the owner approves first",
    paidReplay.includes("already settled") && !paidReplay.includes("auto-pay") && failedReplay.includes("none has been recorded yet") && pendingReplay.includes("owner approves the request first") && !pendingReplay.includes("do not pay again"));
  const badKey = await client.callTool({ name: "rigshare_create_booking", arguments: { equipment_id: "55555555-5555-4555-8555-555555555555", start_date: "2026-10-01T08:00:00-05:00", end_date: "2026-10-02T08:00:00-05:00", duration_type: "DAILY", coverage_path: "BYOCOI", idempotency_key: "reserva-grúa-lunes" } });
  check("create_booking: a non-ASCII idempotency_key is refused by the tool with a message naming the rule",
    badKey.isError === true && /printable ASCII/.test(textOf(badKey)));

  // create_booking: an identical booking with a different key is a 409 that names it.
  mockFetch({ success: false, error: "An identical booking was just created for this renter: RS-9 (booking_id x, https://www.rigshare.app/booking/x). This request did not create or charge anything new.", code: "IDENTICAL_BOOKING_RECENT", booking_id: BID, url: "https://www.rigshare.app/booking/x" }, { ok: false, status: 409 });
  const conflict = await client.callTool({
    name: "rigshare_create_booking",
    arguments: {
      equipment_id: "55555555-5555-4555-8555-555555555555", start_date: "2026-10-01T08:00:00-05:00",
      end_date: "2026-10-02T08:00:00-05:00", duration_type: "DAILY", coverage_path: "BYOCOI", idempotency_key: "new-key",
    },
  });
  check("create_booking: a 409 IDENTICAL_BOOKING_RECENT is an error that names the existing booking",
    conflict.isError === true && textOf(conflict).includes("RS-9") && textOf(conflict).includes("did not create or charge"));

  // create_listing: an AI_COMPUTE listing links to the Robotics & AI page.
  mockFetch({ success: true, data: { equipment: { id: "eq-ai", status: "ACTIVE", title: "H100 node", category: "AI_COMPUTE", billing_mode: "FIXED" }, photos_ingested: 1 } });
  const aiListing = textOf(await client.callTool({
    name: "rigshare_create_listing",
    arguments: {
      title: "H100 node", description: "Single H100 80GB node", category: "AI_COMPUTE",
      make: "NVIDIA", model: "H100", year: 2024, condition: "EXCELLENT", daily_rate_usd: 400,
      city: "Austin", state: "TX", zip: "78701", photos: ["https://example.com/1.jpg"],
    },
  }));
  check("create_listing: AI_COMPUTE links to /robotics-ai/equipment/",
    aiListing.includes("Live at: https://www.rigshare.app/robotics-ai/equipment/eq-ai"));
}

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
