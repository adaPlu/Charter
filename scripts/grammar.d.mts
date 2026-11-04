// Types for scripts/grammar.mjs, so TypeScript tests can use the recognizer and generator.
export interface Grammar { rules: Map<string, unknown>; order: string[] }
export const TOKEN_CLASSES: string[];
export const LEXICAL_HELPERS: string[];
export function loadGrammar(text: string): Grammar;
export function grammarProblems(g: Grammar, start?: string): string[];
export function grammarStats(g: Grammar): { productions: number; syntacticRules: number; reservedWords: string[]; symbols: string[] };
export function recognize(g: Grammar, src: string, start?: string): { ok: boolean; line?: number; col?: number; message?: string };
export function generate(g: Grammar, rng: () => number, start?: string, budget?: number): string;
export function seededRng(seed: number): () => number;
export function grammarHash(text: string): string;
