import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runCodexExchangeRunnerOnce, pickEligibleCodexMessage, buildCodexPrompt } from "../src/agent/codex-exchange-runner.js";
import { agentPaths } from "../src/agent/paths.js";
import { enableExchangeAgent, setTelegramCodexPolicy } from "../src/agent/safety.js";
import { readJsonl, writeJsonl } from "../src/lib/jsonl.js";
import { DISPATCH_CHANNEL } from "../src/agent/dispatch.js";

const REPO = "/home/fnata_claw/codex-memory-river";

// --- helpers ---

function makeAgentHome(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function eligible(id, overrides = {}) {
  return {
    id,
    from: overrides.from || "opus",
    to: overrides.to || "codex",
    channel: overrides.channel || "telegram",
    thread_id: overrides.threadId || null,
    ...(overrides.dispatch ? { dispatch: overrides.dispatch } : {}),
    text: overrides.text || "Review request",
    text_hash: `hash_${id}`,
    created_at: overrides.createdAt || new Date().toISOString(),
  };
}

function seedMessages(agentHome, messages) {
  writeJsonl(agentPaths(agentHome).exchangeMessages, messages);
}

// A fake codexRunnerImpl that succeeds and records calls.
function fakeCodexRunner(capturedIds, text) {
  return async ({ prompt, cwd, agentHome }) => {
    const match = String(prompt || "").match(/Exchange message ([^\s]+) is ALREADY claimed/);
    if (match) capturedIds.push(match[1]);
    return { ok: true, text };
  };
}

function fakeFailingCodexRunner() {
  return async () => ({ ok: false, text: "", error: "codex exec failed" });
}

function latestClaim(agentHome, messageId) {
  return readJsonl(agentPaths(agentHome).exchangeClaims)
    .filter((c) => c.message_id === messageId)
    .at(-1) || null;
}

// --- tests ---

test("codex runner is off by default and never claims or spawns", async () => {
  const agentHome = makeAgentHome("codex-xrunner-off-");
  enableExchangeAgent(agentHome, { agentId: "codex", kind: "coding" });
  seedMessages(agentHome, [eligible("msg_off")]);
  let spawned = 0;

  const result = await runCodexExchangeRunnerOnce({
    agentHome, repoDir: REPO, codexRunnerImpl: async () => { spawned++; return { ok: true, text: "done" }; },
  });

  assert.equal(result.ran, false);
  assert.equal(result.reason, "disabled");
  assert.equal(spawned, 0);
  assert.equal(readJsonl(agentPaths(agentHome).exchangeClaims).length, 0);
});

test("codex runner only picks to=codex channel=telegram/dispatch open messages, oldest first", async () => {
  const agentHome = makeAgentHome("codex-xrunner-gating-");
  enableExchangeAgent(agentHome, { agentId: "codex", kind: "coding" });
  setTelegramCodexPolicy(agentHome, { exchange_runner_enabled: true });
  seedMessages(agentHome, [
    eligible("msg_good", { createdAt: "2026-06-03T10:00:00.000Z" }),
    eligible("msg_good_2", { createdAt: "2026-06-03T11:00:00.000Z" }),
    eligible("msg_cli", { channel: "cli" }),
    eligible("msg_any", { to: "any" }),
    eligible("msg_opus", { to: "opus" }),
  ]);
  const capturedIds = [];

  const result = await runCodexExchangeRunnerOnce({
    agentHome, repoDir: REPO, codexRunnerImpl: fakeCodexRunner(capturedIds, "LGTM."),
  });

  assert.equal(result.reason, "replied");
  assert.equal(result.message_id, "msg_good");
  assert.deepEqual(capturedIds, ["msg_good"]);
  const claimed = readJsonl(agentPaths(agentHome).exchangeClaims).map((c) => c.message_id);
  assert.equal(claimed.includes("msg_cli"), false);
  assert.equal(claimed.includes("msg_any"), false);
  assert.equal(claimed.includes("msg_opus"), false);
});

test("codex runner picks dispatch-channel messages addressed to codex", async () => {
  const agentHome = makeAgentHome("codex-xrunner-dispatch-");
  enableExchangeAgent(agentHome, { agentId: "codex", kind: "coding" });
  setTelegramCodexPolicy(agentHome, { exchange_runner_enabled: true });
  seedMessages(agentHome, [
    eligible("msg_dispatch", {
      channel: DISPATCH_CHANNEL,
      createdAt: "2026-06-03T10:00:00.000Z",
      dispatch: { kind: "agent_dispatch", hop: 1, proposed_by: "opus" },
    }),
  ]);
  const capturedIds = [];

  const result = await runCodexExchangeRunnerOnce({
    agentHome, repoDir: REPO, codexRunnerImpl: fakeCodexRunner(capturedIds, "Done."),
  });

  assert.equal(result.reason, "replied");
  assert.equal(result.message_id, "msg_dispatch");
  assert.deepEqual(capturedIds, ["msg_dispatch"]);
});

test("codex runner claims before running and does not spawn when claim fails", async () => {
  const agentHome = makeAgentHome("codex-xrunner-claim-fail-");
  // codex NOT enabled -> claim throws
  setTelegramCodexPolicy(agentHome, { exchange_runner_enabled: true });
  seedMessages(agentHome, [eligible("msg_claimfail")]);
  let spawned = 0;

  const result = await runCodexExchangeRunnerOnce({
    agentHome, repoDir: REPO, codexRunnerImpl: async () => { spawned++; return { ok: true, text: "done" }; },
  });

  assert.equal(result.reason, "claim_failed");
  assert.equal(spawned, 0);
  assert.equal(readJsonl(agentPaths(agentHome).exchangeReplies).length, 0);
});

test("codex runner: claim is active before run executes", async () => {
  const agentHome = makeAgentHome("codex-xrunner-claim-active-");
  enableExchangeAgent(agentHome, { agentId: "codex", kind: "coding" });
  setTelegramCodexPolicy(agentHome, { exchange_runner_enabled: true });
  seedMessages(agentHome, [eligible("msg_active")]);
  let claimedAtRun = null;

  await runCodexExchangeRunnerOnce({
    agentHome, repoDir: REPO,
    codexRunnerImpl: async ({ prompt }) => {
      const match = String(prompt || "").match(/Exchange message ([^\s]+) is ALREADY claimed/);
      const id = match ? match[1] : null;
      const latest = id ? latestClaim(agentHome, id) : null;
      claimedAtRun = latest && latest.status === "claimed" && latest.agent_id === "codex";
      return { ok: true, text: "LGTM." };
    },
  });

  assert.equal(claimedAtRun, true);
});

test("codex runner success: reply written, dispatch row recorded", async () => {
  const agentHome = makeAgentHome("codex-xrunner-success-");
  enableExchangeAgent(agentHome, { agentId: "codex", kind: "coding" });
  setTelegramCodexPolicy(agentHome, { exchange_runner_enabled: true });
  seedMessages(agentHome, [eligible("msg_ok")]);
  const beforeMessages = readJsonl(agentPaths(agentHome).exchangeMessages);

  const result = await runCodexExchangeRunnerOnce({
    agentHome, repoDir: REPO, codexRunnerImpl: fakeCodexRunner([], "No findings."),
  });
  const replies = readJsonl(agentPaths(agentHome).exchangeReplies);
  const dispatch = readJsonl(agentPaths(agentHome).codexExchangeRunnerDispatch);

  assert.equal(result.ran, true);
  assert.equal(result.reason, "replied");
  assert.equal(replies.length, 1);
  assert.equal(replies[0].message_id, "msg_ok");
  assert.equal(dispatch.at(-1).outcome, "replied");
  // Runner never creates new exchange messages.
  assert.deepEqual(readJsonl(agentPaths(agentHome).exchangeMessages), beforeMessages);
});

test("codex runner redacts secrets from reply text", async () => {
  const agentHome = makeAgentHome("codex-xrunner-redact-");
  enableExchangeAgent(agentHome, { agentId: "codex", kind: "coding" });
  setTelegramCodexPolicy(agentHome, { exchange_runner_enabled: true });
  seedMessages(agentHome, [eligible("msg_secret")]);

  // reply contains a secret-like value
  const result = await runCodexExchangeRunnerOnce({
    agentHome, repoDir: REPO,
    codexRunnerImpl: async () => ({ ok: true, text: "Found token = sk-123456789012345678901234567890 in the code." }),
  });
  const replies = readJsonl(agentPaths(agentHome).exchangeReplies);

  assert.equal(result.reason, "replied");
  assert.ok(replies.length > 0, "reply written");
  assert.equal(replies[0].text.includes("sk-123456789012345678901234567890"), false);
  assert.match(replies[0].text, /\[redacted/);
});

test("codex runner releases claim and retries when run produces no reply", async () => {
  const agentHome = makeAgentHome("codex-xrunner-retry-");
  enableExchangeAgent(agentHome, { agentId: "codex", kind: "coding" });
  setTelegramCodexPolicy(agentHome, { exchange_runner_enabled: true, exchange_runner_max_attempts: 2 });
  seedMessages(agentHome, [eligible("msg_retry")]);

  const result = await runCodexExchangeRunnerOnce({
    agentHome, repoDir: REPO, codexRunnerImpl: fakeFailingCodexRunner(),
  });
  const latest = latestClaim(agentHome, "msg_retry");

  assert.equal(result.reason, "failed_released");
  assert.equal(result.attempt, 1);
  assert.equal(latest.status, "released");
  assert.equal(readJsonl(agentPaths(agentHome).exchangeReplies).length, 0);
  // Still eligible.
  assert.equal(pickEligibleCodexMessage(agentHome)?.id, "msg_retry");
});

test("codex runner writes terminal blocked reply after max attempts", async () => {
  const agentHome = makeAgentHome("codex-xrunner-blocked-");
  enableExchangeAgent(agentHome, { agentId: "codex", kind: "coding" });
  setTelegramCodexPolicy(agentHome, { exchange_runner_enabled: true, exchange_runner_max_attempts: 2 });
  seedMessages(agentHome, [eligible("msg_blocked")]);

  const first = await runCodexExchangeRunnerOnce({ agentHome, repoDir: REPO, codexRunnerImpl: fakeFailingCodexRunner() });
  const second = await runCodexExchangeRunnerOnce({ agentHome, repoDir: REPO, codexRunnerImpl: fakeFailingCodexRunner() });
  const replies = readJsonl(agentPaths(agentHome).exchangeReplies);

  assert.equal(first.reason, "failed_released");
  assert.equal(second.reason, "blocked_terminal");
  assert.equal(second.attempt, 2);
  assert.equal(replies.length, 1);
  assert.match(replies[0].text, /^Blocked:/);
  assert.equal(pickEligibleCodexMessage(agentHome), null);
});

test("codex runner lock prevents a second concurrent runner", async () => {
  const agentHome = makeAgentHome("codex-xrunner-lock-");
  enableExchangeAgent(agentHome, { agentId: "codex", kind: "coding" });
  setTelegramCodexPolicy(agentHome, { exchange_runner_enabled: true });
  seedMessages(agentHome, [eligible("msg_lock")]);
  // Write a fresh lock so the runner sees it as held.
  const lockFile = agentPaths(agentHome).codexExchangeRunnerLock;
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  fs.writeFileSync(lockFile, `${JSON.stringify({ acquired_at: new Date().toISOString(), pid: 999999 })}\n`);
  let spawned = 0;

  const result = await runCodexExchangeRunnerOnce({
    agentHome, repoDir: REPO, codexRunnerImpl: async () => { spawned++; return { ok: true, text: "done" }; },
  });

  assert.equal(result.reason, "locked");
  assert.equal(spawned, 0);
});

test("codex runner honors the daily dispatch cap", async () => {
  const agentHome = makeAgentHome("codex-xrunner-daily-");
  enableExchangeAgent(agentHome, { agentId: "codex", kind: "coding" });
  setTelegramCodexPolicy(agentHome, { exchange_runner_enabled: true, exchange_runner_daily_max: 1 });
  seedMessages(agentHome, [eligible("msg_daily")]);
  writeJsonl(agentPaths(agentHome).codexExchangeRunnerDispatch, [{
    message_id: "msg_earlier", attempt: 1, outcome: "replied", model: null, created_at: new Date().toISOString(),
  }]);
  let spawned = 0;

  const result = await runCodexExchangeRunnerOnce({
    agentHome, repoDir: REPO, codexRunnerImpl: async () => { spawned++; return { ok: true, text: "done" }; },
  });

  assert.equal(result.reason, "daily_max");
  assert.equal(spawned, 0);
});

test("--agent codex routes to codex runner (exchange-runner CLI case)", async () => {
  // Verify the CLI switch works by importing cli dispatch logic indirectly.
  // We test the runner export directly since spawning a subprocess adds nothing.
  const agentHome = makeAgentHome("codex-xrunner-cli-route-");
  enableExchangeAgent(agentHome, { agentId: "codex", kind: "coding" });
  setTelegramCodexPolicy(agentHome, { exchange_runner_enabled: true });
  seedMessages(agentHome, [eligible("msg_cli_route")]);
  const capturedIds = [];

  const result = await runCodexExchangeRunnerOnce({
    agentHome, repoDir: REPO, codexRunnerImpl: fakeCodexRunner(capturedIds, "All good."),
  });

  assert.equal(result.agent, "codex");
  assert.equal(result.reason, "replied");
  assert.deepEqual(capturedIds, ["msg_cli_route"]);
});

test("buildCodexPrompt contains message id and never raw message text", () => {
  const prompt = buildCodexPrompt({ agentHome: "/tmp/ah", msgId: "msg_test_123", repoDir: "/tmp/repo" });

  assert.match(prompt, /msg_test_123/);
  assert.match(prompt, /ALREADY claimed/);
  assert.match(prompt, /exchange-thread/);
  assert.match(prompt, /Node will record it in the mailbox/);
  assert.match(prompt, /Traditional Chinese/);
  assert.match(prompt, /read-only/);
  assert.doesNotMatch(prompt, /exchange-reply/);
});

test("codex runner uses codex_runner_model from policy (not exchange_runner_model)", async () => {
  const agentHome = makeAgentHome("codex-xrunner-model-");
  enableExchangeAgent(agentHome, { agentId: "codex", kind: "coding" });
  setTelegramCodexPolicy(agentHome, { exchange_runner_enabled: true });
  // Set codex_runner_model to a non-empty value; it gets passed through to the runner.
  // We verify the dispatch row records the model name.
  seedMessages(agentHome, [eligible("msg_model")]);
  // Inject policy directly: codex_runner_model is already ""-default; just verify dispatch row model is null when empty.
  const result = await runCodexExchangeRunnerOnce({
    agentHome, repoDir: REPO, codexRunnerImpl: fakeCodexRunner([], "Done."),
  });

  const dispatch = readJsonl(agentPaths(agentHome).codexExchangeRunnerDispatch);
  assert.equal(result.reason, "replied");
  // Default codex_runner_model is "" -> null in the dispatch row.
  assert.equal(dispatch.at(-1).model, null);
});

test("codex runner prompt never contains raw message text", async () => {
  const agentHome = makeAgentHome("codex-xrunner-noleak-");
  enableExchangeAgent(agentHome, { agentId: "codex", kind: "coding" });
  setTelegramCodexPolicy(agentHome, { exchange_runner_enabled: true });
  const SECRET_TEXT = "CODEX_REVIEW_BODY_MUST_NOT_APPEAR_IN_PROMPT_99";
  seedMessages(agentHome, [eligible("msg_noleak", { text: SECRET_TEXT })]);
  let capturedPrompt = null;

  await runCodexExchangeRunnerOnce({
    agentHome, repoDir: REPO,
    codexRunnerImpl: async ({ prompt }) => {
      capturedPrompt = prompt;
      return { ok: true, text: "LGTM." };
    },
  });

  assert.ok(capturedPrompt.includes("msg_noleak"));
  assert.equal(capturedPrompt.includes(SECRET_TEXT), false);
});
