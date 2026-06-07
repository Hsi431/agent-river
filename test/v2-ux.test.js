// Tests for §13.8: /status reports without invoking a model.
// Tests for §13.5: cross-repo read review.
// Tests for v2 poller: versioned callbacks, single-poller routing.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildStartAck, buildStatusReport, outcomeMessage, resolverErrorMessage, routerErrorMessage } from "../src/agent/v2/ux.js";
import { handleV2Message, handleV2Status, handleV2Stop, makeV2CallbackData, parseV2Callback, isV1Callback, routeUpdate } from "../src/agent/v2/poller.js";
import { updateSessionId } from "../src/agent/v2/session.js";
import { setTelegramCodexPolicy } from "../src/agent/safety.js";

function makeAgentHome(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function makeGitRepo(parentDir, name) {
  const dir = path.join(parentDir, name);
  fs.mkdirSync(dir, { recursive: true });
  await new Promise((resolve, reject) => {
    execFile("git", ["init", dir], { timeout: 5000 }, (error) => {
      if (error) reject(error); else resolve();
    });
  });
  return dir;
}

// ─── §13.8: /status reports without calling a model ──────────────────────────

test("ux: buildStatusReport includes agent/repo/mode/session info", () => {
  const agentHome = makeAgentHome("v2-ux-status-");
  const repoToplevel = "/ws/myproject";
  const dims = { ownerUserId: "u1", chatId: "c1", agent: "claude", repoToplevel, mode: "read" };

  updateSessionId(agentHome, dims, "sess_abc123");

  const report = buildStatusReport(agentHome, dims);

  assert.match(report, /agent: claude/);
  assert.match(report, /repo:.*myproject/);
  assert.match(report, /mode: read/);
  assert.match(report, /sess_abc123/);
  assert.match(report, /v2 status/);
});

test("ux: buildStatusReport shows no session when none stored", () => {
  const agentHome = makeAgentHome("v2-ux-status-no-sess-");

  const report = buildStatusReport(agentHome, {
    ownerUserId: "u1",
    chatId: "c1",
    agent: "codex",
    repoToplevel: "/ws/repo",
    mode: "read",
  });

  assert.match(report, /session: none/);
});

test("ux: handleV2Status returns reply without model invocation", async () => {
  const agentHome = makeAgentHome("v2-ux-handle-status-");

  const result = handleV2Status(agentHome, {
    ownerUserId: "u1",
    chatId: "c1",
    agent: "claude",
    repoToplevel: "/ws/p",
    mode: "read",
  });

  assert.ok(typeof result.reply === "string");
  assert.match(result.reply, /v2 status/);
});

test("ux: buildStartAck includes all required fields", () => {
  const ack = buildStartAck({
    agent: "claude",
    repoToplevel: "/ws/myproject",
    mode: "read",
    sessionId: "sess_xyz",
    turnId: "v2turn_123",
  });

  assert.match(ack, /claude/);
  assert.match(ack, /\/ws\/myproject/);
  assert.match(ack, /mode=read/);
  assert.match(ack, /sess_xyz/);
  assert.match(ack, /v2turn_123/);
});

test("ux: buildStartAck shows 'new' when no prior session", () => {
  const ack = buildStartAck({
    agent: "codex",
    repoToplevel: "/ws/p",
    mode: "write",
    sessionId: null,
    turnId: "v2turn_abc",
  });

  assert.match(ack, /session=new/);
});

// ─── Failure reason messages ──────────────────────────────────────────────────

test("ux: outcomeMessage returns useful text for all outcomes", () => {
  const outcomes = ["capability_blocked", "provider_permission_denied", "repo_access_denied", "timed_out", "outcome_unknown", "spawn_error"];
  for (const outcome of outcomes) {
    const msg = outcomeMessage(outcome, null);
    assert.ok(msg.length > 0, `Expected non-empty message for outcome: ${outcome}`);
  }
});

test("ux: resolverErrorMessage returns useful text for all reasons", () => {
  const reasons = ["missing_workspace_root", "invalid_input", "repo_not_found", "repo_access_denied", "repo_outside_workspace"];
  for (const reason of reasons) {
    const msg = resolverErrorMessage(reason);
    assert.ok(msg.length > 0, `Expected non-empty message for reason: ${reason}`);
  }
});

test("ux: routerErrorMessage returns useful text", () => {
  assert.match(routerErrorMessage("write_requires_repo", null), /repo=/);
  assert.match(routerErrorMessage("control_error", "duplicate_repo"), /duplicate_repo/);
});

// ─── Versioned callbacks ──────────────────────────────────────────────────────

test("poller: makeV2CallbackData and parseV2Callback round-trip", () => {
  const data = makeV2CallbackData("v2turn_abc123", "stop");
  assert.equal(data, "v2:turn:v2turn_abc123:stop");

  const parsed = parseV2Callback(data);
  assert.deepEqual(parsed, { namespace: "v2", turnId: "v2turn_abc123", action: "stop" });
});

test("poller: parseV2Callback returns null for non-v2 data", () => {
  assert.equal(parseV2Callback("owner:approve:task_123"), null);
  assert.equal(parseV2Callback("dispatch:approve:dispatch_abc"), null);
  assert.equal(parseV2Callback(""), null);
  assert.equal(parseV2Callback(null), null);
});

test("poller: isV1Callback is true for v1 data, false for v2", () => {
  assert.equal(isV1Callback("owner:approve:task_123"), true);
  assert.equal(isV1Callback("dispatch:approve:dispatch_abc"), true);
  assert.equal(isV1Callback("v2:turn:abc:stop"), false);
  assert.equal(isV1Callback(""), false);
  assert.equal(isV1Callback(null), false);
});

// ─── v1/v2 routing ────────────────────────────────────────────────────────────

test("poller: routeUpdate returns v2 for @agent messages", () => {
  assert.equal(routeUpdate("@claude review this"), "v2");
  assert.equal(routeUpdate("@codex fix the test"), "v2");
  assert.equal(routeUpdate("@opus explain"), "v2");
});

test("poller: routeUpdate returns v1 for non-@agent messages", () => {
  assert.equal(routeUpdate("agent status"), "v1");
  assert.equal(routeUpdate("status"), "v1");
  assert.equal(routeUpdate("hello"), "v1");
  assert.equal(routeUpdate(""), "v1");
});

// ─── §13.5: cross-repo read review e2e (injectable execFile) ─────────────────

test("poller: cross-repo read review runs in target repo top-level (mocked adapter)", async () => {
  const ws = makeAgentHome("v2-e2e-crossrepo-ws-");
  const otherRepo = await makeGitRepo(ws, "other-project");

  const agentHome = makeAgentHome("v2-e2e-crossrepo-agent-");

  // Configure workspace_root so the resolver can work.
  setTelegramCodexPolicy(agentHome, { default_repo: path.join(ws, "main-project") });
  // We don't actually need main-project to exist since we pass other-project explicitly.

  let adapterCallArgs = null;
  const mockClaudeAdapter = {
    async run(args) {
      adapterCallArgs = args;
      return {
        ok: true,
        text: "Review: No findings.",
        sessionId: "sess_new_001",
        tokens: 50,
        outcome: "ok",
      };
    },
  };

  const result = await handleV2Message({
    agentHome,
    ownerUserId: "u1",
    chatId: "c1",
    text: `@claude repo=${otherRepo} -- review the latest changes`,
    execFileImpl: execFile, // real execFile for git operations
    adapters: { claude: mockClaudeAdapter },
  });

  assert.equal(result.handled, true);
  assert.equal(result.outcome, "ok");
  assert.match(result.reply, /Review/);

  // The adapter must have been called with the other repo's top-level.
  assert.ok(adapterCallArgs, "adapter should have been called");
  assert.equal(adapterCallArgs.repoToplevel, otherRepo);
  assert.equal(adapterCallArgs.mode, "read");

  // An ack was generated.
  assert.ok(result.ack, "should have an ack message");
  assert.match(result.ack, /claude/);
});

test("poller: handleV2Message returns router error for mode=write without repo=", async () => {
  const agentHome = makeAgentHome("v2-e2e-router-error-");

  const result = await handleV2Message({
    agentHome,
    ownerUserId: "u1",
    chatId: "c1",
    text: "@claude mode=write fix this",
    execFileImpl: execFile,
    adapters: { claude: { async run() { throw new Error("should not be called"); } } },
  });

  assert.equal(result.handled, true);
  assert.equal(result.outcome, "router_error");
  assert.match(result.reply, /repo=/);
});

test("poller: handleV2Message returns resolver error for non-existent repo", async () => {
  const agentHome = makeAgentHome("v2-e2e-resolver-error-");
  setTelegramCodexPolicy(agentHome, { default_repo: "/tmp/doesnotexist/project" });

  const result = await handleV2Message({
    agentHome,
    ownerUserId: "u1",
    chatId: "c1",
    text: "@claude repo=doesnotexist review this",
    execFileImpl: execFile,
    adapters: { claude: { async run() { throw new Error("should not be called"); } } },
  });

  assert.equal(result.handled, true);
  assert.equal(result.outcome, "resolver_error");
});

test("poller: handleV2Stop reports no active turns when none running", () => {
  // stopAllTurns clears all active turns — safe to call in any order.
  const result = handleV2Stop();
  assert.ok(typeof result.reply === "string");
});
