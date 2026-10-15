# Tool-description prompt tax (issue #38)

Date: 2026-10-15 · wave 5 · measured on both harness surfaces from the single
source of truth (`src/tool-schema.ts`; `index.ts` registers the Pi surface and
must keep the main descriptions byte-identical, enforced by
`test/interop-surface.test.ts`).

## Method

```bash
node bench/tool-descriptions.mjs --json     # before: /tmp/wave5-desc-before.json
# ... trim the descriptions ...
node bench/tool-descriptions.mjs --json     # after:  /tmp/wave5-desc-after.json
```

`bench/tool-descriptions.mjs` serializes exactly what the model is charged for:

* **mcp** — one `tools/list` entry per tool: `{name, description, inputSchema}`,
  where `inputSchema` is built with the same `toolJsonSchema` the stdio server
  emits. An MCP harness pays this once per session.
* **pi** — the descriptors `index.ts` registers: `{name, description, parameters}`
  via `bench/lib/pi-tools.mjs` (the same loader `bench/tokens.mjs` uses). A Pi
  session pays this once per session; per the plan's rule it never also loads
  the MCP surface.

Estimator: **`ceil(chars / 4)`**, the documented estimator used by
`bench/tokens.mjs` and `src/formatter.ts`; a whitespace-sensitive bound
`ceil(chars / 3.5)` is reported alongside. These are estimates, not a specific
model tokenizer's counts. The before/after comparison is exact under the
estimator because the same estimator runs over the same serialization; no
model-tokenizer claim is made.

## Before -> after

### mcp (what an MCP harness pays)

| tool | chars before | chars after | est. tok before | est. tok after |
|:--|--:|--:|--:|--:|
| `ultrasearch_query` | 1157 | 930 | 290 | 233 |
| `ultrasearch_grep` | 1201 | 1136 | 301 | 284 |
| `ultrasearch_multi_grep` | 737 | 663 | 185 | 166 |
| `ultrasearch_locate` | 369 | 337 | 93 | 85 |
| `ultrasearch_recent` | 266 | 236 | 67 | 59 |
| `ultrasearch_metrics` | 493 | 450 | 124 | 113 |
| **total** | **4223** | **3752** | **1056** | **938** |

**-11.2%** estimated tokens (-471 chars). The alt bound: 1207 -> 1072.

### pi (what a Pi session pays)

| tool | chars before | chars after | est. tok before | est. tok after |
|:--|--:|--:|--:|--:|
| `ultrasearch_query` | 1150 | 750 | 288 | 188 |
| `ultrasearch_grep` | 1326 | 796 | 332 | 199 |
| `ultrasearch_multi_grep` | 696 | 456 | 174 | 114 |
| `ultrasearch_locate` | 315 | 219 | 79 | 55 |
| `ultrasearch_recent` | 221 | 159 | 56 | 40 |
| `ultrasearch_metrics` | 337 | 286 | 85 | 72 |
| **total** | **4045** | **2666** | **1012** | **667** |

**-34.1%** estimated tokens (-1379 chars). The alt bound: 1156 -> 762.

Combined (not a per-session figure; no harness loads both): 2068 -> 1605
estimated tokens, **-22.4%**.

## What was kept, what was dropped

Kept (semantics, grammar, defaults, safety):

* matching semantics — exact/zero-typo tolerance, globs, extension filters,
  `git:modified|staged|untracked`, `near` proximity, worktree vs `global`;
* all parameter enums (`mode`: literal/regex/symbol/semantic), defaults
  (30/15/1000, `compact` true, `context` 0, `explain` true) and the
  `complete:false` partial-result contract;
* the DLP credential-scrub notice on `grep` (behavioural: output may be masked);
* the cost hints `<0.1ms` / `<1ms` that make the tool choice obvious.

Dropped: marketing adjectives ("Instant", "Ultra-fast", "enterprise"), the
`<1ms`-style restatements, the "[exact] [glob] ..." tag enumeration (replaced by
"match-reason tags"), and duplicated mode/context/tag text that lives on the
parameter that owns it.

One measured correction during the trim: the first `grep` draft moved mode and
context semantics into the main description and the MCP entry **grew**
(1201 -> 1270 chars). Each fact now appears once, on the owning parameter, which
is what produced the final numbers above.

## Regression guard

`test/tool-descriptions.test.ts` asserts the MCP surface stays <= 1000 estimated
tokens (current 938; before the trim it was 1056, so the budget would have failed
the old text) and <= 850 chars of main descriptions, and that every parameter
keeps a non-empty description. Re-measure with `node bench/tool-descriptions.mjs`
before raising the budget.
