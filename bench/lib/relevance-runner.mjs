/**
 * Bridges the live client to the wave1 judgment queries so bench/run.mjs can
 * publish relevance metrics (recall@k, MRR@10, nDCG@10, zero-result rate,
 * false-positive rate, reformulation signal) next to the latency numbers.
 */
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { searchSemanticIntent } from "../../src/semantic.ts";
import { loadJudgments, scoreQuery, aggregateJudgments, toRepoRelative } from "./judgments.mjs";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const CORPUS_ROOT_FALLBACK = REPO_ROOT;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Executes one judgment query through the real client path and returns the
 * ranked repo-relative result paths.
 */
export async function runJudgmentQuery(client, q, corpusRoot, options = {}) {
  const limit = q.params?.limit ?? 10;
  const rel = (p) => toRepoRelative(corpusRoot, p);

  // Issue #36 probe: must be rejected client-side, before the socket.
  if (q.params?.mode === "regex" && q.negative && /\(\w\+\)\+/.test(q.query)) {
    const res = await client.grep(q.query, { mode: "regex", in: corpusRoot, limit, skipAudit: true });
    return { paths: [], errorClass: res.ok ? "unexpected_success" : "client_regex_rejected", error: res.error ?? null, socketReached: res.ok === true };
  }

  if (q.lane === "path" || q.lane === "ranking-frecency" || q.lane === "ranking-boost-ab" || q.lane === "ranking-proximity") {
    if (q.lane === "ranking-frecency") {
      await client.open(path.join(corpusRoot, "README.md"));
      if (options.frecencyWaitSec > 0) await sleep(options.frecencyWaitSec * 1000);
    }
    const searchOptions = { in: corpusRoot, limit, skipAudit: true };
    if (q.params?.near) searchOptions.near = path.join(corpusRoot, q.params.near);
    if (q.params?.boost !== undefined) searchOptions.boost = q.params.boost;
    const res = await client.search(q.query, searchOptions);
    return { paths: (res.hits ?? []).map((h) => rel(h.path)), source: res.source };
  }

  if (q.lane === "semantic") {
    const res = await searchSemanticIntent(client, q.query, { in: corpusRoot, limit });
    return { paths: [...new Set((res.files ?? []).map((f) => rel(f.path)))], confidence: res.confidence };
  }

  if (q.lane === "ranking-symbol-intrafile") {
    const res = await client.grep(q.query, { in: path.join(corpusRoot, "src"), mode: "symbol", limit, skipAudit: true });
    const files = res.files ?? [];
    const clientFile = files.find((f) => rel(f.path) === "src/client.ts");
    const firstMatch = clientFile?.matches?.[0];
    return {
      paths: [...new Set(files.map((f) => rel(f.path)))],
      intraFileTopText: firstMatch?.text ?? null,
      classDeclFirst: Boolean(firstMatch && /class\s+FSearchClient/.test(firstMatch.text)),
    };
  }

  const mode = q.params?.mode ?? (q.lane === "grep-regex" ? "regex" : q.lane === "symbol" ? "symbol" : "literal");
  const res = await client.grep(q.query, { in: corpusRoot, mode, limit, skipAudit: true });
  return {
    paths: [...new Set((res.files ?? []).map((f) => rel(f.path)))],
    source: res.source,
    complete: res.meta?.complete,
    errorClass: !res.ok && res.error ? "grep_error" : undefined,
    error: res.error ?? null,
  };
}

export async function evaluateRunnerJudgments(client, options) {
  const { judgments, corpusRoot, frecencyWaitSec = 0 } = options;
  const rows = [];
  const errors = [];
  let frecencyOpened = false;

  for (const q of judgments.data.queries) {
    try {
      const result = await runJudgmentQuery(client, q, corpusRoot, { frecencyWaitSec });
      if (q.lane === "ranking-frecency") frecencyOpened = true;
      if (result.errorClass) errors.push({ id: q.id, errorClass: result.errorClass, error: result.error ?? null });
      rows.push({
        ...scoreQuery(q, result.paths ?? []),
        source: result.source ?? null,
        classDeclFirst: result.classDeclFirst ?? null,
        intraFileTopText: result.intraFileTopText ?? null,
      });
    } catch (err) {
      errors.push({ id: q.id, errorClass: "exception", error: String(err?.message ?? err) });
      rows.push({ ...scoreQuery(q, []), errorClass: "exception", error: String(err?.message ?? err) });
    }
  }

  return {
    ...aggregateJudgments(rows, judgments),
    corpusRoot,
    frecencyOpened,
    frecencyWaitSec,
    rows,
    errors,
  };
}

export { loadJudgments };
