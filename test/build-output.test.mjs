// Build-output check: the published dist/ is a single, comment-free
// index.js with its shebang intact, and no source maps or declaration files.
//
// Run: `node test/build-output.test.mjs` (after `npx tsc`).

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const DIST = fileURLToPath(new URL("../dist/", import.meta.url));
const TSCONFIG = fileURLToPath(new URL("../tsconfig.json", import.meta.url));

let failures = 0;
function check(label, cond) {
  if (cond) {
    console.log(`  PASS  ${label}`);
  } else {
    console.error(`  FAIL  ${label}`);
    failures++;
  }
}

/** Every comment in a JS/TS file, found with a real parser (so "//" inside a
 * string, URL or regex literal is never mistaken for a comment). */
function findComments(fileName, text) {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const found = new Map();
  const collect = (ranges) => {
    for (const r of ranges || []) found.set(r.pos, text.slice(r.pos, r.end));
  };
  const visit = (node) => {
    collect(ts.getLeadingCommentRanges(text, node.getFullStart()));
    collect(ts.getTrailingCommentRanges(text, node.getEnd()));
    ts.forEachChild(node, visit);
  };
  visit(sf);
  collect(ts.getLeadingCommentRanges(text, sf.endOfFileToken.getFullStart()));
  return [...found.values()];
}

console.log("\n[build] compiler options:");
const { config } = ts.readConfigFile(TSCONFIG, ts.sys.readFile);
const opts = config.compilerOptions || {};
check("tsconfig removeComments is true", opts.removeComments === true);
check("tsconfig emits no declarations", !opts.declaration && !opts.declarationMap);
check("tsconfig emits no source maps", !opts.sourceMap && !opts.inlineSourceMap && !opts.inlineSources);

console.log("\n[build] dist/ contents:");
const files = readdirSync(DIST, { recursive: true }).map(String).sort();
check(`dist/ holds only index.js (found: ${files.join(", ") || "nothing"})`,
  files.length === 1 && files[0] === "index.js");

const js = readFileSync(`${DIST}index.js`, "utf8");
check("dist/index.js starts with the node shebang", js.startsWith("#!/usr/bin/env node\n"));
check("dist/index.js has no sourceMappingURL", !/sourceMappingURL/.test(js));
const comments = findComments("index.js", js);
check(`dist/index.js contains no comments (found ${comments.length})`, comments.length === 0);
for (const c of comments.slice(0, 5)) console.error(`        ${c.slice(0, 120)}`);

console.log(`\n${failures === 0 ? "BUILD OUTPUT CLEAN" : failures + " CHECK(S) FAILED"}`);
process.exit(failures === 0 ? 0 : 1);
