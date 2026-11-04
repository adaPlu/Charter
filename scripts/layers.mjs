// Single source of truth for Charter's package layers (design doc, Phase 8, section 8.2).
// The scaffold script builds package.json files from this map, and check-layers.mjs
// enforces it. Change the map here, never in a package.json by hand.

/** @type {Record<string, { deps: string[], milestone: number, desc: string }>} */
export const PACKAGES = {
  syntax:       { milestone: 1, deps: [], desc: "Lexer, parser, canonical printer, diagnostics, source spans." },
  graph:        { milestone: 1, deps: ["syntax"], desc: "Node schema, anchors, canonical CBOR, hashes, JSON form, anchor matching, operation applier." },
  resolve:      { milestone: 1, deps: ["syntax", "graph"], desc: "Name resolution and the behavioral dependency graph (amendment A1)." },
  types:        { milestone: 1, deps: ["syntax", "graph", "resolve"], desc: "Type and effect checker, narrowing, refinement obligations." },
  verify:       { milestone: 3, deps: ["syntax", "graph", "resolve", "types"], desc: "SMT encoding, Z3 bridge, frame reasoning, loop idioms, proof cache, witnesses. (Refinement obligations start in milestone 1.)" },
  store:        { milestone: 2, deps: [], desc: "SQLite store, single-writer queue, snapshots, migration runner with dry run. Runtime-level: no compiler imports." },
  effects:      { milestone: 4, deps: ["store"], desc: "Capability registry, outbox, dispatcher, confirm and compensate, adapters and their conformance suites." },
  "runtime-ts": { milestone: 5, deps: ["store", "effects"], desc: "Library used by generated apps: transactions, outbox, auth hook, kill switches, spending limits." },
  interp:       { milestone: 1, deps: ["syntax", "graph", "resolve", "types", "store", "effects"], desc: "Reference interpreter of the step semantics, step log, replay." },
  cir:          { milestone: 5, deps: ["syntax", "graph", "resolve", "types", "verify"], desc: "Charter IR, lowering, optimizer passes." },
  "codegen-ts": { milestone: 5, deps: ["syntax", "graph", "resolve", "types", "verify", "cir", "runtime-ts"], desc: "TypeScript, SQL schema, HTTP layer and typed client generation." },
  testing:      { milestone: 1, deps: ["syntax", "graph", "resolve", "types", "verify", "interp", "store", "effects", "cir", "codegen-ts", "runtime-ts"], desc: "Test and property runner, refinement-driven generators, mutation engine, differential tester." },
  impact:       { milestone: 6, deps: ["syntax", "graph", "resolve", "types", "verify", "testing", "interp", "store", "effects", "cir", "codegen-ts", "runtime-ts"], desc: "Transitive hashes, impact reports, permission and guard diffs, equivalence checks." },
  explain:      { milestone: 7, deps: ["syntax", "graph", "resolve", "types", "verify"], desc: "Deterministic gloss templates." },
  llm:          { milestone: 7, deps: ["syntax", "graph"], desc: "Provider-neutral model adapter, grammar export for constrained decoding, context slicer. The only package that may talk to a model." },
  intent:       { milestone: 7, deps: ["syntax", "graph", "resolve", "types", "verify", "testing", "interp", "store", "effects", "impact", "explain", "llm"], desc: "Utterance log, requirement store, frames, lowering templates, clarification policy, repair loop, intent ledger." },
  cli:          { milestone: 1, deps: ["syntax", "graph", "resolve", "types", "verify", "interp", "store", "effects", "cir", "codegen-ts", "runtime-ts", "testing", "impact", "explain"], desc: "The charter command. Reaches intent only through the lazily loaded ask command." },
};

/** The only package allowed to import @charter/llm or any model SDK. */
export const LLM_PACKAGE = "llm";
/** The only package allowed to import @charter/llm. */
export const LLM_IMPORTERS = ["intent"];
/** @charter/intent may be reached only by a dynamic import() in this one file. */
export const INTENT_ENTRY = { pkg: "cli", file: "src/commands/ask.ts" };

/** Model SDKs. Importing any of these outside the llm package fails the build. */
export const LLM_SDK_PATTERNS = [
  /^openai(\/|$)/, /^@anthropic-ai\//, /^@google\/generative-ai(\/|$)/, /^@google\/genai(\/|$)/,
  /^ollama(\/|$)/, /^@mistralai\//, /^cohere-ai(\/|$)/, /^langchain(\/|$)/, /^@langchain\//,
  /^llamaindex(\/|$)/, /^groq-sdk(\/|$)/, /^together-ai(\/|$)/, /^replicate(\/|$)/,
  /^@huggingface\/inference(\/|$)/, /^node-llama-cpp(\/|$)/, /^@xenova\/transformers(\/|$)/,
];

export const SCOPE = "@charter/";
