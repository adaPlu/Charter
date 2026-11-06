// Model backends. Every backend turns a conversation into one reply, and reports tokens used.
//   mock          replays the task's reference solution (no model, no cost) - for dry runs
//   mock-repair   first reply is a broken reference, the second is correct - tests the repair loop
//   ollama        a local model through Ollama (free decoding only: Ollama takes JSON schemas, not GBNF)
//   llamacpp      a local llama.cpp server; the only backend that can constrain output to spec/charter.gbnf
//   anthropic     Claude through the official SDK (free decoding: no grammar constraints)
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import type { Task } from "./tasks.ts";

export type Lang = "charter" | "typescript";
export interface Turn { role: "user" | "assistant"; content: string }
export interface Reply { text: string; tokensIn: number; tokensOut: number; refused?: boolean; servedBy?: string }

export interface Backend {
  name: string;
  /** True if this backend can hold output to a grammar (needed for constrained arms). */
  constrains: boolean;
  generate(system: string, turns: Turn[], opts: { lang: Lang; task: Task; attempt: number; grammar?: string; seed: number }): Promise<Reply>;
}

const estimate = (s: string) => Math.ceil(s.length / 4);

function reference(task: Task, lang: Lang): string {
  return readFileSync(join(task.dir, lang === "charter" ? "reference.charter" : "reference.ts"), "utf8");
}

/** A deterministic, compile-breaking change: one the checker must reject. */
function corrupt(src: string, lang: Lang): string {
  return lang === "charter" ? src.replace(/\n  permit /, "\n  permits ") : src.replace("export default app;", "export default ap;");
}

const fence = (src: string, lang: Lang) => "```" + lang + "\n" + src.trimEnd() + "\n```";

export function mockBackend(repair: boolean): Backend {
  return {
    name: repair ? "mock-repair" : "mock",
    constrains: true,
    async generate(system, turns, { lang, task, attempt }) {
      const src = reference(task, lang);
      const text = fence(repair && attempt === 0 ? corrupt(src, lang) : src, lang);
      return { text, tokensIn: estimate(system + turns.map((t) => t.content).join("")), tokensOut: estimate(text) };
    },
  };
}

export function ollamaBackend(model: string, host = "http://127.0.0.1:11434"): Backend {
  return {
    name: `ollama:${model}`,
    constrains: false,
    async generate(system, turns, { seed }) {
      const res = await fetch(`${host}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, stream: false, options: { seed }, messages: [{ role: "system", content: system }, ...turns] }),
      });
      if (!res.ok) throw new Error(`ollama: HTTP ${res.status} ${await res.text()}`);
      const j = await res.json() as { message: { content: string }; prompt_eval_count?: number; eval_count?: number };
      return { text: j.message.content, tokensIn: j.prompt_eval_count ?? 0, tokensOut: j.eval_count ?? 0, servedBy: model };
    },
  };
}

export function llamacppBackend(host = "http://127.0.0.1:8080"): Backend {
  return {
    name: "llamacpp",
    constrains: true,
    async generate(system, turns, { grammar, seed }) {
      const body: Record<string, unknown> = { seed, messages: [{ role: "system", content: system }, ...turns] };
      if (grammar) body.grammar = grammar;
      const res = await fetch(`${host}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if (!res.ok) throw new Error(`llama.cpp: HTTP ${res.status} ${await res.text()}`);
      const j = await res.json() as { model?: string; choices: { message: { content: string } }[]; usage?: { prompt_tokens: number; completion_tokens: number } };
      return { text: j.choices[0]!.message.content, tokensIn: j.usage?.prompt_tokens ?? 0, tokensOut: j.usage?.completion_tokens ?? 0, servedBy: j.model ?? "llamacpp" };
    },
  };
}

/**
 * Claude through the official SDK. Effort is pinned, because the default differs between
 * models. Refusal fallbacks are off unless asked for: a fallback answers with a different
 * model, which would put another model's output under this model's name in the results.
 */
export function anthropicBackend(model: string, effort: "low" | "medium" | "high" | "xhigh" | "max", fallbacks: boolean): Backend {
  const client = new Anthropic();
  return {
    name: `anthropic:${model}:${effort}${fallbacks ? ":fallbacks" : ""}`,
    constrains: false,
    async generate(system, turns) {
      const messages: Anthropic.MessageParam[] = turns.map((t) => ({ role: t.role, content: t.content }));
      const params = { model, max_tokens: 16000, system, messages, output_config: { effort } };
      const response = fallbacks
        ? await client.beta.messages.create({ ...params, betas: ["server-side-fallback-2026-06-01"], fallbacks: [{ model: "claude-opus-4-8" }] } as Anthropic.Beta.MessageCreateParamsNonStreaming)
        : await client.messages.create(params as Anthropic.MessageCreateParamsNonStreaming);
      const text = response.content.map((b) => (b.type === "text" ? b.text : "")).join("");
      return {
        text,
        tokensIn: response.usage.input_tokens,
        tokensOut: response.usage.output_tokens,
        refused: response.stop_reason === "refusal",
        servedBy: response.model,
      };
    },
  };
}

export function makeBackend(spec: string, opts: { effort?: string | undefined; fallbacks?: boolean }): Backend {
  const [kind, ...rest] = spec.split(":");
  const arg = rest.join(":");
  switch (kind) {
    case "mock": return mockBackend(false);
    case "mock-repair": return mockBackend(true);
    case "ollama": if (!arg) throw new Error("ollama needs a model: ollama:<model>"); return ollamaBackend(arg);
    case "llamacpp": return llamacppBackend(arg || undefined);
    case "anthropic": return anthropicBackend(arg || "claude-opus-5-5", (opts.effort ?? "high") as "high", opts.fallbacks ?? false);
    default: throw new Error(`unknown backend ${spec}; use mock, mock-repair, ollama:<model>, llamacpp[:<url>] or anthropic[:<model>]`);
  }
}
