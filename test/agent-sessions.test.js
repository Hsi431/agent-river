import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runAgentCli } from "../src/agent/cli.js";
import { runCodexExchangeRunnerOnce } from "../src/agent/codex-exchange-runner.js";
import { runExchangeRunnerOnce } from "../src/agent/exchange-runner.js";
import { claimExchangeMessage, kickoffSession, replyExchangeMessage, submitExchangeMessage } from "../src/agent/exchange.js";
import { agentPaths } from "../src/agent/paths.js";
import { closeSession, getSession, killSession, listActiveSessions, openSession } from "../src/agent/sessions.js";
import { enableExchangeAgent, setTelegramCodexPolicy } from "../src/agent/safety.js";
import { readJsonl } from "../src/lib/jsonl.js";

const REPO = "/home/fnata_claw/codex-memory-river";
const SETTINGS_OK = path.join(os.tmpdir(), `u1-opus-runner-settings-${process.pid}.json`);
fs.writeFileSync(SETTINGS_OK, "{}\n");

test("session ledger opens and folds owner sessions with explicit budget and write access", async () => {
  const agentHome = makeAgentHome("u1-session-open-");
  enableExchangeAgent(agentHome, { agentId: "opus", kind: "review" });

  const session = await openSession({
    agentHome,
    initiator: "owner",
    participants: "codex,opus",
    budgetMessages: 4,
    budgetMinutes: 12,
    writeAccess: "codex",
    topic: "Review the session core implementation wiring.",
    now: Date.parse("2026-07-05T00:00:00.000Z"),
  });
  const folded = getSession(agentHome, session.session_id, { now: Date.parse("2026-07-05T00:00:01.000Z") });
  const rows = readJsonl(agentPaths(agentHome).sessions);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].event, "session_opened");
  assert.equal(folded.state, "active");
  assert.deepEqual(folded.participants, ["codex", "opus"]);
  assert.deepEqual(folded.budget, { max_messages: 4, max_minutes: 12 });
  assert.deepEqual(folded.write_access, ["codex"]);
});

test("agent-opened sessions auto-include the initiator, clamp budget, and force read-only", async () => {
  const agentHome = makeAgentHome("u1-session-agent-open-");
  enableExchangeAgent(agentHome, { agentId: "opus", kind: "review" });

  const session = await openSession({
    agentHome,
    initiator: "agent:opus",
    participants: "codex",
    budgetMessages: 99,
    budgetMinutes: 99,
    writeAccess: "opus",
    topic: "Ask Codex to inspect a failing local integration test.",
  });
  const rows = readJsonl(agentPaths(agentHome).sessions);

  assert.deepEqual(session.participants, ["codex", "opus"]);
  assert.deepEqual(session.budget, { max_messages: 6, max_minutes: 20 });
  assert.deepEqual(session.write_access, []);
  assert.equal(rows[0].budget_clamped, true);
  assert.deepEqual(rows[0].requested_budget, { max_messages: 99, max_minutes: 99 });
});

test("owner sessions accept five-character topics but agent-opened sessions require twenty", async () => {
  const agentHome = makeAgentHome("u5-session-topic-min-");
  enableExchangeAgent(agentHome, { agentId: "opus", kind: "review" });

  const ownerSession = await openSession({
    agentHome,
    initiator: "owner",
    participants: "codex,opus",
    topic: "abcde",
  });

  await assert.rejects(
    () => openSession({
      agentHome,
      initiator: "agent:opus",
      participants: "codex",
      topic: "abcde",
    }),
    (error) => error.code === "topic_length"
      && error.details.length === 5
      && error.details.min === 20,
  );
  assert.equal(ownerSession.topic, "abcde");
  assert.equal(readJsonl(agentPaths(agentHome).sessions).length, 1);
});

test("session exchange submit and reply both attach session_id and consume message budget", async () => {
  const agentHome = makeAgentHome("u1-session-budget-");
  enableExchangeAgent(agentHome, { agentId: "opus", kind: "review" });
  const session = await openSession({
    agentHome,
    initiator: "owner",
    participants: "codex,opus",
    budgetMessages: 2,
    budgetMinutes: 30,
    topic: "Use two budget units for one request and one reply.",
  });

  const message = submitExchangeMessage({
    agentHome,
    from: "codex",
    to: "opus",
    channel: "cli",
    sessionId: session.session_id,
    text: "U1_BUDGET_TOKEN request",
  });
  claimExchangeMessage({ agentHome, id: message.id, agent: "opus" });
  const { reply } = replyExchangeMessage({ agentHome, id: message.id, agent: "opus", text: "U1_BUDGET_TOKEN reply" });
  const folded = getSession(agentHome, session.session_id);

  assert.equal(message.session_id, session.session_id);
  assert.equal(reply.session_id, session.session_id);
  assert.equal(folded.messages_used, 2);
  assert.equal(folded.state, "exhausted");
  assert.equal(folded.closed_reason, "exhausted");
});

test("owner kickoff broadcasts topic to every participant and consumes session budget", async () => {
  const agentHome = makeAgentHome("u8-session-kickoff-");
  enableExchangeAgent(agentHome, { agentId: "opus", kind: "review" });
  const session = await openSession({
    agentHome,
    initiator: "owner",
    participants: "codex,opus",
    budgetMessages: 6,
    topic: "U8 kickoff topic reaches both participants.",
  });

  const kickoff = kickoffSession({ agentHome, session });
  const messages = readJsonl(agentPaths(agentHome).exchangeMessages);
  const ledger = readJsonl(agentPaths(agentHome).sessions).filter((row) => row.event === "session_message");

  assert.equal(kickoff.sent, 2);
  assert.equal(kickoff.session.messages_used, 2);
  assert.deepEqual(messages.map((row) => row.from), ["owner", "owner"]);
  assert.deepEqual(messages.map((row) => row.to), ["codex", "opus"]);
  assert.deepEqual(ledger.map((row) => [row.from, row.to]), [["owner", "codex"], ["owner", "opus"]]);
});

test("CLI session-open kicks off owner sessions by default and --no-kickoff disables it", async () => {
  const agentHome = makeAgentHome("u8-session-cli-kickoff-");
  enableExchangeAgent(agentHome, { agentId: "opus", kind: "review" });

  const opened = await runCli([
    "session-open", "--state", agentHome,
    "--initiator", "owner",
    "--participants", "codex,opus",
    "--budget-messages", "6",
    "--topic", "U8 CLI default kickoff topic.",
  ]);
  const quiet = await runCli([
    "session-open", "--state", agentHome,
    "--initiator", "owner",
    "--participants", "codex,opus",
    "--no-kickoff",
    "--topic", "U8 CLI no kickoff topic.",
  ]);
  const messages = readJsonl(agentPaths(agentHome).exchangeMessages);

  assert.deepEqual(opened.kickoff, { sent: 2 });
  assert.equal(opened.session.messages_used, 2);
  assert.equal(quiet.kickoff, null);
  assert.equal(quiet.session.messages_used, 0);
  assert.equal(messages.length, 2);
});

test("agent-opened sessions do not kickoff", async () => {
  const agentHome = makeAgentHome("u8-session-agent-no-kickoff-");
  enableExchangeAgent(agentHome, { agentId: "opus", kind: "review" });

  const opened = await openSession({
    agentHome,
    initiator: "agent:opus",
    participants: "codex",
    topic: "U8 agent-opened sessions send their own first message.",
  });

  assert.equal(opened.messages_used, 0);
  assert.equal(readJsonl(agentPaths(agentHome).exchangeMessages).length, 0);
});

test("session relay forwards a runner reply to the next participant", async () => {
  const agentHome = makeAgentHome("u8-session-relay-");
  enableExchangeAgent(agentHome, { agentId: "codex", kind: "coding" });
  enableExchangeAgent(agentHome, { agentId: "opus", kind: "review" });
  setTelegramCodexPolicy(agentHome, { exchange_runner_enabled: true });
  const session = await openSession({
    agentHome,
    initiator: "owner",
    participants: "codex,opus",
    budgetMessages: 6,
    topic: "U8 relay kickoff topic.",
  });
  kickoffSession({ agentHome, session });

  const result = await runCodexExchangeRunnerOnce({
    agentHome,
    repoDir: REPO,
    codexRunnerImpl: async () => ({ ok: true, text: "U8 codex reply for relay." }),
  });
  const messages = readJsonl(agentPaths(agentHome).exchangeMessages);
  const relayed = messages.find((row) => row.id === result.relay_message_id);
  const folded = getSession(agentHome, session.session_id);

  assert.equal(result.reason, "replied");
  assert.equal(result.relay_skipped, null);
  assert.equal(relayed.from, "codex");
  assert.equal(relayed.to, "opus");
  assert.equal(relayed.text, "U8 codex reply for relay.");
  assert.equal(folded.messages_used, 4);
});

test("session relay stops when the reply exhausts the message budget", async () => {
  const agentHome = makeAgentHome("u8-session-relay-budget-");
  enableExchangeAgent(agentHome, { agentId: "codex", kind: "coding" });
  enableExchangeAgent(agentHome, { agentId: "opus", kind: "review" });
  setTelegramCodexPolicy(agentHome, { exchange_runner_enabled: true });
  const session = await openSession({
    agentHome,
    initiator: "owner",
    participants: "codex,opus",
    budgetMessages: 2,
    topic: "U8 budget exhaustion relay stop.",
  });
  const message = submitExchangeMessage({
    agentHome,
    from: "owner",
    to: "codex",
    channel: "cli",
    sessionId: session.session_id,
    text: "U8 one message before exhausting reply.",
  });

  const result = await runCodexExchangeRunnerOnce({
    agentHome,
    repoDir: REPO,
    codexRunnerImpl: async () => ({ ok: true, text: "U8 reply consumes final budget unit." }),
  });
  const folded = getSession(agentHome, session.session_id);

  assert.equal(result.message_id, message.id);
  assert.equal(result.relay_message_id, null);
  assert.equal(result.relay_skipped, "budget_exhausted");
  assert.equal(folded.state, "exhausted");
  assert.equal(folded.messages_used, 2);
});

test("session submit rejects non-participants with a stable error code", async () => {
  const agentHome = makeAgentHome("u1-session-nonparticipant-");
  enableExchangeAgent(agentHome, { agentId: "opus", kind: "review" });
  enableExchangeAgent(agentHome, { agentId: "otter", kind: "review" });
  const session = await openSession({
    agentHome,
    initiator: "owner",
    participants: "codex,opus",
    topic: "Reject exchange messages from agents outside the session.",
  });

  assert.throws(
    () => submitExchangeMessage({
      agentHome,
      from: "otter",
      to: "codex",
      sessionId: session.session_id,
      text: "This sender is not in the session.",
    }),
    (error) => error.code === "not_participant",
  );
  assert.equal(readJsonl(agentPaths(agentHome).exchangeMessages).length, 0);
});

test("session get/list lazily close expired sessions as exhausted", async () => {
  const agentHome = makeAgentHome("u1-session-expiry-");
  enableExchangeAgent(agentHome, { agentId: "opus", kind: "review" });
  const session = await openSession({
    agentHome,
    initiator: "owner",
    participants: "codex,opus",
    budgetMinutes: 1,
    topic: "Expire this session when the minute budget elapses.",
    now: Date.parse("2026-07-05T00:00:00.000Z"),
  });

  const expired = getSession(agentHome, session.session_id, {
    now: Date.parse("2026-07-05T00:01:01.000Z"),
  });

  assert.equal(expired.state, "exhausted");
  assert.equal(expired.closed_reason, "exhausted");
  assert.deepEqual(listActiveSessions(agentHome, { now: Date.parse("2026-07-05T00:01:01.000Z") }), []);
  assert.equal(readJsonl(agentPaths(agentHome).sessions).at(-1).event, "session_closed");
});

test("opus runner picks active session messages on cli channel and writes a session reply", async () => {
  const agentHome = makeAgentHome("u1-session-runner-eligible-");
  enableExchangeAgent(agentHome, { agentId: "opus", kind: "review" });
  setTelegramCodexPolicy(agentHome, { exchange_runner_enabled: true });
  const session = await openSession({
    agentHome,
    initiator: "owner",
    participants: "codex,opus",
    budgetMessages: 4,
    topic: "Let the opus runner process a session message from CLI.",
  });
  const token = `U1_SESSION_RUNNER_${process.pid}`;
  const message = submitExchangeMessage({
    agentHome,
    from: "codex",
    to: "opus",
    channel: "cli",
    sessionId: session.session_id,
    text: `Please inspect ${token}.`,
  });
  let sawToken = false;

  const result = await runExchangeRunnerOnce({
    agentHome,
    repoDir: REPO,
    settingsPath: SETTINGS_OK,
    spawnImpl: async ({ invocation }) => {
      const id = String(invocation.prompt).match(/Exchange message ([^\s]+) is ALREADY claimed/)?.[1];
      const stored = readJsonl(agentPaths(agentHome).exchangeMessages).find((row) => row.id === id);
      sawToken = stored?.text.includes(token) || false;
      return { ok: true, text: `Handled ${token}.` };
    },
  });
  const replies = readJsonl(agentPaths(agentHome).exchangeReplies);

  assert.equal(result.reason, "replied");
  assert.equal(result.message_id, message.id);
  assert.equal(sawToken, true);
  assert.equal(replies[0].session_id, session.session_id);
});

test("killed sessions make the opus runner record one skip and then no-op", async () => {
  const agentHome = makeAgentHome("u1-session-runner-killed-");
  enableExchangeAgent(agentHome, { agentId: "opus", kind: "review" });
  setTelegramCodexPolicy(agentHome, { exchange_runner_enabled: true });
  const session = await openSession({
    agentHome,
    initiator: "owner",
    participants: "codex,opus",
    budgetMessages: 4,
    topic: "Kill this session before the runner can process it.",
  });
  const message = submitExchangeMessage({
    agentHome,
    from: "codex",
    to: "opus",
    channel: "cli",
    sessionId: session.session_id,
    text: "U1 killed session runner skip.",
  });
  killSession({ agentHome, id: session.session_id });
  let spawned = 0;

  const first = await runExchangeRunnerOnce({
    agentHome,
    repoDir: REPO,
    settingsPath: SETTINGS_OK,
    spawnImpl: async () => {
      spawned += 1;
      return { ok: true, text: "should not run" };
    },
  });
  const firstDispatch = readJsonl(agentPaths(agentHome).exchangeRunnerDispatch)
    .filter((row) => row.message_id === message.id && String(row.outcome || "").startsWith("session_skip:"));
  const second = await runExchangeRunnerOnce({
    agentHome,
    repoDir: REPO,
    settingsPath: SETTINGS_OK,
    spawnImpl: async () => {
      spawned += 1;
      return { ok: true, text: "should not run" };
    },
  });
  const secondDispatch = readJsonl(agentPaths(agentHome).exchangeRunnerDispatch)
    .filter((row) => row.message_id === message.id && String(row.outcome || "").startsWith("session_skip:"));

  assert.equal(first.reason, "session_not_active");
  assert.equal(first.message_id, message.id);
  assert.equal(firstDispatch.length, 1);
  assert.equal(second.reason, "no_eligible_message");
  assert.equal(secondDispatch.length, 1);
  assert.equal(spawned, 0);
  assert.equal(firstDispatch[0].outcome, "session_skip:session_not_active");
});

test("killed sessions make the codex runner record one skip and then no-op", async () => {
  const agentHome = makeAgentHome("u1-session-codex-runner-killed-");
  enableExchangeAgent(agentHome, { agentId: "codex", kind: "coding" });
  enableExchangeAgent(agentHome, { agentId: "opus", kind: "review" });
  setTelegramCodexPolicy(agentHome, { exchange_runner_enabled: true });
  const session = await openSession({
    agentHome,
    initiator: "owner",
    participants: "codex,opus",
    budgetMessages: 4,
    topic: "Kill this session before the codex runner can process it.",
  });
  const message = submitExchangeMessage({
    agentHome,
    from: "opus",
    to: "codex",
    channel: "cli",
    sessionId: session.session_id,
    text: "U1 killed session codex runner skip.",
  });
  killSession({ agentHome, id: session.session_id });
  let spawned = 0;

  const first = await runCodexExchangeRunnerOnce({
    agentHome,
    repoDir: REPO,
    codexRunnerImpl: async () => {
      spawned += 1;
      return { ok: true, text: "should not run" };
    },
  });
  const firstDispatch = readJsonl(agentPaths(agentHome).codexExchangeRunnerDispatch)
    .filter((row) => row.message_id === message.id && String(row.outcome || "").startsWith("session_skip:"));
  const second = await runCodexExchangeRunnerOnce({
    agentHome,
    repoDir: REPO,
    codexRunnerImpl: async () => {
      spawned += 1;
      return { ok: true, text: "should not run" };
    },
  });
  const secondDispatch = readJsonl(agentPaths(agentHome).codexExchangeRunnerDispatch)
    .filter((row) => row.message_id === message.id && String(row.outcome || "").startsWith("session_skip:"));

  assert.equal(first.reason, "session_not_active");
  assert.equal(first.message_id, message.id);
  assert.equal(firstDispatch.length, 1);
  assert.equal(second.reason, "no_eligible_message");
  assert.equal(secondDispatch.length, 1);
  assert.equal(spawned, 0);
  assert.equal(firstDispatch[0].outcome, "session_skip:session_not_active");
});

test("manual close records closed_ok reason", async () => {
  const agentHome = makeAgentHome("u1-session-close-ok-");
  enableExchangeAgent(agentHome, { agentId: "opus", kind: "review" });
  const session = await openSession({
    agentHome,
    initiator: "owner",
    participants: "codex,opus",
    topic: "Close this session normally after the work is done.",
  });

  const closed = closeSession({ agentHome, id: session.session_id, reason: "ok" });

  assert.equal(closed.state, "closed_ok");
  assert.equal(closed.closed_reason, "ok");
});

function makeAgentHome(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function runCli(argv) {
  const lines = [];
  const originalLog = console.log;
  console.log = (value) => lines.push(String(value));
  try {
    await runAgentCli(argv);
  } finally {
    console.log = originalLog;
  }
  return lines[0] ? JSON.parse(lines[0]) : null;
}
