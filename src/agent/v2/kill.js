// v2 Kill switch & /stop implementation (§7).
//
// - Tracks active turns with their child process handle / AbortController.
// - /stop and kill switch terminate the active child's whole process group.
// - On kill-switch-on, all active turns are terminated.
// - Turn records are marked cancelled/timed_out accordingly.

import fs from "node:fs";
import path from "node:path";

// Grace period between SIGTERM and SIGKILL when terminating a process group (§15.C).
const KILL_GRACE_MS = 5000;
// How long to poll for the group to actually disappear after SIGKILL.
const CONFIRM_TIMEOUT_MS = 2000;
const CONFIRM_POLL_MS = 100;

// ─── Active-turn registry ─────────────────────────────────────────────────────
// In-memory, per-process. Maps turnId → { controller, pid, chatId, repoToplevel, keyDims, startedAt }.
const activeTurns = new Map();

export function registerActiveTurn(turnId, { controller, pid, chatId, repoToplevel, keyDims }) {
  activeTurns.set(String(turnId), {
    controller,
    pid: pid || null,
    chatId: String(chatId || ""),
    repoToplevel: String(repoToplevel || ""),
    keyDims: keyDims || null,
    startedAt: new Date().toISOString(),
  });
}

export function unregisterActiveTurn(turnId) {
  activeTurns.delete(String(turnId));
}

export function listActiveTurns() {
  return Array.from(activeTurns.entries()).map(([id, turn]) => ({ id, ...turn }));
}

// §15.A/§5: one active turn per session key. Find an active turn matching the
// full 5-dim session key, so a second same-key message is refused rather than
// racing the first turn's session id / outbox.
export function findActiveTurnByKey(keyDims) {
  if (!keyDims) return null;
  const eq = (a, b) => String(a ?? "") === String(b ?? "");
  for (const [id, turn] of activeTurns.entries()) {
    const k = turn.keyDims;
    if (!k) continue;
    if (
      eq(k.ownerUserId, keyDims.ownerUserId) &&
      eq(k.chatId, keyDims.chatId) &&
      eq(k.agent, keyDims.agent) &&
      eq(k.repoToplevel, keyDims.repoToplevel) &&
      eq(k.mode, keyDims.mode)
    ) {
      return { id, ...turn };
    }
  }
  return null;
}

// Create an AbortController for a new turn and return signal + controller.
export function makeTurnController() {
  const controller = new AbortController();
  return { signal: controller.signal, controller };
}

// ─── Process-group termination (§15.B/C) ──────────────────────────────────────
// Single authoritative terminate routine: SIGTERM the whole group → grace →
// SIGKILL → confirm the group is actually gone. Shared by /stop, the kill-switch
// sweep, and the adapter timeout/abort paths so there is one mechanism, not three
// half-implementations.

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function signalGroup(pid, sig) {
  try {
    process.kill(-pid, sig);
  } catch {
    // Group signal failed (not a group leader / already gone) — try the bare pid.
    try { process.kill(pid, sig); } catch { /* best-effort */ }
  }
}

// True if the process group still has at least one member.
function groupAlive(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (err) {
    // EPERM = exists but owned by another user (still alive); ESRCH = gone.
    return err.code === "EPERM";
  }
}

// SIGTERM → grace → SIGKILL → confirm gone. Resolves { confirmed, escalated }.
export async function terminateGroup(pid, { graceMs = KILL_GRACE_MS } = {}) {
  if (!pid) return { confirmed: false, reason: "no_pid" };

  signalGroup(pid, "SIGTERM");
  const graceDeadline = Date.now() + graceMs;
  while (Date.now() < graceDeadline) {
    if (!groupAlive(pid)) return { confirmed: true, escalated: false };
    await sleep(CONFIRM_POLL_MS);
  }

  // Still alive after the grace period — escalate and confirm.
  signalGroup(pid, "SIGKILL");
  const confirmDeadline = Date.now() + CONFIRM_TIMEOUT_MS;
  while (Date.now() < confirmDeadline) {
    if (!groupAlive(pid)) return { confirmed: true, escalated: true };
    await sleep(CONFIRM_POLL_MS);
  }
  return { confirmed: false, escalated: true };
}

// ─── Stop a specific turn ─────────────────────────────────────────────────────

// Stop the turn with the given id. Returns { ok, reason }.
export async function stopTurn(turnId) {
  const turn = activeTurns.get(String(turnId));
  if (!turn) {
    return { ok: false, reason: "turn_not_found" };
  }
  await killTurn(turn);
  activeTurns.delete(String(turnId));
  return { ok: true, reason: "cancelled" };
}

// Stop ALL active turns (used by kill switch and /stop without an id). Resolves
// only after every group is confirmed gone; entries stay in the registry until
// then so a new same-key turn cannot start while one is still dying.
export async function stopAllTurns() {
  const entries = Array.from(activeTurns.entries());
  await Promise.all(entries.map(async ([id, turn]) => {
    await killTurn(turn);
    activeTurns.delete(id);
  }));
  return entries.map(([id]) => id);
}

async function killTurn(turn) {
  // Abort the promise wrapper (signals the adapter to stop) AND terminate the
  // process group with confirm-gone semantics (§15.B/C).
  if (turn.controller) {
    try { turn.controller.abort(); } catch { /* best-effort */ }
  }
  if (turn.pid) {
    await terminateGroup(turn.pid);
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
