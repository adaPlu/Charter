// @charter/graph: the semantic graph form of a program, with anchors and hashes
// (design doc, section 2.9).
//
// Milestone 1 scope: anchors are derived from each node's path in the tree (for example
// "rule:PlaceOrder/clauses.2/cond"). Path anchors are stable while declarations keep their
// names and order. Anchors that survive arbitrary edits need the stored graph and the
// operation applier, which arrive in milestone 6.
import { createHash } from "node:crypto";
import { stripSpans, type Decl, type Program } from "@charter/syntax";
import { encodeCbor, type CborValue } from "./cbor.ts";

export { encodeCbor, type CborValue } from "./cbor.ts";

export type Anchor = string;
export type Hash = string;

export interface GraphNode {
  anchor: Anchor;
  kind: string;
  attrs: Record<string, string | number | boolean | null>;
  children: Anchor[];
  hash: Hash;
}

export interface Graph {
  module: string;
  version: string;
  root: Anchor;
  nodes: Record<Anchor, GraphNode>;
  /** Node to requirement links. Kept apart from nodes, and excluded from every hash. */
  links: [Anchor, string][];
}

const sha256 = (bytes: Uint8Array): Hash => createHash("sha256").update(bytes).digest("hex");

/** Removes requirement links, which Phase 2 excludes from hashes. */
function withoutLinks(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(withoutLinks);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) if (k !== "links") out[k] = withoutLinks(x);
    return out;
  }
  return v;
}

/** The hash of a declaration's own content: no positions, no comments, no requirement links. */
export function ownHash(d: Decl): Hash {
  return sha256(encodeCbor(withoutLinks(stripSpans(d)) as CborValue));
}

/** A stable key for a declaration in the module's flat namespace. */
export function declKey(d: Decl): string {
  switch (d.kind) {
    case "Requirement": return `requirement:${d.id}`;
    case "Uses": return `uses:${d.caps.map((c) => `${c.service}.${c.op}`).join(",")}`;
    case "Principal": return `principal:${d.entity}`;
    case "TestDecl": return `test:${d.name}`;
    case "PropertyDecl": return `property:${d.name}`;
    case "Migration": return `migration:${d.from}->${d.to}`;
    case "Trigger": return `on:${d.event.parts.join(".")}->${d.rule}`;
    default: return `${d.kind.toLowerCase()}:${d.name}`;
  }
}

/** Builds the graph form of a program. Child order is the order fields appear in the tree. */
export function toGraph(p: Program): Graph {
  const nodes: Record<Anchor, GraphNode> = {};
  const links: [Anchor, string][] = [];

  const visit = (value: Record<string, unknown>, anchor: Anchor, fallbackKind: string): Hash => {
    const attrs: GraphNode["attrs"] = {};
    const children: Anchor[] = [];
    const childHashes: Hash[] = [];
    for (const key of Object.keys(value).sort()) {
      const v = value[key];
      if (key === "span" || key === "kind" || v === undefined) continue;
      if (key === "links") { for (const id of v as string[]) links.push([anchor, id]); continue; }
      if (v === null || typeof v !== "object") { attrs[key] = v as string | number | boolean; continue; }
      if (Array.isArray(v)) {
        if (v.every((x) => x === null || typeof x !== "object")) { attrs[key] = JSON.stringify(v); continue; }
        v.forEach((item, i) => {
          const a = `${anchor}/${key}.${i}`;
          children.push(a);
          childHashes.push(visit(item as Record<string, unknown>, a, key));
        });
        continue;
      }
      const a = `${anchor}/${key}`;
      children.push(a);
      childHashes.push(visit(v as Record<string, unknown>, a, key));
    }
    const kind = typeof value.kind === "string" ? value.kind : fallbackKind;
    const hash = sha256(encodeCbor({ kind, attrs, children: childHashes } as CborValue));
    nodes[anchor] = { anchor, kind, attrs, children, hash };
    return hash;
  };

  const root = "module";
  const declAnchors: Anchor[] = [];
  const declHashes: Hash[] = [];
  for (const d of p.decls) {
    const a = declKey(d);
    declAnchors.push(a);
    declHashes.push(visit(d as unknown as Record<string, unknown>, a, d.kind));
  }
  const attrs = { name: p.module.parts.join("."), version: p.version, imports: JSON.stringify(p.imports.map((i) => [i.name.parts.join("."), i.range, i.alias ?? null])) };
  nodes[root] = { anchor: root, kind: "Program", attrs, children: declAnchors, hash: sha256(encodeCbor({ kind: "Program", attrs, children: declHashes })) };
  return { module: attrs.name, version: p.version, root, nodes, links };
}
