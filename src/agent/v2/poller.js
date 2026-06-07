import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { appendJsonl, readJsonl } from "../../lib/jsonl.js";
import { parseV2Message } from "./router.js";
import { resolveRepo, revalidateRepo } from "./repo-resolver.js";
import { runTurnWithSession, clearSessionId, listSessions, getSessionId } from "./session.js";
import { makeClaudeAdapter, makeCodexAdapter } from "./agent-adapter.js";
import { makeTurnController, registerActiveTurn, unregisterActiveTurn, stopAllTurns, appendV2Run, listActiveTurns } from "./kill.js";
import { buildStartAck, buildStatusReport, outcomeMessage, resolverErrorMessage, routerErrorMessage } from "./ux.js";
import { checkSafety, getTelegramCodexPolicy } from "../safety.js";
import { agentPaths } from "../paths.js";

// v2 turn record schema version.
const SCHEMA_VERSION = 2;

// ─── v2 turn id ───────────────────────────────────────────────────────────────

function makeTurnId() {
  return `v2turn_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
}

// ─── Versioned callback data ──────────────────────────────────────────────────
// v2 callback data: "v2:turn:<turn_id>:<action>"
// RESERVED for Phase 3 — these helpers are not yet wired to a real callback path.
// Do not use until Phase 3 ships the approval/status callback flow.

export function makeV2CallbackData(turnId, action) {
  return `v2:turn:${turnId}:${action}`;
}

export function parseV2Callback(data) {
  const match = String(data || "").match(/^v2:turn:([A-Za-z0-9_-]+):([A-Za-z0-9_-]+)$/);
  if (!match) return null;
  return { namespace: "v2", turnId: match[1], action: match[2] };
}

// Parse a v1 callback to check if it's legacy (anything not v2).
export function isV1Callback(data) {
  return Boolean(data) && !String(data).startsWith("v2:");
}

// ─── v2 outbox ────────────────────────────────────────────────────────────────
// Durable JSONL outbox for background turn results. The poll cycle flushes it
// each iteration (§15.A). Each entry: { id, chat_id, text, status }.

function v2OutboxPath(agentHome) {
  return agentPaths(agentHome).v2Outbox;
}

export function appendV2Outbox(agentHome, entry) {
  appendJsonl(v2OutboxPath(agentHome), entry);
}

export function readV2Outbox(agentHome) {
  try {
    return readJsonl(v2OutboxPath(agentHome));
  } catch {
    return [];
  }
}

// Collect the latest state of each outbox entry (last-writer-wins per id).
export function latestV2Outbox(agentHome) {
  const latest = new Map();
  for (const entry of readV2Outbox(agentHome)) {
    if (entry.id) {
      latest.set(entry.id, { ...(latest.get(entry.id) || {}), ...entry });
    }
  }
  return Array.from(latest.values());
}

// Mark an outbox entry as sent.
export function markV2OutboxSent(agentHome, id) {
  appendV2Outbox(agentHome, { id, status: "sent", sent_at: new Date().toISOString() });
}

// ─── Main v2 message handler ──────────────────────────────────────────────────

// Handle a single incoming Telegram message for the v2 path.
// BACKGROUND execution (§15.A): returns the start ack immediately and runs
// the agent turn in the background. The result is written to the v2 outbox
// and flushed by the next poll cycle.
//
// Injectable: execFileImpl lets tests avoid real spawns.
// backgroundImpl: injectable for testing (default = run in background via unref'd Promise).
export async function handleV2Message({
  agentHome,
  ownerUserId,
  chatId,
  text,
  execFileImpl,
  adapters, // { claude, codex } — injectable for tests
  now = Date.now(),
  backgroundImpl, // (fn: () => Promise) → void — injectable for tests
} = {}) {
  const parsed = parseV2Message(text);
  if (!parsed) {
    return null; // Not a v2 message.
  }

  // Router error.
  if (!parsed.ok) {
    return {
      handled: true,
      reply: routerErrorMessage(parsed.reason, parsed.detail),
      turnId: null,
      outcome: "router_error",
      reason: parsed.reason,
    };
  }

  const { agent, repo: repoInput, mode, prompt } = parsed;

  // Kill switch check.
  const safetyGuard = checkSafety(agentHome);
  if (!safetyGuard.ok) {
    return {
      handled: true,
      reply: `Agent unavailable: ${safetyGuard.reason}`,
      turnId: null,
      outcome: "kill_switch",
    };
  }

  // Resolve repo.
  const policy = getTelegramCodexPolicy(agentHome);
  const workspaceRoot = policy.workspace_root || null;
  const defaultRepo = policy.default_repo || null;

  const resolved = await resolveRepo({
    workspaceRoot,
    input: repoInput,
    defaultRepo,
    execFileImpl,
  });

  if (!resolved.ok) {
    return {
      handled: true,
      reply: resolverErrorMessage(resolved.reason),
      turnId: null,
      outcome: "resolver_error",
      reason: resolved.reason,
    };
  }

  const repoToplevel = resolved.toplevel;

  // Re-validate just before spawn (best-effort TOCTOU check).
  const preSpawn = await revalidateRepo(repoToplevel, execFileImpl);
  if (!preSpawn.ok) {
    return {
      handled: true,
      reply: resolverErrorMessage(preSpawn.reason),
      turnId: null,
      outcome: "resolver_error",
      reason: preSpawn.reason,
    };
  }

  // Create turn.
  const turnId = makeTurnId();
  const { signal, controller } = makeTurnController();

  // Select adapter.
  const adapter = adapters
    ? adapters[agent]
    : agent === "codex"
      ? makeCodexAdapter({ agentHome })
      : makeClaudeAdapter({ agentHome });

  if (!adapter) {
    return {
      handled: true,
      reply: `Unknown agent: ${agent}`,
      turnId: null,
      outcome: "unknown_agent",
    };
  }

  // Register the turn immediately (PID updated via onSpawn callback once child starts).
  registerActiveTurn(turnId, { controller, pid: null, chatId, repoToplevel });

  // Build ack message (shown immediately before background turn starts).
  const keyDims = { ownerUserId, chatId, agent, repoToplevel, mode };
  const existingSessionId = getSessionId(agentHome, keyDims);
  const ackMessage = buildStartAck({ agent, repoToplevel, mode, sessionId: existingSessionId, turnId });

  // Record the start.
  const startRecord = {
    turn_id: turnId,
    schema_version: SCHEMA_VERSION,
    agent,
    repo_toplevel: repoToplevel,
    mode,
    owner_user_id: String(ownerUserId || ""),
    chat_id: String(chatId || ""),
    session_id_at_start: existingSessionId,
    started_at: new Date(now).toISOString(),
    status: "started",
  };
  appendV2Run(agentHome, startRecord);

  // §15.A: Run the turn in the background. The ack is returned immediately;
  // the result is written to the v2 outbox for the next poll cycle to flush.
  const runBackground = backgroundImpl || defaultBackground;
  runBackground(async () => {
    let result;
    try {
      result = await runTurnWithSession({
        agentHome,
        ownerUserId,
        chatId,
        agent,
        repoToplevel,
        mode,
        prompt,
        model: null,
        signal,
        adapter,
        now,
        // §15.B: report PID to registry as soon as the child spawns.
        onSpawn: (pid) => {
          const entry = { controller, pid, chatId, repoToplevel };
          registerActiveTurn(turnId, entry);
        },
      });
    } catch (error) {
      result = {
        ok: false,
        text: "",
        sessionId: null,
        tokens: 0,
        outcome: "outcome_unknown",
        errorDetail: String(error?.message || error || ""),
        sessionRetried: false,
      };
    } finally {
      unregisterActiveTurn(turnId);
    }

    // Record the result.
    const endRecord = {
      turn_id: turnId,
      schema_version: SCHEMA_VERSION,
      agent,
      repo_toplevel: repoToplevel,
      mode,
      owner_user_id: String(ownerUserId || ""),
      chat_id: String(chatId || ""),
      session_id_at_end: result.sessionId,
      tokens: result.tokens,
      outcome: result.outcome || (result.ok ? "ok" : "outcome_unknown"),
      session_retried: result.sessionRetried || false,
      ended_at: new Date().toISOString(),
      status: result.ok ? "done" : (signal.aborted ? "cancelled" : "failed"),
    };
    appendV2Run(agentHome, endRecord);

    // Write result to v2 outbox so the poll cycle can flush it (§15.A).
    let replyText;
    if (!result.ok) {
      const outcomeReason = result.outcome || "outcome_unknown";
      const detail = result.errorDetail;
      replyText = outcomeMessage(outcomeReason, detail);
    } else {
      replyText = result.text;
    }
    const outboxId = `v2turn_result_${turnId}`;
    appendV2Outbox(agentHome, {
      id: outboxId,
      chat_id: String(chatId || ""),
      text: String(replyText || ""),
      turn_id: turnId,
      outcome: result.outcome || (result.ok ? "ok" : "outcome_unknown"),
      status: "queued",
      created_at: new Date().toISOString(),
    });
  });

  // Return immediately with just the ack (§15.A).
  return {
    handled: true,
    reply: ackMessage,
    turnId,
    outcome: "started",
    ack: ackMessage,
  };
}

// Default background runner: fire-and-forget (unref'd so it doesn't block process exit).
function defaultBackground(fn) {
  const p = fn();
  if (p && typeof p.catch === "function") {
    p.catch(() => {}); // swallow — errors go to the outbox
  }
}

// ─── /stop command handler ────────────────────────────────────────────────────

export function handleV2Stop() {
  const stopped = stopAllTurns();
  if (stopped.length === 0) {
    return { reply: "No active v2 turns to stop." };
  }
  return { reply: `Stopped ${stopped.length} active turn(s): ${stopped.join(", ")}` };
}

// ─── /status command handler ──────────────────────────────────────────────────

export function handleV2Status(agentHome, { ownerUserId, chatId, agent, repoToplevel, mode } = {}) {
  const report = buildStatusReport(agentHome, { ownerUserId, chatId, agent, repoToplevel, mode });
  return { reply: report };
}

// ─── v1/v2 routing ────────────────────────────────────────────────────────────

// Route a single Telegram update: v2 if it looks like @agent ..., else v1.
// Returns { routed: "v2" | "v1" | "none" }.
export function routeUpdate(text) {
  if (parseV2Message(text)) {
    return "v2";
  }
  return "v1";
}

// Append a schema_version to a new v1 task record (used when creating tasks).
export const V1_SCHEMA_VERSION = 1;
export function withSchemaVersion(record, version = V1_SCHEMA_VERSION) {
  return { schema_version: version, ...record };
}
