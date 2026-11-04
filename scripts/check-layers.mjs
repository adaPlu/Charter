// Enforces Charter's package layering, and above all principle 2 of the design:
// no model may be reachable from the compiler, verifier, interpreter or runtime.
//
// Rules
//   LLM_BOUNDARY       only the intent package may import @charter/llm
//   INTENT_ENTRY       @charter/intent may be reached only by a dynamic import() in cli/src/commands/ask.ts
//   LLM_SDK            model SDKs (openai, @anthropic-ai/*, ...) may appear only in the llm package
//   LAYER              any other @charter/* import must be in the importing package's allowlist
//   UNKNOWN_PACKAGE    @charter/<x> where <x> is not a known package
//   NON_LITERAL        import(expr) or require(expr) with a computed path, which cannot be checked
//   RELATIVE_ESCAPE    a relative path that leaves the importing package
//   MANIFEST           package.json dependencies that break any of the rules above
//
// Usage: node scripts/check-layers.mjs [--root <dir>] [--json]
// Limits: imports are found with regular expressions after comments are removed. That covers
// every import form TypeScript and Node accept, but not code built with eval or new Function.
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, relative, resolve, sep, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PACKAGES, SCOPE, LLM_PACKAGE, LLM_IMPORTERS, INTENT_ENTRY, LLM_SDK_PATTERNS,
} from "./layers.mjs";

const SOURCE_EXT = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

/**
 * Removes comments and replaces every string literal with a placeholder "\u0001<n>\u0001".
 * Text inside strings can then never be mistaken for code. Line numbers are preserved.
 * Returns the masked text and the literal values; a template literal with ${...} has value null.
 */
export function maskSource(src) {
  let out = "";
  const strings = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i], n = src[i + 1];
    if (c === "/" && n === "/") {
      while (i < src.length && src[i] !== "\n") i++;
    } else if (c === "/" && n === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) {
        if (src[i] === "\n") out += "\n";
        i++;
      }
      i += 2;
    } else if (c === '"' || c === "'" || c === "`") {
      const q = c;
      let value = "", newlines = "", interpolated = false;
      i++;
      while (i < src.length && src[i] !== q) {
        if (src[i] === "\\") { value += src[i + 1] ?? ""; i += 2; continue; }
        if (q === "`" && src[i] === "$" && src[i + 1] === "{") interpolated = true;
        if (src[i] === "\n") newlines += "\n";
        value += src[i]; i++;
      }
      i++;
      strings.push(interpolated ? null : value);
      out += `"\u0001${strings.length - 1}\u0001"` + newlines;
    } else {
      out += c; i++;
    }
  }
  return { text: out, strings };
}

const lineOf = (text, index) => text.slice(0, index).split("\n").length;
const STR = `"\\u0001(\\d+)\\u0001"`;

/** Returns every module reference in a source file, with how it was referenced. */
export function findImports(src) {
  const { text, strings } = maskSource(src);
  const found = [];
  const add = (re, kind) => {
    for (const m of text.matchAll(re)) {
      found.push({ spec: strings[Number(m[1])], kind, line: lineOf(text, m.index) });
    }
  };
  add(new RegExp(`\\b(?:import|export)\\s[^;]*?\\bfrom\\s*${STR}`, "g"), "static");
  add(new RegExp(`\\bimport\\s*${STR}`, "g"), "static");
  add(new RegExp(`\\bimport\\s*\\(\\s*${STR}\\s*[,)]`, "g"), "dynamic");
  add(new RegExp(`\\brequire\\s*\\(\\s*${STR}\\s*\\)`, "g"), "require");
  // import( or require( whose argument is not a single string literal cannot be checked.
  for (const m of text.matchAll(new RegExp(`\\b(import|require)\\s*\\(\\s*(?!${STR}\\s*[,)])`, "g"))) {
    found.push({ spec: null, kind: m[1] === "import" ? "dynamic" : "require", line: lineOf(text, m.index) });
  }
  return found;
}

function listFiles(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...listFiles(p));
    else if (SOURCE_EXT.test(entry)) out.push(p);
  }
  return out;
}

const charterTarget = (spec) => spec.slice(SCOPE.length).split("/")[0];
const isSdk = (spec) => LLM_SDK_PATTERNS.some((re) => re.test(spec));

/**
 * Judges one reference from package `pkg`. Returns a violation object or null.
 * `file` is relative to the package directory, with forward slashes.
 */
function judge(pkg, file, ref, pkgDir) {
  const where = { pkg, file, line: ref.line };
  if (ref.spec === null) {
    return { rule: "NON_LITERAL", ...where, message: `${ref.kind} with a computed path cannot be checked; use a string literal` };
  }
  const spec = ref.spec;

  if (spec.startsWith(".")) {
    const target = resolve(pkgDir, dirname(file), spec);
    if (!target.startsWith(pkgDir + sep) && target !== pkgDir) {
      return { rule: "RELATIVE_ESCAPE", ...where, message: `relative import "${spec}" leaves the ${pkg} package; import other packages by name` };
    }
    return null;
  }

  if (isSdk(spec) && pkg !== LLM_PACKAGE) {
    return { rule: "LLM_SDK", ...where, message: `model SDK "${spec}" may only be used in @charter/${LLM_PACKAGE}` };
  }

  if (!spec.startsWith(SCOPE)) return null;
  const target = charterTarget(spec);
  if (target === pkg) return null;
  if (!(target in PACKAGES)) {
    return { rule: "UNKNOWN_PACKAGE", ...where, message: `"${spec}" is not a Charter package` };
  }
  if (target === LLM_PACKAGE && !LLM_IMPORTERS.includes(pkg)) {
    return { rule: "LLM_BOUNDARY", ...where, message: `@charter/${pkg} may not import @charter/${LLM_PACKAGE}; only ${LLM_IMPORTERS.map((p) => "@charter/" + p).join(", ")} may` };
  }
  if (target === "intent" && pkg !== "intent") {
    const okEntry = pkg === INTENT_ENTRY.pkg && file === INTENT_ENTRY.file && ref.kind === "dynamic";
    if (!okEntry) {
      return { rule: "INTENT_ENTRY", ...where, message: `@charter/intent may only be loaded by a dynamic import() in ${INTENT_ENTRY.pkg}/${INTENT_ENTRY.file}` };
    }
    return null;
  }
  if (!(PACKAGES[pkg]?.deps ?? []).includes(target)) {
    return { rule: "LAYER", ...where, message: `@charter/${pkg} may not import @charter/${target}; allowed: ${(PACKAGES[pkg]?.deps ?? []).join(", ") || "none"}` };
  }
  return null;
}

function checkManifest(pkg, pkgDir) {
  const file = join(pkgDir, "package.json");
  if (!existsSync(file)) return [];
  const manifest = JSON.parse(readFileSync(file, "utf8"));
  const out = [];
  const expectedName = SCOPE + pkg;
  if (manifest.name !== expectedName) {
    out.push({ rule: "MANIFEST", pkg, file: "package.json", line: 1, message: `name is "${manifest.name}", expected "${expectedName}"` });
  }
  for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    for (const dep of Object.keys(manifest[field] ?? {})) {
      if (isSdk(dep) && pkg !== LLM_PACKAGE) {
        out.push({ rule: "MANIFEST", pkg, file: "package.json", line: 1, message: `${field} lists model SDK "${dep}"; only @charter/${LLM_PACKAGE} may` });
      }
      if (!dep.startsWith(SCOPE)) continue;
      const target = charterTarget(dep);
      const allowed =
        (PACKAGES[pkg]?.deps ?? []).includes(target) ||
        (target === "intent" && pkg === INTENT_ENTRY.pkg) ||
        (target === LLM_PACKAGE && LLM_IMPORTERS.includes(pkg));
      if (!allowed) {
        out.push({ rule: "MANIFEST", pkg, file: "package.json", line: 1, message: `${field} lists ${dep}, which @charter/${pkg} may not depend on` });
      }
    }
  }
  return out;
}

/** Checks every package under <root>/packages. Returns a list of violations. */
export function checkLayers(root) {
  const packagesDir = join(root, "packages");
  if (!existsSync(packagesDir)) return [];
  const violations = [];
  for (const pkg of readdirSync(packagesDir).sort()) {
    const pkgDir = join(packagesDir, pkg);
    if (!statSync(pkgDir).isDirectory()) continue;
    if (!(pkg in PACKAGES)) {
      violations.push({ rule: "UNKNOWN_PACKAGE", pkg, file: ".", line: 1, message: `packages/${pkg} is not in scripts/layers.mjs` });
      continue;
    }
    violations.push(...checkManifest(pkg, pkgDir));
    for (const abs of listFiles(join(pkgDir, "src"))) {
      const file = relative(pkgDir, abs).split(sep).join("/");
      for (const ref of findImports(readFileSync(abs, "utf8"))) {
        const v = judge(pkg, file, ref, pkgDir);
        if (v) violations.push(v);
      }
    }
  }
  return violations;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const rootIdx = args.indexOf("--root");
  const root = rootIdx >= 0 ? resolve(args[rootIdx + 1]) : join(dirname(fileURLToPath(import.meta.url)), "..");
  const violations = checkLayers(root);
  if (args.includes("--json")) {
    console.log(JSON.stringify(violations, null, 2));
  } else if (violations.length === 0) {
    console.log("check-layers: ok (no model reachable outside @charter/intent and @charter/llm)");
  } else {
    for (const v of violations) console.error(`${v.rule}  packages/${v.pkg}/${v.file}:${v.line}  ${v.message}`);
    console.error(`check-layers: ${violations.length} violation(s)`);
  }
  process.exit(violations.length === 0 ? 0 : 1);
}
