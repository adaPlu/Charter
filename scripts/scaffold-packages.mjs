// Writes packages/<name>/package.json and a stub src/index.ts for every package in layers.mjs.
// Existing src/index.ts files are left alone, so this is safe to rerun after code exists.
// Usage: node scripts/scaffold-packages.mjs
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PACKAGES, SCOPE, INTENT_ENTRY } from "./layers.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

for (const [name, info] of Object.entries(PACKAGES)) {
  const dir = join(root, "packages", name);
  mkdirSync(join(dir, "src"), { recursive: true });

  const deps = {};
  for (const d of info.deps) deps[SCOPE + d] = "workspace:*";
  // The cli reaches intent through a dynamic import in one file (see layers.mjs), but the
  // package still has to be installed next to it.
  if (name === INTENT_ENTRY.pkg) deps[SCOPE + "intent"] = "workspace:*";
  for (const [ext, version] of Object.entries(info.external ?? {})) deps[ext] = version;

  const pkg = {
    name: SCOPE + name,
    version: "0.0.0",
    private: true,
    description: info.desc,
    type: "module",
    main: "src/index.ts",
    types: "src/index.ts",
    charter: { milestone: info.milestone },
    dependencies: Object.fromEntries(Object.entries(deps).sort(([a], [b]) => a.localeCompare(b))),
  };
  writeFileSync(join(dir, "package.json"), JSON.stringify(pkg, null, 2) + "\n");

  const index = join(dir, "src", "index.ts");
  if (!existsSync(index)) {
    writeFileSync(
      index,
      `// ${SCOPE}${name}\n// ${info.desc}\n// Planned for milestone ${info.milestone}. Empty until then.\n\nexport {};\n`,
    );
  }
}

// The one allowed path from the cli to the natural-language layer.
const ask = join(root, "packages", INTENT_ENTRY.pkg, INTENT_ENTRY.file);
if (!existsSync(ask)) {
  mkdirSync(dirname(ask), { recursive: true });
  writeFileSync(
    ask,
    [
      "// charter ask \"<request>\": the only command that needs a model (design doc, section 8.4).",
      "// @charter/intent is loaded lazily here and nowhere else, so every other command",
      "// runs on a machine with no model and no API key. check-layers.mjs enforces this.",
      "",
      "export async function ask(request: string): Promise<void> {",
      "  const intent = await import(\"@charter/intent\");",
      "  void intent;",
      "  throw new Error(`charter ask is planned for milestone 7 (request: ${request})`);",
      "}",
      "",
    ].join("\n"),
  );
}

console.log(`Scaffolded ${Object.keys(PACKAGES).length} packages.`);
