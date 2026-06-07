// v2 Ack/Status UX (§9).
//
// - Every start ack shows: agent · repo (git top-level real path) · mode · session.
// - /status (and /context) reports agent/repo/mode/session without calling a model.
// - Active repo state by canonical identity; if moved/deleted → repo_unavailable.
// - Failure reasons surfaced to Telegram.

import fs from "node:fs";
import { listActiveTurns } from "./kill.js";
import { getSessionRecord, listSessions } from "./session.js";

// ─── Start ack ───────────────────────────────────────────────────────────────

// Build the ack message shown immediately when a v2 turn starts.
export function buildStartAck({ agent, repoToplevel, mode, sessionId, turnId }) {
  const sessionPart = sessionId ? `session=${shortId(sessionId)}` : "session=new";
  return [
    `▶ ${agent} · ${repoToplevel} · mode=${mode} · ${sessionPart}`,
    `turn=${turnId}`,
  ].join("\n");
}

// ─── /status ─────────────────────────────────────────────────────────────────

// Build the /status reply for the given (ownerUserId, chatId) context.
// §15.I: lists all sessions for (owner, chat) from the session store, plus
// any active turns. Does NOT call any model.
export function buildStatusReport(agentHome, { ownerUserId, chatId, agent, repoToplevel, mode }) {
  // Specific session (if full key provided).
  const session = repoToplevel && agent
    ? getSessionRecord(agentHome, { ownerUserId, chatId, agent, repoToplevel, mode: mode || "read" })
    : null;

  // §15.I: all sessions for this (owner, chat).
  const allSessions = agentHome
    ? listSessions(agentHome).filter(
        (s) =>
          String(s.owner_user_id || "") === String(ownerUserId || "") &&
          String(s.chat_id || "") === String(chatId || ""),
      )
    : [];

  const repoStatus = repoToplevel ? checkRepo(repoToplevel) : "no_active_repo";
  const activeTurns = listActiveTurns().filter(
    (t) => t.chatId === String(chatId) || t.repoToplevel === repoToplevel,
  );

  const lines = [];
  lines.push("── v2 status ──");
  if (agent) lines.push(`agent: ${agent}`);
  if (repoToplevel) {
    lines.push(`repo: ${repoToplevel} (${repoStatus})`);
  } else {
    lines.push("repo: none");
  }
  if (mode) lines.push(`mode: ${mode}`);
  if (session) {
    lines.push(`session: ${shortId(session.session_id)} (updated ${session.updated_at})`);
  } else if (allSessions.length > 0) {
    // Show all sessions for this (owner, chat).
    lines.push(`sessions (${allSessions.length}):`);
    for (const s of allSessions) {
      lines.push(`  ${s.agent}/${s.mode} @ ${s.repo_toplevel}: ${shortId(s.session_id)}`);
    }
  } else {
    lines.push("session: none");
  }
  if (activeTurns.length > 0) {
    lines.push(`active turns: ${activeTurns.map((t) => t.id).join(", ")}`);
  } else {
    lines.push("active turns: none");
  }
  return lines.join("\n");
}

// ─── Failure reason surfacing ─────────────────────────────────────────────────

const OUTCOME_MESSAGES = {
  ok: null,
  capability_blocked: "The agent could not complete this request due to a capability boundary. If this was a read-only turn that tried to write, re-send with mode=write.",
  provider_permission_denied: "The provider denied permission for this operation.",
  repo_access_denied: "The target repository could not be accessed (not a git repo, or gone).",
  timed_out: "The agent timed out. The turn may or may not have partially completed.",
  outcome_unknown: "The result is uncertain (possible network or process issue). For a write turn, inspect git diff before re-sending.",
  spawn_error: "The agent process failed to start.",
};

const RESOLVER_MESSAGES = {
  missing_workspace_root: "No workspace_root is configured and no default_repo to derive one from.",
  invalid_input: "Invalid repo= value. Use repo=<name> (a direct child of workspace_root) or repo=/absolute/path.",
  repo_not_found: "The target repository path does not exist or is not a directory.",
  repo_access_denied: "The target path is not a git repository, is a bare repo, or is not accessible.",
  repo_outside_workspace: "The git top-level of the target repo is outside the workspace root.",
};

const ROUTER_MESSAGES = {
  control_error: "Invalid command syntax",
  write_requires_repo: "mode=write requires an explicit repo= argument.",
  empty_prompt: "No prompt text provided.",
};

export function outcomeMessage(outcome, detail) {
  const base = OUTCOME_MESSAGES[outcome] || `Unknown outcome: ${outcome}`;
  return detail ? `${base}\nDetail: ${detail}` : base;
}

export function resolverErrorMessage(reason) {
  return RESOLVER_MESSAGES[reason] || `Repo resolution failed: ${reason}`;
}

export function routerErrorMessage(reason, detail) {
  const base = ROUTER_MESSAGES[reason] || `Parse error: ${reason}`;
  return detail ? `${base}\n${detail}` : base;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function checkRepo(repoToplevel) {
  try {
    if (!fs.existsSync(repoToplevel)) return "repo_unavailable";
    const stat = fs.statSync(repoToplevel, { throwIfNoEntry: false });
    if (!stat?.isDirectory()) return "repo_unavailable";
    return "ok";
  } catch {
    return "repo_unavailable";
  }
}

function shortId(id) {
  const s = String(id || "");
  return s.length > 12 ? s.slice(0, 12) + "…" : s;
}
