import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runExchangeRunnerOnce, buildClaudeInvocation, pickEligibleMessage, readRunnerSession, writeRunnerSession, clearRunnerSession, runnerSessionStatus, makeOpusEditRunner } from "../src/agent/exchange-runner.js";
import { agentPaths } from "../src/agent/paths.js";
import { enableExchangeAgent, setTelegramCodexPolicy } from "../src/agent/safety.js";
import { readJsonl, writeJsonl } from "codex-memory-river/src/jsonl.js";
import { DISPATCH_CHANNEL } from "../src/agent/dispatch.js";

const REPO = "/home/fnata_claw/codex-memory-river";
// A throwaway settings file that exists, so tests exercise the runner past the
// fail-closed settings check without depending on the real ~/.config file.
const SETTINGS_OK = path.join(os.tmpdir(), `opus-runner-settings-ok-${process.pid}.json`);
fs.writeFileSync(SETTINGS_OK, "{}\n");

test("exchange runner is off by default and never claims or spawns", async () => {
  const agentHome = makeAgentHome("codex-agent-runner-off-");
  enableExchangeAgent(agentHome, { agentId: "opus", kind: "review" });
  seedMessages(agentHome, [eligible("msg_off")]);
  let spawned = 0;

  const result = await runExchangeRunnerOnce({
    agentHome, repoDir: REPO, settingsPath: SETTINGS_OK, spawnImpl: async () => { spawned += 1; return { ok: true }; },
  });

  assert.equal(result.ran, false);
  assert.equal(result.reason, "disabled");
  assert.equal(spawned, 0);
  assert.equal(readJsonl(agentPaths(agentHome).exchangeClaims).length, 0);
});

test("exchange runner only picks to=opus channel=telegram from=codex open messages, one per run", async () => {
  const agentHome = makeAgentHome("codex-agent-runner-gating-");
  enableExchangeAgent(agentHome, { agentId: "opus", kind: "review" });
  setTelegramCodexPolicy(agentHome, { exchange_runner_enabled: true });
  seedMessages(agentHome, [
    eligible("msg_good", { createdAt: "2026-06-03T10:00:00.000Z" }),
    eligible("msg_good_2", { createdAt: "2026-06-03T11:00:00.000Z" }),
    eligible("msg_cli", { channel: "cli" }),
    eligible("msg_human", { from: "human" }),
    eligible("msg_any", { to: "any" }),
  ]);
  const spawnedIds = [];

  const result = await runExchangeRunnerOnce({
    agentHome, repoDir: REPO, settingsPath: SETTINGS_OK, spawnImpl: spawnThatReplies(agentHome, spawnedIds, "No findings."),
  });

  // Oldest eligible only; ineligible channel/from/to are skipped.
  assert.equal(result.reason, "replied");
  assert.equal(result.message_id, "msg_good");
  assert.deepEqual(spawnedIds, ["msg_good"]);
  const claimed = readJsonl(agentPaths(agentHome).exchangeClaims).map((c) => c.message_id);
  assert.equal(claimed.includes("msg_cli"), false);
  assert.equal(claimed.includes("msg_human"), false);
  assert.equal(claimed.includes("msg_any"), false);
});

test("exchange runner also picks approved dispatch lane messages", async () => {
  const agentHome = makeAgentHome("codex-agent-runner-dispatch-lane-");
  enableExchangeAgent(agentHome, { agentId: "opus", kind: "review" });
  setTelegramCodexPolicy(agentHome, { exchange_runner_enabled: true });
  seedMessages(agentHome, [
    eligible("msg_dispatch", {
      channel: DISPATCH_CHANNEL,
      createdAt: "2026-06-03T10:00:00.000Z",
      dispatch: { kind: "agent_dispatch", hop: 1, proposed_by: "codex" },
    }),
  ]);
  const spawnedIds = [];

  const result = await runExchangeRunnerOnce({
    agentHome, repoDir: REPO, settingsPath: SETTINGS_OK, spawnImpl: spawnThatReplies(agentHome, spawnedIds, "Dispatch handled."),
  });

  assert.equal(result.reason, "replied");
  assert.equal(result.message_id, "msg_dispatch");
  assert.deepEqual(spawnedIds, ["msg_dispatch"]);
});

test("exchange runner claims before spawning and does not spawn when claim fails", async () => {
  const agentHome = makeAgentHome("codex-agent-runner-claim-first-");
  // opus NOT enabled -> claim throws.
  setTelegramCodexPolicy(agentHome, { exchange_runner_enabled: true });
  seedMessages(agentHome, [eligible("msg_claimfail")]);
  let spawned = 0;

  const result = await runExchangeRunnerOnce({
    agentHome, repoDir: REPO, settingsPath: SETTINGS_OK, spawnImpl: async () => { spawned += 1; return { ok: true }; },
  });

  assert.equal(result.reason, "claim_failed");
  assert.equal(spawned, 0);
  assert.equal(readJsonl(agentPaths(agentHome).exchangeReplies).length, 0);
});

test("exchange runner: spawn sees an active opus claim before it runs", async () => {
  const agentHome = makeAgentHome("codex-agent-runner-claim-active-");
  enableExchangeAgent(agentHome, { agentId: "opus", kind: "review" });
  setTelegramCodexPolicy(agentHome, { exchange_runner_enabled: true });
  seedMessages(agentHome, [eligible("msg_active")]);
  let claimedAtSpawn = null;

  await runExchangeRunnerOnce({
    agentHome, repoDir: REPO, settingsPath: SETTINGS_OK, spawnImpl: async ({ invocation }) => {
      const id = msgIdFromInvocation(invocation);
      const latest = latestClaim(agentHome, id);
      claimedAtSpawn = latest && latest.status === "claimed" && latest.agent_id === "opus";
      return { ok: true, text: "No findings." };
    },
  });

  assert.equal(claimedAtSpawn, true);
});

test("exchange runner success completes the message and records a dispatch row", async () => {
  const agentHome = makeAgentHome("codex-agent-runner-success-");
  enableExchangeAgent(agentHome, { agentId: "opus", kind: "review" });
  setTelegramCodexPolicy(agentHome, { exchange_runner_enabled: true });
  seedMessages(agentHome, [eligible("msg_ok")]);
  const beforeMessages = readJsonl(agentPaths(agentHome).exchangeMessages);
  const ids = [];

  const result = await runExchangeRunnerOnce({
    agentHome, repoDir: REPO, settingsPath: SETTINGS_OK, spawnImpl: spawnThatReplies(agentHome, ids, "No findings."),
  });
  const replies = readJsonl(agentPaths(agentHome).exchangeReplies);
  const dispatch = readJsonl(agentPaths(agentHome).exchangeRunnerDispatch);

  assert.equal(result.ran, true);
  assert.equal(result.reason, "replied");
  assert.equal(replies.length, 1);
  assert.equal(replies[0].message_id, "msg_ok");
  assert.equal(dispatch.at(-1).outcome, "replied");
  // Send-only: the runner never creates a new exchange message or chat inbox row.
  assert.deepEqual(readJsonl(agentPaths(agentHome).exchangeMessages), beforeMessages);
  assert.equal(readJsonl(agentPaths(agentHome).chatInbox).length, 0);
});

test("exchange runner creates dispatch approval from a valid final reply block", async () => {
  const agentHome = makeAgentHome("codex-agent-runner-dispatch-proposal-");
  enableExchangeAgent(agentHome, { agentId: "opus", kind: "review" });
  setTelegramCodexPolicy(agentHome, { exchange_runner_enabled: true });
  seedMessages(agentHome, [{
    ...eligible("msg_proposal", {
      channel: DISPATCH_CHANNEL,
      dispatch: { kind: "agent_dispatch", hop: 1, proposed_by: "codex" },
    }),
    chat_id: "456",
  }]);
  const replyText = [
    "Review complete.",
    "```agent-dispatch",
    JSON.stringify({
      to: "codex",
      task: "Implement the dispatch callback integration test.",
      reason: "Codex should wire its own owner callback path.",
      mode: "plan",
    }),
    "```",
  ].join("\n");

  const result = await runExchangeRunnerOnce({
    agentHome, repoDir: REPO, settingsPath: SETTINGS_OK, spawnImpl: spawnThatReplies(agentHome, [], replyText),
  });
  const approvals = readJsonl(agentPaths(agentHome).dispatchApprovals);

  assert.match(result.dispatch_approval_id, /^dispatch_/);
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].status, "pending");
  assert.equal(approvals[0].proposed_by, "opus");
  assert.equal(approvals[0].to, "codex");
  assert.equal(approvals[0].parent_msg_id, "msg_proposal");
  assert.equal(approvals[0].parent_hop, 1);
  assert.equal(approvals[0].hop, 2);
  assert.equal(approvals[0].chat_id, "456");
});

test("exchange runner reports blocked dispatch proposals without writing approvals", async () => {
  const agentHome = makeAgentHome("codex-agent-runner-dispatch-blocked-");
  enableExchangeAgent(agentHome, { agentId: "opus", kind: "review" });
  setTelegramCodexPolicy(agentHome, { exchange_runner_enabled: true });
  seedMessages(agentHome, [{
    ...eligible("msg_blocked_dispatch", {
      channel: DISPATCH_CHANNEL,
      dispatch: { kind: "agent_dispatch", hop: 2, proposed_by: "codex" },
    }),
    chat_id: "456",
  }]);
  const replyText = [
    "Review complete.",
    "```agent-dispatch",
    JSON.stringify({
      to: "codex",
      task: "Inspect this dispatch after the maximum hop count.",
      reason: "This should be blocked by max hop enforcement.",
      mode: "plan",
    }),
    "```",
  ].join("\n");

  const result = await runExchangeRunnerOnce({
    agentHome, repoDir: REPO, settingsPath: SETTINGS_OK, spawnImpl: spawnThatReplies(agentHome, [], replyText),
  });

  assert.equal(result.dispatch_approval_id, null);
  assert.equal(result.dispatch_blocked_reason, "max_hops");
  assert.equal(readJsonl(agentPaths(agentHome).dispatchApprovals).length, 0);
});

test("exchange runner leaves invalid dispatch blocks visible and inert", async () => {
  const agentHome = makeAgentHome("codex-agent-runner-dispatch-invalid-");
  enableExchangeAgent(agentHome, { agentId: "opus", kind: "review" });
  setTelegramCodexPolicy(agentHome, { exchange_runner_enabled: true });
  seedMessages(agentHome, [eligible("msg_invalid_proposal")]);
  const invalid = "Reply\n```agent-dispatch\n{not-json}\n```";

  const result = await runExchangeRunnerOnce({
    agentHome, repoDir: REPO, settingsPath: SETTINGS_OK, spawnImpl: spawnThatReplies(agentHome, [], invalid),
  });
  const replies = readJsonl(agentPaths(agentHome).exchangeReplies);

  assert.equal(result.dispatch_approval_id, null);
  assert.equal(readJsonl(agentPaths(agentHome).dispatchApprovals).length, 0);
  assert.equal(replies[0].text, invalid);
});

test("exchange runner releases the claim and retries when a spawn produces no reply", async () => {
  const agentHome = makeAgentHome("codex-agent-runner-retry-");
  enableExchangeAgent(agentHome, { agentId: "opus", kind: "review" });
  setTelegramCodexPolicy(agentHome, { exchange_runner_enabled: true, exchange_runner_max_attempts: 2 });
  seedMessages(agentHome, [eligible("msg_retry")]);

  const result = await runExchangeRunnerOnce({
    agentHome, repoDir: REPO, settingsPath: SETTINGS_OK, spawnImpl: async () => ({ ok: false, timedOut: false }),
  });
  const latest = latestClaim(agentHome, "msg_retry");

  assert.equal(result.reason, "failed_released");
  assert.equal(result.attempt, 1);
  assert.equal(latest.status, "released");
  assert.equal(readJsonl(agentPaths(agentHome).exchangeReplies).length, 0);
  // Still eligible for another run.
  assert.equal(pickEligibleMessage(agentHome)?.id, "msg_retry");
});

test("exchange runner surfaces Node-owned reply write failures", async () => {
  const agentHome = makeAgentHome("codex-agent-runner-reply-error-");
  enableExchangeAgent(agentHome, { agentId: "opus", kind: "review" });
  setTelegramCodexPolicy(agentHome, { exchange_runner_enabled: true, exchange_runner_max_attempts: 2 });
  seedMessages(agentHome, [eligible("msg_reply_error")]);

  const result = await runExchangeRunnerOnce({
    agentHome,
    repoDir: REPO,
    settingsPath: SETTINGS_OK,
    spawnImpl: async () => ({ ok: true, text: "token = sk-123456789012345678901234567890" }),
  });

  assert.equal(result.reason, "failed_released");
  assert.match(result.reply_error, /secret/);
  assert.match(result.spawn.replyError, /secret/);
  assert.equal(readJsonl(agentPaths(agentHome).exchangeReplies).length, 0);
});

test("exchange runner writes a terminal blocked reply after max attempts", async () => {
  const agentHome = makeAgentHome("codex-agent-runner-blocked-");
  enableExchangeAgent(agentHome, { agentId: "opus", kind: "review" });
  setTelegramCodexPolicy(agentHome, { exchange_runner_enabled: true, exchange_runner_max_attempts: 2 });
  seedMessages(agentHome, [eligible("msg_blocked")]);
  const failing = async () => ({ ok: false, timedOut: true });

  const first = await runExchangeRunnerOnce({ agentHome, repoDir: REPO, spawnImpl: failing });
  const second = await runExchangeRunnerOnce({ agentHome, repoDir: REPO, spawnImpl: failing });
  const replies = readJsonl(agentPaths(agentHome).exchangeReplies);

  assert.equal(first.reason, "failed_released");
  assert.equal(second.reason, "blocked_terminal");
  assert.equal(second.attempt, 2);
  assert.equal(replies.length, 1);
  assert.match(replies[0].text, /^Blocked:/);
  // Message is now completed -> no longer eligible.
  assert.equal(pickEligibleMessage(agentHome), null);
});

test("exchange runner refuses to run while another run holds a fresh lock", async () => {
  const agentHome = makeAgentHome("codex-agent-runner-lock-");
  enableExchangeAgent(agentHome, { agentId: "opus", kind: "review" });
  setTelegramCodexPolicy(agentHome, { exchange_runner_enabled: true });
  seedMessages(agentHome, [eligible("msg_lock")]);
  fs.mkdirSync(path.dirname(agentPaths(agentHome).exchangeRunnerLock), { recursive: true });
  fs.writeFileSync(agentPaths(agentHome).exchangeRunnerLock, `${JSON.stringify({ acquired_at: new Date().toISOString(), pid: 999999 })}\n`);
  let spawned = 0;

  const result = await runExchangeRunnerOnce({
    agentHome, repoDir: REPO, settingsPath: SETTINGS_OK, spawnImpl: async () => { spawned += 1; return { ok: true }; },
  });

  assert.equal(result.reason, "locked");
  assert.equal(spawned, 0);
});

test("exchange runner honors the daily dispatch cap", async () => {
  const agentHome = makeAgentHome("codex-agent-runner-daily-");
  enableExchangeAgent(agentHome, { agentId: "opus", kind: "review" });
  setTelegramCodexPolicy(agentHome, { exchange_runner_enabled: true, exchange_runner_daily_max: 1 });
  seedMessages(agentHome, [eligible("msg_daily")]);
  writeJsonl(agentPaths(agentHome).exchangeRunnerDispatch, [{
    message_id: "msg_earlier", attempt: 1, outcome: "replied", model: "sonnet", created_at: new Date().toISOString(),
  }]);
  let spawned = 0;

  const result = await runExchangeRunnerOnce({
    agentHome, repoDir: REPO, settingsPath: SETTINGS_OK, spawnImpl: async () => { spawned += 1; return { ok: true }; },
  });

  assert.equal(result.reason, "daily_max");
  assert.equal(spawned, 0);
});

test("buildClaudeInvocation pins model/settings/add-dir and never includes raw message text", () => {
  const invocation = buildClaudeInvocation({
    repoDir: REPO,
    agentHome: "/tmp/agent",
    msgId: "msg_argv",
    model: "sonnet",
    settingsPath: "/cfg/opus-runner-settings.json",
  });
  const joined = invocation.args.join("\0");

  assert.equal(invocation.command, "claude");
  assert.ok(invocation.args.includes("-p"));
  assert.match(joined, /--model\0sonnet/);
  assert.match(joined, /--settings\0\/cfg\/opus-runner-settings\.json/);
  assert.ok(invocation.args.includes("--add-dir"));
  assert.equal(invocation.args[invocation.args.indexOf("--add-dir") + 1], REPO);
  assert.ok(invocation.args.includes("--max-turns"));
  assert.equal(invocation.args.includes("--no-session-persistence"), false);
  assert.match(joined, /msg_argv/);
  assert.doesNotMatch(joined, /exchange-reply/);
  assert.doesNotMatch(joined, /opus-reply/);
  assert.doesNotMatch(invocation.prompt, /exchange-reply/);
  assert.doesNotMatch(invocation.prompt, /opus-reply/);
  assert.match(invocation.prompt, /Node will record it in the mailbox/);
  assert.match(invocation.prompt, /You are the Claude agent for Agent River/);
  assert.match(invocation.prompt, /@claude is the preferred user-facing name/);
  assert.match(invocation.prompt, /@opus is a backwards-compatible alias/);
  assert.match(invocation.prompt, /conversation\/review lane is read-only/);
  assert.match(invocation.prompt, /Owner-approved edit tasks use a separate edit lane/);
  assert.doesNotMatch(invocation.prompt, /You are the "opus" exchange agent/);
  assert.match(invocation.prompt, /If the owner writes Chinese, use Traditional Chinese/);
  assert.match(invocation.prompt, /agent-dispatch block/);
});

test("buildClaudeInvocation omits --model for Claude default", () => {
  const invocation = buildClaudeInvocation({
    repoDir: REPO,
    agentHome: "/tmp/agent",
    msgId: "msg_default_model",
    model: "",
    settingsPath: "/cfg/opus-runner-settings.json",
  });

  assert.equal(invocation.args.includes("--model"), false);
});

test("exchange runner never passes raw message text into the spawn argv", async () => {
  const agentHome = makeAgentHome("codex-agent-runner-noleak-");
  enableExchangeAgent(agentHome, { agentId: "opus", kind: "review" });
  setTelegramCodexPolicy(agentHome, { exchange_runner_enabled: true });
  const SECRET_TEXT = "REVIEW_BODY_SHOULD_NEVER_APPEAR_IN_ARGV_42";
  seedMessages(agentHome, [eligible("msg_noleak", { text: SECRET_TEXT })]);
  let capturedArgv = null;

  await runExchangeRunnerOnce({
    agentHome, repoDir: REPO, settingsPath: SETTINGS_OK, spawnImpl: async ({ invocation }) => {
      capturedArgv = invocation.args.join(" ");
      return { ok: true, text: "No findings." };
    },
  });

  assert.ok(capturedArgv.includes("msg_noleak"));
  assert.equal(capturedArgv.includes(SECRET_TEXT), false);
});

test("exchange runner fails closed when the restricted settings file is missing", async () => {
  const agentHome = makeAgentHome("codex-agent-runner-missing-settings-");
  enableExchangeAgent(agentHome, { agentId: "opus", kind: "review" });
  setTelegramCodexPolicy(agentHome, { exchange_runner_enabled: true });
  seedMessages(agentHome, [eligible("msg_nosettings")]);
  const missingSettings = path.join(os.tmpdir(), `opus-runner-settings-missing-${Date.now()}.json`);
  let spawned = 0;

  const result = await runExchangeRunnerOnce({
    agentHome, repoDir: REPO, settingsPath: missingSettings,
    spawnImpl: async () => { spawned += 1; return { ok: true }; },
  });

  assert.equal(result.ran, false);
  assert.equal(result.reason, "missing_settings");
  assert.equal(spawned, 0);
  // No claim, no reply, ledger unchanged — the message stays open for a fixed run.
  assert.equal(readJsonl(agentPaths(agentHome).exchangeClaims).length, 0);
  assert.equal(readJsonl(agentPaths(agentHome).exchangeReplies).length, 0);
  assert.equal(readJsonl(agentPaths(agentHome).exchangeRunnerDispatch).length, 0);
  assert.equal(pickEligibleMessage(agentHome)?.id, "msg_nosettings");
});

// --- session continuity tests ---

test("buildClaudeInvocation persists sessions (never --no-session-persistence) so resume works", () => {
  const inv = buildClaudeInvocation({ repoDir: REPO, agentHome: "/tmp/ah", msgId: "msg_x", model: "claude-opus-4-8", settingsPath: SETTINGS_OK });
  // Must persist: storing an id from a non-persisted run is what broke --resume.
  assert.equal(inv.args.includes("--no-session-persistence"), false);
  assert.equal(inv.args.includes("--resume"), false);
  assert.equal(inv.session_id_used, null);
  assert.match(inv.prompt, /exchange-runner-session-status/);
});

test("buildClaudeInvocation with sessionId uses --resume", () => {
  const inv = buildClaudeInvocation({ repoDir: REPO, agentHome: "/tmp/ah", msgId: "msg_x", model: "claude-opus-4-8", settingsPath: SETTINGS_OK, sessionId: "abc-123" });
  const idx = inv.args.indexOf("--resume");
  assert.ok(idx >= 0, "--resume present");
  assert.equal(inv.args[idx + 1], "abc-123");
  assert.equal(inv.args.includes("--no-session-persistence"), false);
  assert.equal(inv.session_id_used, "abc-123");
});

test("opus edit runner drops a stale session and retries fresh (resume fail-safe)", async () => {
  const agentHome = makeAgentHome("codex-agent-opus-resume-fallback-");
  setTelegramCodexPolicy(agentHome, { exchange_runner_model: "sonnet", exchange_runner_timeout_seconds: 60, default_repo: "/repo" });
  writeRunnerSession(agentPaths(agentHome), "chatX", "stale-session-123");
  const calls = [];
  const execFileImpl = (file, args, opts, cb) => {
    calls.push(args);
    if (args.includes("--resume")) {
      cb(Object.assign(new Error("Command failed"), { code: 1 }), "", "No conversation found with session ID: stale-session-123");
    } else {
      cb(null, JSON.stringify({ result: "edited fresh", session_id: "fresh-sess", usage: { input_tokens: 1, output_tokens: 1 } }), "");
    }
    return { stdin: { on() {}, end() {} } };
  };
  const runner = makeOpusEditRunner({ agentHome, settingsPath: SETTINGS_OK, execFileImpl });

  const res = await runner({ prompt: "make a small edit", task: { repo: "/repo", chat_id: "chatX" } });

  assert.equal(res.exit, 0);
  assert.equal(res.text, "edited fresh");
  assert.ok(calls[0].includes("--resume"), "first attempt resumes");
  assert.equal(calls[1].includes("--resume"), false, "retry runs fresh");
  assert.equal(readRunnerSession(agentPaths(agentHome), "chatX"), "fresh-sess");
});

test("readRunnerSession returns null when store is missing or empty", () => {
  const agentHome = makeAgentHome("codex-agent-session-read-empty-");
  const paths = agentPaths(agentHome);
  assert.equal(readRunnerSession(paths, "chat_456"), null);
});

test("writeRunnerSession and readRunnerSession round-trip per chat_id", () => {
  const agentHome = makeAgentHome("codex-agent-session-roundtrip-");
  const paths = agentPaths(agentHome);
  writeRunnerSession(paths, "chat_456", "sid-aaa");
  writeRunnerSession(paths, "chat_789", "sid-bbb");
  assert.equal(readRunnerSession(paths, "chat_456"), "sid-aaa");
  assert.equal(readRunnerSession(paths, "chat_789"), "sid-bbb");
  assert.equal(readRunnerSession(paths, "chat_unknown"), null);
});

test("clearRunnerSession removes only the target chat_id", () => {
  const agentHome = makeAgentHome("codex-agent-session-clear-");
  const paths = agentPaths(agentHome);
  writeRunnerSession(paths, "chat_1", "sid-1");
  writeRunnerSession(paths, "chat_2", "sid-2");
  clearRunnerSession(paths, "chat_1");
  assert.equal(readRunnerSession(paths, "chat_1"), null);
  assert.equal(readRunnerSession(paths, "chat_2"), "sid-2");
});

test("runner saves session_id from spawn output when message has chat_id", async () => {
  const agentHome = makeAgentHome("codex-agent-session-save-");
  enableExchangeAgent(agentHome, { agentId: "opus", kind: "review" });
  setTelegramCodexPolicy(agentHome, { exchange_runner_enabled: true });
  seedMessages(agentHome, [{ ...eligible("msg_session"), chat_id: "chat_42" }]);

  await runExchangeRunnerOnce({
    agentHome, repoDir: REPO, settingsPath: SETTINGS_OK,
    spawnImpl: async () => ({ ok: true, text: "Done.", sessionId: "new-session-xyz" }),
  });

  assert.equal(readRunnerSession(agentPaths(agentHome), "chat_42"), "new-session-xyz");
});

test("runner passes stored session_id via --resume on subsequent run", async () => {
  const agentHome = makeAgentHome("codex-agent-session-resume-");
  enableExchangeAgent(agentHome, { agentId: "opus", kind: "review" });
  setTelegramCodexPolicy(agentHome, { exchange_runner_enabled: true });
  writeRunnerSession(agentPaths(agentHome), "chat_77", "stored-sid-777");
  seedMessages(agentHome, [{ ...eligible("msg_resume"), chat_id: "chat_77" }]);

  let capturedArgs = null;
  await runExchangeRunnerOnce({
    agentHome, repoDir: REPO, settingsPath: SETTINGS_OK,
    spawnImpl: async ({ invocation }) => {
      capturedArgs = invocation.args;
      return { ok: true, text: "Done.", sessionId: "stored-sid-777" };
    },
  });

  const resumeIdx = capturedArgs.indexOf("--resume");
  assert.ok(resumeIdx >= 0, "--resume used");
  assert.equal(capturedArgs[resumeIdx + 1], "stored-sid-777");
  assert.equal(capturedArgs.includes("--no-session-persistence"), false);
});

test("runnerSessionStatus reports session and recent message metadata without raw text", () => {
  const agentHome = makeAgentHome("codex-agent-session-status-");
  const paths = agentPaths(agentHome);
  writeRunnerSession(paths, "chat_42", "sid-42", Date.parse("2026-06-04T01:00:00.000Z"));
  seedMessages(agentHome, [
    { ...eligible("msg_old", { text: "old secret-ish text", createdAt: "2026-06-03T01:00:00.000Z" }), chat_id: "chat_42", text_hash: "hash_old" },
    { ...eligible("msg_new", { text: "latest raw text must not appear", createdAt: "2026-06-04T01:00:00.000Z" }), chat_id: "chat_42", text_hash: "hash_new" },
  ]);
  writeJsonl(paths.exchangeReplies, [{
    id: "xreply_new",
    message_id: "msg_new",
    agent_id: "opus",
    text: "reply raw text must not appear",
    text_hash: "reply_hash_new",
    created_at: "2026-06-04T01:01:00.000Z",
  }]);

  const status = runnerSessionStatus(agentHome, { chatId: "chat_42" });
  const serialized = JSON.stringify(status);

  assert.equal(status.length, 1);
  assert.equal(status[0].chat_id, "chat_42");
  assert.equal(status[0].session_id, "sid-42");
  assert.equal(status[0].recent_messages[0].message_id, "msg_new");
  assert.equal(status[0].recent_messages[0].request_hash, "hash_new");
  assert.equal(status[0].recent_messages[0].reply_hash, "reply_hash_new");
  assert.equal(serialized.includes("latest raw text must not appear"), false);
  assert.equal(serialized.includes("reply raw text must not appear"), false);
});

test("runner skips session when message has no chat_id", async () => {
  const agentHome = makeAgentHome("codex-agent-session-nochat-");
  enableExchangeAgent(agentHome, { agentId: "opus", kind: "review" });
  setTelegramCodexPolicy(agentHome, { exchange_runner_enabled: true });
  seedMessages(agentHome, [eligible("msg_nochat")]);

  let capturedArgs = null;
  await runExchangeRunnerOnce({
    agentHome, repoDir: REPO, settingsPath: SETTINGS_OK,
    spawnImpl: async ({ invocation }) => {
      capturedArgs = invocation.args;
      return { ok: true, text: "Done.", sessionId: "should-not-be-stored" };
    },
  });

  assert.equal(capturedArgs.includes("--resume"), false, "no --resume when no chat_id");
  // No session should be stored (no chat_id to key on)
  const store = (() => { try { return JSON.parse(fs.readFileSync(agentPaths(agentHome).exchangeRunnerSessions, "utf8")); } catch { return {}; } })();
  assert.equal(Object.keys(store).length, 0);
});

// --- helpers ---

function makeAgentHome(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function eligible(id, overrides = {}) {
  return {
    id,
    from: overrides.from || "codex",
    to: overrides.to || "opus",
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

function spawnThatReplies(agentHome, capturedIds, text) {
  return async ({ invocation }) => {
    const id = msgIdFromInvocation(invocation);
    capturedIds.push(id);
    return { ok: true, text };
  };
}

function msgIdFromInvocation(invocation) {
  const match = String(invocation.prompt || "").match(/Exchange message ([^\s]+) is ALREADY claimed/);
  return match ? match[1] : null;
}

function latestClaim(agentHome, messageId) {
  return readJsonl(agentPaths(agentHome).exchangeClaims)
    .filter((c) => c.message_id === messageId)
    .at(-1) || null;
}
