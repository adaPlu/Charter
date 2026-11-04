// Tests for the layer rule. Each fixture is built in a temporary folder, so a planted
// violation never touches the real packages. Run: node --test scripts/
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { checkLayers, findImports } from "./check-layers.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");

/** files: { "verify/src/index.ts": "..." }. Writes a matching package.json per package. */
function fixture(files, manifests = {}) {
  const root = mkdtempSync(join(tmpdir(), "charter-layers-"));
  const pkgs = new Set(Object.keys(files).map((f) => f.split("/")[0]));
  for (const p of Object.keys(manifests)) pkgs.add(p);
  for (const pkg of pkgs) {
    mkdirSync(join(root, "packages", pkg, "src"), { recursive: true });
    const manifest = { name: `@charter/${pkg}`, dependencies: manifests[pkg] ?? {} };
    writeFileSync(join(root, "packages", pkg, "package.json"), JSON.stringify(manifest));
  }
  for (const [path, body] of Object.entries(files)) {
    const abs = join(root, "packages", path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
  return root;
}

function rulesIn(root) {
  try { return checkLayers(root).map((v) => v.rule).sort(); }
  finally { rmSync(root, { recursive: true, force: true }); }
}

test("the real repository has no violations", () => {
  assert.deepEqual(checkLayers(repoRoot), []);
});

test("allowed imports pass, including the one lazy path to intent", () => {
  const root = fixture({
    "verify/src/index.ts": `import { check } from "@charter/types";\nexport * from "./smt.js";`,
    "verify/src/smt.ts": `// mentioning @charter/llm in a comment is fine\nexport const s = "import('@charter/llm')";`,
    "intent/src/index.ts": `import { complete } from "@charter/llm";`,
    "llm/src/index.ts": `import Anthropic from "@anthropic-ai/sdk";`,
    "cli/src/commands/ask.ts": `export async function ask() { await import("@charter/intent"); }`,
  });
  assert.deepEqual(rulesIn(root), []);
});

test("DEMO: a planted model import below the intent layer fails the build", () => {
  const root = fixture({ "verify/src/index.ts": `import { complete } from "@charter/llm";` });
  try {
    const run = spawnSync(process.execPath, [join(here, "check-layers.mjs"), "--root", root], { encoding: "utf8" });
    assert.equal(run.status, 1, "check-layers must exit with status 1");
    assert.match(run.stderr, /LLM_BOUNDARY\s+packages\/verify\/src\/index\.ts:1/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("model SDKs are refused outside the llm package", () => {
  assert.deepEqual(rulesIn(fixture({ "types/src/index.ts": `import OpenAI from "openai";` })), ["LLM_SDK"]);
  assert.deepEqual(rulesIn(fixture({ "interp/src/x.ts": `const a = require("@anthropic-ai/sdk");` })), ["LLM_SDK"]);
});

test("intent cannot be imported statically, or from any other file", () => {
  assert.deepEqual(rulesIn(fixture({ "cli/src/index.ts": `import "@charter/intent";` })), ["INTENT_ENTRY"]);
  assert.deepEqual(rulesIn(fixture({ "cli/src/run.ts": `await import("@charter/intent");` })), ["INTENT_ENTRY"]);
  assert.deepEqual(rulesIn(fixture({ "impact/src/index.ts": `import { x } from "@charter/intent";` })), ["INTENT_ENTRY"]);
});

test("evasion attempts are caught", () => {
  assert.deepEqual(rulesIn(fixture({ "verify/src/a.ts": `const m = "@charter/llm"; await import(m);` })), ["NON_LITERAL"]);
  assert.deepEqual(rulesIn(fixture({ "verify/src/a.ts": `const m = require(name);` })), ["NON_LITERAL"]);
  assert.deepEqual(rulesIn(fixture({ "verify/src/a.ts": `import "../../llm/src/index.js";` })), ["RELATIVE_ESCAPE"]);
  assert.deepEqual(rulesIn(fixture({ "verify/src/a.ts": "await import(`@charter/${p}`);" })), ["NON_LITERAL"]);
});

test("methods named import are not mistaken for dynamic imports", () => {
  const src = `class P {\n  private import(): Import { return this.import(); }\n  require(x: number) { return x; }\n}\nnew P().require(1);`;
  assert.deepEqual(rulesIn(fixture({ "syntax/src/parser.ts": src })), []);
  // A real dynamic import is still seen, even right after a method call.
  assert.deepEqual(rulesIn(fixture({ "verify/src/a.ts": `x.y(); await import("@charter/llm");` })), ["LLM_BOUNDARY"]);
  // A computed import inside a ternary looks like "import(...) :" but is still a call.
  assert.deepEqual(rulesIn(fixture({ "verify/src/a.ts": `const m = c ? await import(name) : null;` })), ["NON_LITERAL"]);
  assert.deepEqual(rulesIn(fixture({ "verify/src/a.ts": `const m = c ? require(name) : null;` })), ["NON_LITERAL"]);
});

test("ordinary layering is enforced", () => {
  assert.deepEqual(rulesIn(fixture({ "syntax/src/index.ts": `import { g } from "@charter/graph";` })), ["LAYER"]);
  assert.deepEqual(rulesIn(fixture({ "store/src/index.ts": `import { t } from "@charter/types";` })), ["LAYER"]);
  assert.deepEqual(rulesIn(fixture({ "graph/src/index.ts": `import { z } from "@charter/nope";` })), ["UNKNOWN_PACKAGE"]);
});

test("package.json dependencies are checked too", () => {
  assert.deepEqual(rulesIn(fixture({}, { verify: { "@charter/llm": "workspace:*" } })), ["MANIFEST"]);
  assert.deepEqual(rulesIn(fixture({}, { types: { openai: "^4.0.0" } })), ["MANIFEST"]);
});

test("findImports sees every import form", () => {
  const specs = findImports(`
    import a from "a"; import { b } from 'b'; import "c"; export * from "d";
    const e = await import("e"); const f = require("f"); import type { G } from "g";
  `).map((r) => r.spec);
  assert.deepEqual(specs.sort(), ["a", "b", "c", "d", "e", "f", "g"]);
});
