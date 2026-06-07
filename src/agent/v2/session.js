import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// v2 Session model (§5).
//
// Session key = (owner_user_id, chat_id, agent, repo_toplevel, mode).
// Stored as a JSON file keyed by a stable hash of the tuple plus the raw fields.
//
// Contracts:
// - One active turn per key at a time.
// - Update stored session_id ONLY after a successful provider result.
// - On resume failure: clear key and retry ONCE with fresh session (read turns only).
// - write turns with uncertain outcome: NEVER auto-rerun.
// - Group chats do not share sessions (chat_id + owner_user_id both in key).

const SCHEMA_VERSION = 2;
const SESSIONS_FILENAME = "v2-sessions.json";

function sessionKey({ ownerUserId, chatId, agent, repoToplevel, mode }) {
  const tuple = [
    String(ownerUserId || ""),
    String(chatId || ""),
    String(agent || ""),
    String(repoToplevel || ""),
    String(mode || ""),
  ];
  return crypto.createHash("sha256").update(tuple.join("|")).digest("hex").slice(0, 32);
}

// ─── Storage ─────────────────────────────────────────────────────────────────

function sessionsPath(agentHome) {
  return path.join(agentHome, SESSIONS_FILENAME);
}

function readSessions(agentHome) {
  try {
    const store = JSON.parse(fs.readFileSync(sessionsPath(agentHome), "utf8"));
    return store && typeof store === "object" ? store : {};
  } catch {
    return {};
  }
}

function writeSessions(agentHome, store) {
  const file = sessionsPath(agentHome);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(store, null, 2) + "\n");
}

// ─── Public API ──────────────────────────────────────────────────────────────

// Read the stored session id for a given key (or null if none).
export function getSessionId(agentHome, { ownerUserId, chatId, agent, repoToplevel, mode }) {
  const key = sessionKey({ ownerUserId, chatId, agent, repoToplevel, mode });
  const store = readSessions(agentHome);
  return store[key]?.session_id || null;
}

// Update the stored session id after a successful provider run.
export function updateSessionId(agentHome, { ownerUserId, chatId, agent, repoToplevel, mode }, sessionId, now = Date.now()) {
  const key = sessionKey({ ownerUserId, chatId, agent, repoToplevel, mode });
  const store = readSessions(agentHome);
  store[key] = {
    schema_version: SCHEMA_VERSION,
    owner_user_id: String(ownerUserId || ""),
    chat_id: String(chatId || ""),
    agent: String(agent || ""),
    repo_toplevel: String(repoToplevel || ""),
    mode: String(mode || ""),
    session_id: String(sessionId),
    updated_at: new Date(now).toISOString(),
  };
  writeSessions(agentHome, store);
}

// Clear the stored session id for a key (on resume failure).
export function clearSessionId(agentHome, { ownerUserId, chatId, agent, repoToplevel, mode }) {
  const key = sessionKey({ ownerUserId, chatId, agent, repoToplevel, mode });
  const store = readSessions(agentHome);
  if (Object.hasOwn(store, key)) {
    delete store[key];
    writeSessions(agentHome, store);
  }
}

// Return all stored sessions (for /status display).
export function listSessions(agentHome) {
  const store = readSessions(agentHome);
  return Object.values(store);
}

// Get the active session record for a key (or null).
export function getSessionRecord(agentHome, { ownerUserId, chatId, agent, repoToplevel, mode }) {
  const key = sessionKey({ ownerUserId, chatId, agent, repoToplevel, mode });
  return readSessions(agentHome)[key] || null;
}

// ─── Turn execution with session semantics ───────────────────────────────────

// Execute one turn with full session semantics:
// - resume with stored session_id if present;
// - on resume failure (read only): clear and retry once;
// - update session_id only on success;
// - write + uncertain outcome: mark outcome_unknown, no retry.
//
// Returns the adapter result augmented with { sessionRetried }.
export async function runTurnWithSession({
  agentHome,
  ownerUserId,
  chatId,
  agent,
  repoToplevel,
  mode,
  prompt,
  model,
  signal,
  adapter,
  onSpawn, // §15.B: callback(pid) → void, called when child spawns
  now = Date.now(),
}) {
  const keyDims = { ownerUserId, chatId, agent, repoToplevel, mode };
  const storedSessionId = getSessionId(agentHome, keyDims);

  // First attempt.
  let result = await adapter.run({
    repoToplevel,
    mode,
    prompt,
    sessionId: storedSessionId,
    model,
    signal,
    onSpawn,
  });

  const isResumeFailure = !result.ok && result.outcome === "spawn_error" && result.errorDetail === "resume_failure";
  let sessionRetried = false;

  // On resume failure: only retry for read turns (§5). Write turns must not
  // auto-rerun when it is not certain the tool had not started working.
  if (isResumeFailure && storedSessionId && mode === "read") {
    clearSessionId(agentHome, keyDims);
    sessionRetried = true;
    result = await adapter.run({
      repoToplevel,
      mode,
      prompt,
      sessionId: null,
      model,
      signal,
      onSpawn,
    });
  }

  // Update stored session_id ONLY on success.
  if (result.ok && result.sessionId) {
    updateSessionId(agentHome, keyDims, result.sessionId, now);
  }

  return { ...result, sessionRetried };
}
