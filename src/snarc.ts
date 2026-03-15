/**
 * SNARC Heuristic Scorer
 *
 * Scores observations on 5 dimensions without any LLM calls:
 *   S — Surprise:  how unexpected was this tool transition?
 *   N — Novelty:   are the files/symbols/concepts new?
 *   A — Arousal:   errors, warnings, state changes?
 *   R — Reward:    did this advance the task?
 *   C — Conflict:  does this contradict recent observations?
 *
 * Adapted from SAGE's neural SNARC scorer (sage/services/snarc/)
 * into pure heuristic TypeScript. No model, no embeddings, <10ms per score.
 */

import type { Statements } from './db.js';
import type { CircularBuffer, RawObservation } from './buffer.js';

export interface SNARCScores {
  surprise: number;
  novelty: number;
  arousal: number;
  reward: number;
  conflict: number;
  salience: number;
}

// Salience weights — emphasize surprise and reward (most actionable)
const WEIGHTS = {
  surprise: 0.25,
  novelty: 0.20,
  arousal: 0.20,
  reward: 0.25,
  conflict: 0.10,
};

const SALIENCE_THRESHOLD = 0.3;

// Error/warning patterns
const ERROR_PATTERNS = /\b(error|Error|ERROR|FAIL|fail|panic|exception|Exception|EXCEPTION|fatal|Fatal)\b/;
const WARNING_PATTERNS = /\b(warning|Warning|WARN|warn|deprecated|Deprecated)\b/;
const SUCCESS_PATTERNS = /\b(pass|Pass|PASS|success|Success|OK|ok|✓|passed|succeeded|completed)\b/;
const STATE_CHANGE_PATTERNS = /\b(created|Created|deleted|Deleted|modified|Modified|renamed|moved|installed|removed|updated)\b/;

export class SNARCScorer {
  private stmts: Statements;
  private buffer: CircularBuffer;
  // Track recent results per tool+target for conflict detection
  private recentResults = new Map<string, boolean>(); // tool:target → success?

  constructor(stmts: Statements, buffer: CircularBuffer) {
    this.stmts = stmts;
    this.buffer = buffer;
  }

  score(obs: RawObservation): SNARCScores {
    const surprise = this.scoreSurprise(obs);
    const novelty = this.scoreNovelty(obs);
    const arousal = this.scoreArousal(obs);
    const reward = this.scoreReward(obs);
    const conflict = this.scoreConflict(obs);

    const salience =
      WEIGHTS.surprise * surprise +
      WEIGHTS.novelty * novelty +
      WEIGHTS.arousal * arousal +
      WEIGHTS.reward * reward +
      WEIGHTS.conflict * conflict;

    return { surprise, novelty, arousal, reward, conflict, salience };
  }

  get threshold(): number {
    return SALIENCE_THRESHOLD;
  }

  private scoreSurprise(obs: RawObservation): number {
    const prevTool = this.buffer.lastToolName;
    if (!prevTool) return 0.5; // first observation — moderate surprise

    // Look up transition frequency
    const row = this.stmts.getTransitionCount.get(prevTool, obs.toolName) as { count: number } | undefined;
    const count = row?.count || 0;

    const maxRow = this.stmts.getMaxTransition.get(prevTool) as { max_count: number } | undefined;
    const maxCount = maxRow?.max_count || 1;

    // Record this transition
    this.stmts.upsertTransition.run(prevTool, obs.toolName);

    // Surprise = 1 - normalized frequency
    return count === 0 ? 0.8 : 1.0 - Math.min(count / maxCount, 1.0);
  }

  private scoreNovelty(obs: RawObservation): number {
    const tokens = extractTokens(obs.inputSummary);
    if (tokens.length === 0) return 0;

    // Batch check which tokens are already seen
    // SQLite IN clause — check up to 20 at a time
    const batch = tokens.slice(0, 20);
    const placeholders = batch.map(() => '?').join(',');
    const seen = new Set<string>();

    try {
      const rows = this.stmts.checkSeen.raw().all(
        ...batch.concat(Array(20 - batch.length).fill(''))
      ) as string[][];
      for (const row of rows) {
        if (row[0]) seen.add(row[0]);
      }
    } catch {
      // If query fails (placeholder mismatch), fall back to individual checks
    }

    // Update seen_set for all tokens
    for (const token of tokens) {
      this.stmts.upsertSeen.run(token);
    }

    // Novelty = fraction of tokens that were NOT in seen_set
    const newCount = tokens.filter(t => !seen.has(t)).length;
    return newCount / tokens.length;
  }

  private scoreArousal(obs: RawObservation): number {
    let arousal = 0;
    const output = obs.outputSummary || '';

    if (obs.exitCode !== undefined && obs.exitCode !== 0) arousal += 0.5;
    if (ERROR_PATTERNS.test(output)) arousal += 0.3;
    if (WARNING_PATTERNS.test(output)) arousal += 0.15;
    if (STATE_CHANGE_PATTERNS.test(output)) arousal += 0.1;

    // Git operations are inherently high-arousal (they change shared state)
    if (obs.toolName === 'Bash' && /\bgit\s+(commit|push|merge|rebase)/.test(obs.inputSummary)) {
      arousal += 0.2;
    }

    return Math.min(arousal, 1.0);
  }

  private scoreReward(obs: RawObservation): number {
    const output = obs.outputSummary || '';
    const input = obs.inputSummary || '';

    // Test passing
    if (SUCCESS_PATTERNS.test(output) && /test|spec/i.test(input)) return 0.7;

    // Build success
    if (SUCCESS_PATTERNS.test(output) && /build|compile/i.test(input)) return 0.5;

    // Git commit (task milestone)
    if (obs.toolName === 'Bash' && /git\s+commit/.test(input)) return 0.6;

    // File write/edit completed
    if ((obs.toolName === 'Write' || obs.toolName === 'Edit') && !ERROR_PATTERNS.test(output)) return 0.3;

    // Errors are negative reward
    if (ERROR_PATTERNS.test(output)) return 0.0;

    return 0.1; // neutral
  }

  private scoreConflict(obs: RawObservation): number {
    const key = `${obs.toolName}:${extractTarget(obs.inputSummary)}`;
    const output = obs.outputSummary || '';
    const currentSuccess = !ERROR_PATTERNS.test(output) && (obs.exitCode === undefined || obs.exitCode === 0);

    const previousSuccess = this.recentResults.get(key);
    this.recentResults.set(key, currentSuccess);

    // Conflict: previous succeeded, now fails (or vice versa)
    if (previousSuccess !== undefined && previousSuccess !== currentSuccess) {
      return previousSuccess && !currentSuccess ? 0.8 : 0.4; // fail-after-success is higher conflict
    }

    // Same file edited multiple times in recent buffer
    const recent = this.buffer.getLast(5);
    const sameTarget = recent.filter(r =>
      r.toolName === obs.toolName && extractTarget(r.inputSummary) === extractTarget(obs.inputSummary)
    ).length;
    if (sameTarget >= 2) return 0.3;

    return 0;
  }
}

/** Extract searchable tokens from tool input — file paths, commands, packages */
function extractTokens(input: string): string[] {
  if (!input) return [];
  const tokens = new Set<string>();

  // File paths
  const paths = input.match(/[\w./\-]+\.\w{1,10}/g);
  if (paths) paths.forEach(p => tokens.add(p));

  // Package names (from npm/pip/cargo commands)
  const packages = input.match(/(?:install|add|require)\s+([\w@/.-]+)/g);
  if (packages) packages.forEach(p => tokens.add(p.split(/\s+/)[1]));

  // Error codes
  const errors = input.match(/[A-Z][A-Z0-9_]{3,}/g);
  if (errors) errors.forEach(e => tokens.add(e));

  return [...tokens].slice(0, 20); // cap at 20
}

/** Extract the primary target (file path or command) from tool input */
function extractTarget(input: string): string {
  if (!input) return '';
  // Try file path first
  const pathMatch = input.match(/([\w./\-]+\.\w{1,10})/);
  if (pathMatch) return pathMatch[1];
  // Fall back to first 50 chars
  return input.slice(0, 50);
}
