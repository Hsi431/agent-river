// v2 Kill switch & /stop implementation (§7).
//
// - Tracks active turns with their child process handle / AbortController.
// - /stop and kill switch terminate the active child's whole process group.
// - On kill-switch-on, all active turns are terminated.
// - Turn records are marked cancelled/timed_out accordingly.

import fs from "node:fs";
import path from "node:path";

// ─── Active-turn registry ─────────────────────────────────────────────────────
// In-memory, per-process. Maps turnId → { controller, pid, chatId, repoToplevel, startedAt }.
const activeTurns = new Map();

export function registerActiveTurn(turnId, { controller, pid, chatId, repoToplevel }) {
  activeTurns.set(String(turnId), {
    controller,
    pid: pid || null,
    chatId: String(chatId || ""),
    repoToplevel: String(repoToplevel || ""),
    startedAt: new Date().toISOString(),
  });
}

export function unregisterActiveTurn(turnId) {
  activeTurns.delete(String(turnId));
}

export function listActiveTurns() {
  return Array.from(activeTurns.entries()).map(([id, turn]) => ({ id, ...turn }));
}

// Create an AbortController for a new turn and return signal + controller.
export function makeTurnController() {
  const controller = new AbortController();
  return { signal: controller.signal, controller };
}

// ─── Stop a specific turn ─────────────────────────────────────────────────────

// Stop the turn with the given id. Returns { ok, reason }.
export function stopTurn(turnId) {
  const turn = activeTurns.get(String(turnId));
  if (!turn) {
    return { ok: false, reason: "turn_not_found" };
  }
  killTurn(turn);
  activeTurns.delete(String(turnId));
  return { ok: true, reason: "cancelled" };
}

// Stop ALL active turns (used by kill switch and /stop without an id).
export function stopAllTurns() {
  const stopped = [];
  for (const [id, turn] of activeTurns.entries()) {
    killTurn(turn);
    stopped.push(id);
  }
  activeTurns.clear();
  return stopped;
}

function killTurn(turn) {
  // Send abort signal to the promise wrapper (triggers cancellation in adapters).
  if (turn.controller) {
    try {
      turn.controller.abort();
    } catch { /* best-effort */ }
  }
  // Also try to kill the process group directly if we have a PID.
  if (turn.pid) {
    try {
      process.kill(-turn.pid, "SIGTERM");
    } catch {
      // Process may have already exited or be in a different session.
      try {
        process.kill(turn.pid, "SIGTERM");
      } catch { /* best-effort */ }
    }
  }
}

// ─── Run record ──────────────────────────────────────────────────────────────

const V2_RUNS_FILENAME = "v2-runs.jsonl";
const SCHEMA_VERSION = 2;

export function appendV2Run(agentHome, record) {
  const file = path.join(agentHome, V2_RUNS_FILENAME);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify({ schema_version: SCHEMA_VERSION, ...record })}\n`);
}

export function readV2Runs(agentHome) {
  const file = path.join(agentHome, V2_RUNS_FILENAME);
  if (!fs.existsSync(file)) return [];
  try {
    return fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}
