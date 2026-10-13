import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

export interface LearnedPattern {
  id: string;
  category: "typo" | "cli_bypass" | "dlp_violation" | "path_mismatch" | "empty_result";
  mistake: string;
  learnedRemedy: string;
  occurrenceCount: number;
  lastObserved: number;
  confidence: number;
}

export interface RecursiveLearningState {
  version: number;
  lastUpdated: number;
  patterns: Record<string, LearnedPattern>;
  typoRemappings: Record<string, string>;
  cliBypassCounter: number;
  dlpInterceptions: number;
  learnedRules: string[];
}

const CACHE_DIR = path.join(os.homedir(), ".pi/agent/cache/pi-ultrasearch");
const MEMORY_FILE = path.join(CACHE_DIR, "learned_memory.json");

let memoryState: RecursiveLearningState | null = null;

function ensureCacheDir(): void {
  try {
    if (!fs.existsSync(CACHE_DIR)) {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
    }
  } catch {}
}

export function loadLearningMemory(): RecursiveLearningState {
  if (memoryState) return memoryState;
  ensureCacheDir();

  try {
    if (fs.existsSync(MEMORY_FILE)) {
      const raw = fs.readFileSync(MEMORY_FILE, "utf-8");
      memoryState = JSON.parse(raw);
      return memoryState!;
    }
  } catch {}

  memoryState = {
    version: 1,
    lastUpdated: Date.now(),
    patterns: {},
    typoRemappings: {},
    cliBypassCounter: 0,
    dlpInterceptions: 0,
    learnedRules: [
      "Rule 01: Enforce exact zero-typo matching on code symbols to prevent hallucinated edits",
      "Rule 02: Auto-route CLI 'find' and 'ripgrep' subprocesses to resident socket IPC",
      "Rule 03: Mask all credentials and block .env files before LLM prompt injection",
      "Rule 04: Default to compact one-line formatting with uncapped match bounds for full context",
    ],
  };

  saveLearningMemory();
  return memoryState;
}

export function saveLearningMemory(): void {
  if (!memoryState) return;
  ensureCacheDir();
  try {
    memoryState.lastUpdated = Date.now();
    fs.writeFileSync(MEMORY_FILE, JSON.stringify(memoryState, null, 2), "utf-8");
  } catch {}
}

/**
 * Record an agent query mistake or empty hit, auto-generating recursive learning suggestions.
 */
export function recordMistake(
  category: "typo" | "cli_bypass" | "dlp_violation" | "path_mismatch" | "empty_result",
  mistake: string,
  remedy: string
): void {
  const state = loadLearningMemory();
  const key = `${category}:${mistake.toLowerCase().trim()}`;

  if (state.patterns[key]) {
    state.patterns[key].occurrenceCount++;
    state.patterns[key].lastObserved = Date.now();
    state.patterns[key].learnedRemedy = remedy;
    state.patterns[key].confidence = Math.min(1.0, state.patterns[key].confidence + 0.1);
  } else {
    state.patterns[key] = {
      id: key,
      category,
      mistake,
      learnedRemedy: remedy,
      occurrenceCount: 1,
      lastObserved: Date.now(),
      confidence: 0.6,
    };
  }

  if (category === "cli_bypass") {
    state.cliBypassCounter++;
  } else if (category === "dlp_violation") {
    state.dlpInterceptions++;
  }

  saveLearningMemory();
}

/**
 * Record a learned typo correction (e.g. `pckage.json` -> `package.json`).
 */
export function learnCorrection(typo: string, correct: string): void {
  const state = loadLearningMemory();
  state.typoRemappings[typo.toLowerCase()] = correct;
  recordMistake("typo", typo, `Agent intended '${correct}'`);
  saveLearningMemory();
}

/**
 * Retrieve a learned correction if the agent made a previously recorded mistake.
 */
export function getLearnedCorrection(query: string): string | null {
  const state = loadLearningMemory();
  return state.typoRemappings[query.toLowerCase()] || null;
}

/**
 * Generate a comprehensive report of recursive learning insights.
 */
export function formatRecursiveLearningReport(): string {
  const state = loadLearningMemory();
  const patternsList = Object.values(state.patterns);

  const lines: string[] = [
    "=== 🧠 Pi-UltraSearch Recursive Learning & Self-Correction Engine ===",
    `Last Updated: ${new Date(state.lastUpdated).toISOString()}`,
    `Learned Failure Patterns: ${patternsList.length}`,
    `Known Typo Remappings: ${Object.keys(state.typoRemappings).length}`,
    `CLI Bypasses Intercepted: ${state.cliBypassCounter}`,
    `DLP Secret Interceptions: ${state.dlpInterceptions}`,
    "",
    "--- Active Governance Rules ---",
    ...state.learnedRules.map((r) => `  * ${r}`),
    "",
  ];

  if (patternsList.length > 0) {
    lines.push("--- Recent Mistakes & Learned Remedies ---");
    const topPatterns = patternsList
      .sort((a, b) => b.occurrenceCount - a.occurrenceCount)
      .slice(0, 10);

    for (const p of topPatterns) {
      lines.push(
        `  [${p.category.toUpperCase()}] "${p.mistake}" (x${p.occurrenceCount}, conf: ${Math.round(p.confidence * 100)}%)`
      );
      lines.push(`    -> Remedy: ${p.learnedRemedy}`);
    }
  } else {
    lines.push("No recurring mistake patterns recorded. Agent operating cleanly.");
  }

  return lines.join("\n");
}
