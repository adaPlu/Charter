# Charter semantics

The normative typing rules and step semantics currently live in the design document:

| Topic | Where |
|---|---|
| Execution model: programs, state, steps, determinism | [Design doc, 2.1](../docs/charter-design.md#21-execution-model) |
| Types, refinements and narrowing | [Design doc, 2.3](../docs/charter-design.md#23-type-system), amended by A4 and A13 |
| Effects and capabilities | [Design doc, 2.4](../docs/charter-design.md#24-effects-and-capabilities), amended by A6 |
| Outcomes and errors | [Design doc, 2.5](../docs/charter-design.md#25-control-flow-iteration-errors-and-transactions), amended by A7 |
| Typing rules and the operational semantics of a step | [Design doc, 2.8](../docs/charter-design.md#28-semantics), amended by A3 and A5 |
| Graph, anchors and hashes | [Design doc, 2.9](../docs/charter-design.md#29-semantic-graph-serialization-and-node-identity-spec), amended by A1 and A10 |
| Grammar | [charter.ebnf](charter.ebnf), frozen at v0.1. It supersedes the grammar in section 2.7. |
| Amendments | [amendments.md](amendments.md) |

Milestone 1 moves the typing rules here as the checker is written, one rule per section, each with the conformance cases that exercise it.
