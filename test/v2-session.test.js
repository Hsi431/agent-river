// Tests for §13.1-4: session model.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  clearSessionId,
  getSessionId,
  getSessionRecord,
  listSessions,
  runTurnWithSession,
  updateSessionId,
} from "../src/agent/v2/session.js";

function makeAgentHome(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const BASE_DIMS = {
  ownerUserId: "u1",
  chatId: "c1",
  agent: "claude",
  repoToplevel: "/ws/proj",
  mode: "read",
};

// ─── §13.1: First turn creates session; second same-key turn resumes ─────────

test("session: first turn stores session_id on success", async () => {
  const agentHome = makeAgentHome("v2-session-first-");

  let callCount = 0;
  const adapter = {
    async run({ sessionId }) {
      callCount += 1;
      return { ok: true, text: "result", sessionId: "sess_001", tokens: 10, outcome: "ok" };
    },
  };

  const result = await runTurnWithSession({
    agentHome,
    ...BASE_DIMS,
    prompt: "review this",
    adapter,
  });

  assert.equal(result.ok, true);
  assert.equal(result.sessionId, "sess_001");
  assert.equal(callCount, 1);

  const stored = getSessionId(agentHome, BASE_DIMS);
  assert.equal(stored, "sess_001");
});

test("session: second same-key turn passes stored session_id to adapter", async () => {
  const agentHome = makeAgentHome("v2-session-second-");

  // Pre-seed a session.
  updateSessionId(agentHome, BASE_DIMS, "prior_session_42");

  const received = [];
  const adapter = {
    async run({ sessionId }) {
      received.push(sessionId);
      return { ok: true, text: "result", sessionId: "sess_002", tokens: 5, outcome: "ok" };
    },
  };

  await runTurnWithSession({
    agentHome,
    ...BASE_DIMS,
    prompt: "continue",
    adapter,
  });

  assert.equal(received[0], "prior_session_42");
  assert.equal(getSessionId(agentHome, BASE_DIMS), "sess_002");
});

// ─── §13.2: Different repo or mode does not resume the other session ──────────

test("session: different repo does not share session", () => {
  const agentHome = makeAgentHome("v2-session-diff-repo-");

  updateSessionId(agentHome, { ...BASE_DIMS, repoToplevel: "/ws/proj-a" }, "sess_a");
  updateSessionId(agentHome, { ...BASE_DIMS, repoToplevel: "/ws/proj-b" }, "sess_b");

  assert.equal(getSessionId(agentHome, { ...BASE_DIMS, repoToplevel: "/ws/proj-a" }), "sess_a");
  assert.equal(getSessionId(agentHome, { ...BASE_DIMS, repoToplevel: "/ws/proj-b" }), "sess_b");
});

test("session: different mode does not share session", () => {
  const agentHome = makeAgentHome("v2-session-diff-mode-");

  updateSessionId(agentHome, { ...BASE_DIMS, mode: "read" }, "sess_read");
  updateSessionId(agentHome, { ...BASE_DIMS, mode: "write" }, "sess_write");

  assert.equal(getSessionId(agentHome, { ...BASE_DIMS, mode: "read" }), "sess_read");
  assert.equal(getSessionId(agentHome, { ...BASE_DIMS, mode: "write" }), "sess_write");
});

test("session: different chat_id does not share session", () => {
  const agentHome = makeAgentHome("v2-session-diff-chat-");

  updateSessionId(agentHome, { ...BASE_DIMS, chatId: "chat_a" }, "sess_chat_a");
  updateSessionId(agentHome, { ...BASE_DIMS, chatId: "chat_b" }, "sess_chat_b");

  assert.equal(getSessionId(agentHome, { ...BASE_DIMS, chatId: "chat_a" }), "sess_chat_a");
  assert.equal(getSessionId(agentHome, { ...BASE_DIMS, chatId: "chat_b" }), "sess_chat_b");
});

// ─── §13.3: Stale session resumes once with fresh session (read turn) ─────────

test("session: stale/expired session is cleared and retried once (read turn)", async () => {
  const agentHome = makeAgentHome("v2-session-stale-");

  updateSessionId(agentHome, BASE_DIMS, "stale_sess");

  const callArgs = [];
  const adapter = {
    async run({ sessionId }) {
      callArgs.push(sessionId);
      if (sessionId === "stale_sess") {
        // Simulate resume failure.
        return { ok: false, text: "", sessionId: null, tokens: 0, outcome: "spawn_error", errorDetail: "resume_failure" };
      }
      // Fresh session succeeds.
      return { ok: true, text: "fresh result", sessionId: "fresh_sess", tokens: 10, outcome: "ok" };
    },
  };

  const result = await runTurnWithSession({
    agentHome,
    ...BASE_DIMS,
    prompt: "retry",
    adapter,
  });

  assert.equal(result.ok, true);
  assert.equal(result.sessionRetried, true);
  assert.equal(callArgs.length, 2);
  assert.equal(callArgs[0], "stale_sess"); // First attempt used stale session.
  assert.equal(callArgs[1], null);         // Second attempt used fresh session.
  assert.equal(getSessionId(agentHome, BASE_DIMS), "fresh_sess");
});

test("session: stale session retry does NOT happen for write turns", async () => {
  const agentHome = makeAgentHome("v2-session-stale-write-");

  updateSessionId(agentHome, { ...BASE_DIMS, mode: "write" }, "stale_write_sess");

  let callCount = 0;
  const adapter = {
    async run({ sessionId }) {
      callCount += 1;
      return { ok: false, text: "", sessionId: null, tokens: 0, outcome: "spawn_error", errorDetail: "resume_failure" };
    },
  };

  const result = await runTurnWithSession({
    agentHome,
    ...BASE_DIMS,
    mode: "write",
    prompt: "edit this",
    adapter,
  });

  // Should NOT retry.
  assert.equal(callCount, 1);
  assert.equal(result.sessionRetried, false);
  assert.equal(result.ok, false);
});

// ─── §13.4: Write turn with uncertain outcome is not re-executed ──────────────

test("session: write turn outcome_unknown does not update session and no auto-retry", async () => {
  const agentHome = makeAgentHome("v2-session-write-uncertain-");

  updateSessionId(agentHome, { ...BASE_DIMS, mode: "write" }, "write_sess_prior");

  let callCount = 0;
  const adapter = {
    async run() {
      callCount += 1;
      return { ok: false, text: "", sessionId: null, tokens: 0, outcome: "outcome_unknown", errorDetail: null };
    },
  };

  const result = await runTurnWithSession({
    agentHome,
    ...BASE_DIMS,
    mode: "write",
    prompt: "dangerous write",
    adapter,
  });

  // Only one call — no auto-rerun.
  assert.equal(callCount, 1);
  assert.equal(result.ok, false);
  assert.equal(result.outcome, "outcome_unknown");

  // Session id must NOT be updated.
  assert.equal(getSessionId(agentHome, { ...BASE_DIMS, mode: "write" }), "write_sess_prior");
});

// ─── Misc session storage ─────────────────────────────────────────────────────

test("session: session_id not updated on failure", async () => {
  const agentHome = makeAgentHome("v2-session-noupdate-");

  updateSessionId(agentHome, BASE_DIMS, "original_sess");

  const adapter = {
    async run() {
      return { ok: false, text: "", sessionId: "new_sess", tokens: 0, outcome: "provider_permission_denied", errorDetail: null };
    },
  };

  await runTurnWithSession({
    agentHome,
    ...BASE_DIMS,
    prompt: "something",
    adapter,
  });

  // Session must not change on failure.
  assert.equal(getSessionId(agentHome, BASE_DIMS), "original_sess");
});

test("session: listSessions returns stored sessions", () => {
  const agentHome = makeAgentHome("v2-session-list-");

  updateSessionId(agentHome, BASE_DIMS, "sess_x");
  updateSessionId(agentHome, { ...BASE_DIMS, repoToplevel: "/ws/other" }, "sess_y");

  const sessions = listSessions(agentHome);
  assert.equal(sessions.length, 2);
  const ids = sessions.map((s) => s.session_id).sort();
  assert.deepEqual(ids, ["sess_x", "sess_y"]);
});

test("session: clearSessionId removes the entry", () => {
  const agentHome = makeAgentHome("v2-session-clear-");

  updateSessionId(agentHome, BASE_DIMS, "to_clear");
  assert.equal(getSessionId(agentHome, BASE_DIMS), "to_clear");

  clearSessionId(agentHome, BASE_DIMS);
  assert.equal(getSessionId(agentHome, BASE_DIMS), null);
});

test("session: schema_version is stored in the record", () => {
  const agentHome = makeAgentHome("v2-session-schema-");
  updateSessionId(agentHome, BASE_DIMS, "vsess");
  const record = getSessionRecord(agentHome, BASE_DIMS);
  assert.equal(record.schema_version, 2);
});
