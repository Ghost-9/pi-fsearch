import { UltraSearchClient } from "./client.ts";
import type { UltraSearchGrepFile } from "./types.ts";
import type { AuditTool } from "./telemetry.ts";

/**
 * Common code intent mappings to bridge natural language questions
 * to concrete code tokens and symbols.
 */
const INTENT_CONCEPT_MAP: Record<string, string[]> = {
  auth: ["auth", "login", "jwt", "token", "password", "session", "authenticate"],
  database: ["db", "database", "sql", "prisma", "query", "connection", "schema", "model"],
  payment: ["stripe", "payment", "invoice", "checkout", "billing", "subscription"],
  api: ["route", "endpoint", "controller", "handler", "request", "response"],
  config: ["config", "options", "settings", "env", "constant"],
  test: ["test", "spec", "assert", "mock", "fixture"],
  crypto: ["hash", "encrypt", "decrypt", "cipher", "salt", "signature"],
  cache: ["cache", "redis", "memoize", "store", "ttl"],
};

export interface SemanticSearchResult {
  term: string;
  matchedTokens: string[];
  files: UltraSearchGrepFile[];
  confidence: number;
}

/**
 * Expands natural language query terms into high-probability code symbols.
 */
export function expandIntentKeywords(naturalQuery: string): string[] {
  const normalized = naturalQuery.toLowerCase().replace(/[^a-z0-9_\s]/g, " ");
  const words = normalized.split(/\s+/).filter((w) => w.length > 2);
  const candidateKeywords = new Set<string>();

  for (const word of words) {
    candidateKeywords.add(word);
    // Check concept dictionary
    for (const [concept, synonyms] of Object.entries(INTENT_CONCEPT_MAP)) {
      if (word.includes(concept) || synonyms.includes(word)) {
        synonyms.forEach((s) => candidateKeywords.add(s));
      }
    }
  }

  return Array.from(candidateKeywords).slice(0, 8);
}

/**
 * Performs a semantic/concept search by expanding terms into code tokens
 * and evaluating them across the in-memory trigram index.
 */
export async function searchSemanticIntent(
  client: UltraSearchClient,
  naturalQuery: string,
  options: { in?: string; limit?: number; auditTool?: AuditTool } = {}
): Promise<SemanticSearchResult> {
  const expanded = expandIntentKeywords(naturalQuery);
  const searchLimit = options.limit ?? 20;

  if (expanded.length === 0) {
    return {
      term: naturalQuery,
      matchedTokens: [],
      files: [],
      confidence: 0,
    };
  }

  // Use multiGrep across resident trigram index in single pass
  const grepRes = await client.multiGrep(expanded, {
    in: options.in,
    limit: searchLimit,
    auditTool: options.auditTool,
  });

  const files = grepRes.files || [];
  const confidence = files.length > 0 ? Math.min(1.0, 0.5 + files.length * 0.05) : 0;

  return {
    term: naturalQuery,
    matchedTokens: expanded,
    files,
    confidence,
  };
}
