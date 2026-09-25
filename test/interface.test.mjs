// Interface snapshot test.
//
// MCP clients depend on the exact tool names, input/output schemas, titles and
// annotations this server advertises, plus its resource URIs and prompt
// arguments. This test lists all of them over an in-memory transport and
// compares them with test/interface.snapshot.json. Descriptions are
// deliberately NOT pinned: they are prose and may be reworded between releases.
//
// Run: `node test/interface.test.mjs` (after `npx tsc`).
// After an intentional interface change, regenerate the snapshot with
// `UPDATE_SNAPSHOT=1 node test/interface.test.mjs` and review the diff.
// MCP_ENTRY=<path to a built index.js> checks a different build (for example
// the previously published release) against the same snapshot.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const SNAPSHOT = fileURLToPath(new URL("./interface.snapshot.json", import.meta.url));
const entry = process.env.MCP_ENTRY
  ? pathToFileURL(process.env.MCP_ENTRY).href
  : new URL("../dist/index.js", import.meta.url).href;

// Set before import so every tool registers exactly as it would for a
// configured user. No request is made: listing tools does not call the API.
process.env.RIGSHARE_API_KEY = "test-key-123";
const { server } = await import(entry);

const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: "interface-snapshot", version: "1.0.0" });
await server.connect(serverTransport);
await client.connect(clientTransport);

const { tools } = await client.listTools();
const { resources } = await client.listResources();
const { resourceTemplates } = await client.listResourceTemplates();
const { prompts } = await client.listPrompts();

await client.close();
await server.close();

// Stable key order so the JSON comparison is order-insensitive for object keys
// but still sensitive to array order (enum values, required fields, tool order).
function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.keys(v)
        .sort()
        .map((k) => [k, sortKeys(v[k])]),
    );
  }
  return v;
}

const actual = sortKeys({
  tools: tools.map((t) => ({
    name: t.name,
    title: t.title ?? null,
    inputSchema: t.inputSchema ?? null,
    outputSchema: t.outputSchema ?? null,
    annotations: t.annotations ?? null,
  })),
  resources: resources.map((r) => ({
    uri: r.uri,
    name: r.name,
    title: r.title ?? null,
    mimeType: r.mimeType ?? null,
  })),
  resourceTemplates: resourceTemplates.map((r) => ({
    uriTemplate: r.uriTemplate,
    name: r.name,
  })),
  prompts: prompts.map((p) => ({
    name: p.name,
    title: p.title ?? null,
    arguments: (p.arguments || []).map((a) => ({
      name: a.name,
      required: a.required ?? false,
    })),
  })),
});

if (process.env.UPDATE_SNAPSHOT) {
  writeFileSync(SNAPSHOT, JSON.stringify(actual, null, 2) + "\n");
  console.log(`Snapshot written: ${SNAPSHOT}`);
  process.exit(0);
}

const expected = JSON.parse(readFileSync(SNAPSHOT, "utf8"));

let failures = 0;
function check(label, cond) {
  if (cond) {
    console.log(`  PASS  ${label}`);
  } else {
    console.error(`  FAIL  ${label}`);
    failures++;
  }
}

console.log("\n[interface] tools/list, resources/list, prompts/list vs snapshot:");
check(
  `tool names match (${expected.tools.length} pinned, ${actual.tools.length} listed)`,
  JSON.stringify(actual.tools.map((t) => t.name)) ===
    JSON.stringify(expected.tools.map((t) => t.name)),
);
const expectedByName = new Map(expected.tools.map((t) => [t.name, t]));
for (const t of actual.tools) {
  const e = expectedByName.get(t.name);
  if (!e) continue;
  for (const field of ["title", "inputSchema", "outputSchema", "annotations"]) {
    check(
      `${t.name}.${field} unchanged`,
      JSON.stringify(t[field]) === JSON.stringify(e[field]),
    );
  }
}
check(
  "resources unchanged",
  JSON.stringify(actual.resources) === JSON.stringify(expected.resources),
);
check(
  "resource templates unchanged",
  JSON.stringify(actual.resourceTemplates) === JSON.stringify(expected.resourceTemplates),
);
check(
  "prompts unchanged",
  JSON.stringify(actual.prompts) === JSON.stringify(expected.prompts),
);

console.log(`\n${failures === 0 ? "INTERFACE MATCHES SNAPSHOT" : failures + " CHECK(S) FAILED"}`);
process.exit(failures === 0 ? 0 : 1);
