import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { appendJsonl } from "../../lib/jsonl.js";
import { parseV2Message } from "./router.js";
import { resolveRepo, revalidateRepo } from "./repo-resolver.js";
import { runTurnWithSession, clearSessionId } from "./session.js";
import { makeClaudeAdapter, makeCodexAdapter } from "./agent-adapter.js";
import { makeTurnController, registerActiveTurn, unregisterActiveTurn, stopAllTurns, appendV2Run } from "./kill.js";
import { buildStartAck, buildStatusReport, outcomeMessage, resolverErrorMessage, routerErrorMessage } from "./ux.js";
import { checkSafety, getTelegramCodexPolicy } from "../safety.js";

// v2 turn record schema version.
const SCHEMA_VERSION = 2;

// ─── v2 turn id ───────────────────────────────────────────────────────────────

function makeTurnId() {
  return `v2turn_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
}

// ─── Versioned callback data ──────────────────────────────────────────────────
// v2 callback data: "v2:turn:<turn_id>:<action>"
// This namespace is distinct from v1 callbacks to avoid conflicts.

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

// ─── Main v2 message handler ──────────────────────────────────────────────────

// Handle a single incoming Telegram message for the v2 path.
// Returns { handled: true/false, reply, turnId, outcome } or null if not v2.
//
// Injectable: execFileImpl lets tests avoid real spawns.
export async function handleV2Message({
  agentHome,
  ownerUserId,
  chatId,
  text,
  execFileImpl,
  adapters, // { claude, codex } — injectable for tests
  now = Date.now(),
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

  // Register the turn so kill switch / /stop can cancel it.
  registerActiveTurn(turnId, { controller, pid: null, chatId, repoToplevel });

  // Build ack message.
  const keyDims = { ownerUserId, chatId, agent, repoToplevel, mode };
  const { getSessionId } = await import("./session.js");
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

  if (!result.ok) {
    const outcomeReason = result.outcome || "outcome_unknown";
    const detail = result.errorDetail;
    const reply = outcomeMessage(outcomeReason, detail);
    return {
      handled: true,
      reply,
      turnId,
      outcome: outcomeReason,
      ack: ackMessage,
    };
  }

  return {
    handled: true,
    reply: result.text,
    turnId,
    outcome: "ok",
    sessionId: result.sessionId,
    ack: ackMessage,
    tokens: result.tokens,
  };
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
