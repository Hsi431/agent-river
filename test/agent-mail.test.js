import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { claimExchangeMessage, replyExchangeMessage } from "../src/agent/exchange.js";
import { getMailConversation, listMailConversations, mailPrompt, reassignMail, reconcileMail, stopMail, submitMail, submitGroupMail } from "../src/agent/mail.js";
import { pickEligibleCodexMessage, runCodexExchangeRunnerOnce } from "../src/agent/codex-exchange-runner.js";
import { pickEligibleMessage } from "../src/agent/exchange-runner.js";
import { pickEligibleExecMessage, runExecRunnerOnce } from "../src/agent/exec-runner.js";
import { approveAgentRegistration, joinAgentRegistry, seedSpawnAgents } from "../src/agent/registry.js";
import { enableExchangeAgent, setTelegramCodexPolicy } from "../src/agent/safety.js";
import { appendJsonl, readJsonl } from "../src/lib/jsonl.js";
import { agentPaths } from "../src/agent/paths.js";
import { startMailDelivery, readMailDelivery } from "../src/agent/mail-delivery.js";

function setup(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "river-mail-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  enableExchangeAgent(home, { agentId: "opus", kind: "review" });
  seedSpawnAgents({ agentHome: home });
  joinAgentRegistry({ agentHome: home, name: "otter", style: "exec", execCommand: "node -e 'process.stdin.resume();process.stdin.on(\"end\",()=>console.log(\"Received result.\"))'" });
  approveAgentRegistration({ agentHome: home, name: "otter" });
  setTelegramCodexPolicy(home, { exchange_runner_enabled: true, exchange_runner_daily_max: 100 });
  return home;
}

function answer(home, message, text) {
  claimExchangeMessage({ agentHome: home, id: message.id, agent: message.to });
  return replyExchangeMessage({ agentHome: home, id: message.id, agent: message.to, text });
}

test("a real exec recipient receives a Codex result once, without a reply loop", async (t) => {
  const home = setup(t);
  const letter = submitMail({ agentHome: home, from: "otter", to: "codex", text: "Explain what a central mailbox does." });
  assert.equal(pickEligibleCodexMessage(home).id, letter.id);
  const result = await runCodexExchangeRunnerOnce({ agentHome: home, repoDir: home,
    codexRunnerImpl: async ({ prompt }) => {
      assert.match(prompt, /Explain what a central mailbox does/);
      return { ok: true, text: "It routes requests and returns results." };
    } });
  assert.equal(result.reason, "replied");
  const notification = pickEligibleExecMessage(home, "otter");
  assert.equal(notification.mail.kind, "result");
  const delivered = await runExecRunnerOnce({ agentHome: home, repoDir: home });
  assert.equal(delivered.results[0].reason, "replied", JSON.stringify(delivered));
  assert.equal(pickEligibleExecMessage(home, "otter"), null);
  assert.equal(pickEligibleCodexMessage(home), null);
  reconcileMail(home);
  reconcileMail(home);
  const conversation = getMailConversation(home, letter.thread_id);
  assert.equal(conversation.status, "completed");
  assert.equal(conversation.letters.length, 2);
  assert.equal(conversation.timeline.filter((e) => e.type === "reply").length, 2);
});

test("owner request delegates to peer, returns to original agent, and concludes", (t) => {
  const home = setup(t);
  const original = submitMail({ agentHome: home, from: "owner", to: "otter", text: "Ask Codex how delivery works, then explain it." });
  answer(home, original, 'I will ask Codex.\n```agent-mail\n{"to":"codex","text":"Explain mailbox delivery."}\n```');
  const request = pickEligibleCodexMessage(home);
  assert.equal(request.from, "otter");
  answer(home, request, "Route by recipient, then deliver the result.");
  const result = pickEligibleExecMessage(home, "otter");
  assert.equal(result.mail.return_message_id, original.id);
  answer(home, result, "Here is the conclusion for the owner.");
  assert.equal(getMailConversation(home, original.thread_id).status, "completed");
  assert.equal(getMailConversation(home, original.thread_id).letters.length, 3);
  assert.equal(pickEligibleCodexMessage(home), null);
});

test("newline-terminated delegation reaches Codex and Claude and returns once", (t) => {
  const home = setup(t);
  const original = submitMail({ agentHome: home, from: "owner", to: "otter", text: "我想看你們三個互相自我介紹" });
  answer(home, original, '```agent-mail\n{"to":"codex","text":"請介紹自己","capability":"general","model":"gpt-5","effort":"low"}\n```\n');
  const codex = pickEligibleCodexMessage(home);
  assert.ok(codex);
  assert.equal(codex.mail.model, "gpt-5");
  assert.equal(codex.mail.effort, "low");
  assert.equal(getMailConversation(home, original.thread_id).status, "queued");
  answer(home, codex, "我是 Codex，擅長程式實作。");
  answer(home, pickEligibleExecMessage(home, "otter"), '接著請 Claude 介紹。\r\n```agent-mail\r\n{"to":"claude","text":"請介紹自己"}\r\n```\r\n \t\r\n');
  const claude = pickEligibleMessage(home);
  assert.equal(claude.to, "opus");
  answer(home, claude, "我是 Claude，擅長審查。");
  answer(home, pickEligibleExecMessage(home, "otter"), "我是 Otter，這是我們三位的介紹。");
  reconcileMail(home);
  reconcileMail(home);
  const thread = getMailConversation(home, original.thread_id);
  assert.equal(thread.status, "completed");
  assert.equal(thread.letters.length, 5);
  assert.equal(thread.timeline.filter((e) => e.type === "reply").length, 5);
});

test("automatic capability routing, Claude alias, and unknown recipients", (t) => {
  const home = setup(t);
  const review = submitMail({ agentHome: home, from: "otter", text: "請審查這份設計" });
  assert.equal(review.to, "opus");
  assert.equal(pickEligibleMessage(home).id, review.id);
  assert.match(review.mail.route_reason, /capability:review/);
  assert.equal(submitMail({ agentHome: home, from: "owner", to: "claude", text: "Hello" }).to, "opus");
  assert.throws(() => submitMail({ agentHome: home, from: "owner", to: "absent", text: "Hello" }), /unavailable/);
  assert.equal(listMailConversations(home).length, 2);
});

test("stop prevents queued work and further delivery but preserves in-flight replies", (t) => {
  const home = setup(t);
  const original = submitMail({ agentHome: home, from: "otter", to: "codex", text: "Review delivery" });
  claimExchangeMessage({ agentHome: home, id: original.id, agent: "codex" });
  stopMail(home, original.thread_id);
  replyExchangeMessage({ agentHome: home, id: original.id, agent: "codex", text: "Finished after stop" });
  assert.equal(pickEligibleExecMessage(home, "otter"), null);
  assert.equal(getMailConversation(home, original.thread_id).status, "stopped");
  assert.throws(() => submitMail({ agentHome: home, from: "owner", to: "otter", text: "Continue", conversationId: original.thread_id }), /stopped/);
});

test("reassignment retires old letter and rejects work already claimed", (t) => {
  const home = setup(t);
  const original = submitMail({ agentHome: home, from: "owner", to: "codex", text: "Read this request" });
  const moved = reassignMail({ agentHome: home, id: original.id, to: "opus" });
  assert.equal(pickEligibleCodexMessage(home), null);
  assert.equal(pickEligibleMessage(home).id, moved.id);
  assert.throws(() => claimExchangeMessage({ agentHome: home, id: original.id, agent: "codex" }), /unavailable/);
  claimExchangeMessage({ agentHome: home, id: moved.id, agent: "opus" });
  assert.throws(() => reassignMail({ agentHome: home, id: moved.id, to: "codex" }), /processing/);
});

test("bad delegation appears as failure, without invoking another agent", (t) => {
  const home = setup(t);
  const letter = submitMail({ agentHome: home, from: "owner", to: "codex", text: "Explain" });
  answer(home, letter, '```agent-mail\n{"to":"absent","text":"Help"}\n```');
  const thread = getMailConversation(home, letter.thread_id);
  assert.equal(thread.status, "failed");
  assert.match(thread.letters[0].error, /unavailable/);
  assert.match(mailPrompt(home, letter), /central post office/);
});

test("restart reconciles a recorded reply before re-running work and delivers once", (t) => {
  const home = setup(t);
  const letter = submitMail({ agentHome: home, from: "otter", to: "codex", text: "Recover this request" });
  claimExchangeMessage({ agentHome: home, id: letter.id, agent: "codex" });
  appendJsonl(agentPaths(home).exchangeReplies, { id: "xreply_crash", message_id: letter.id, agent_id: "codex", text: "Saved before crash", created_at: new Date().toISOString() });
  reconcileMail(home);
  reconcileMail(home);
  assert.equal(pickEligibleCodexMessage(home), null);
  assert.equal(pickEligibleExecMessage(home, "otter").mail.kind, "result");
  assert.equal(getMailConversation(home, letter.thread_id).letters.length, 2);
});

test("delegation is bounded and long replies still deliver a readable result", (t) => {
  const home = setup(t);
  const first = submitMail({ agentHome: home, from: "owner", to: "codex", text: "Start" });
  for (let i = 1; i < 12; i++) submitMail({ agentHome: home, from: "owner", to: "codex", text: `Follow up ${i}`, conversationId: first.thread_id });
  assert.throws(() => submitMail({ agentHome: home, from: "owner", to: "codex", text: "Overflow", conversationId: first.thread_id }), /limit/);
  const long = submitMail({ agentHome: home, from: "otter", to: "opus", text: "Long answer please" });
  answer(home, long, "Useful result. ".repeat(2000));
  const result = pickEligibleExecMessage(home, "otter");
  assert.match(result.text, /Useful result/);
  assert.ok(result.text.length <= 16000);
});

test("delivery worker processes postal traffic without draining older unrelated requests", async (t) => {
  const home = setup(t);
  const paths = agentPaths(home);
  appendJsonl(paths.exchangeMessages, { id: "legacy", from: "codex", to: "otter", channel: "dispatch", text: "Older unrelated request", created_at: "2020-01-01T00:00:00.000Z" });
  const letter = submitMail({ agentHome: home, from: "owner", to: "otter", text: "Please receive this letter" });
  const stop = startMailDelivery({ agentHome: home, repoDir: home, intervalMs: 20 });
  try {
    const deadline = Date.now() + 3000;
    while (getMailConversation(home, letter.thread_id).status !== "completed" && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    assert.equal(getMailConversation(home, letter.thread_id).status, "completed");
    assert.ok(readMailDelivery(home).fresh);
    assert.equal(readJsonl(paths.exchangeClaims).some((c) => c.message_id === "legacy"), false);
  } finally { stop(); }
});

test("two processes cannot both claim one postal request", async (t) => {
  const home = setup(t);
  const letter = submitMail({ agentHome: home, from: "owner", to: "codex", text: "Only one recipient execution" });
  const script = `import { claimExchangeMessage } from ${JSON.stringify(new URL('../src/agent/exchange.js', import.meta.url).href)};
    try { claimExchangeMessage({ agentHome: process.argv[1], id: process.argv[2], agent: 'codex' }); console.log('claimed'); }
    catch { console.log('not-claimed'); }`;
  const results = await Promise.all([1, 2].map(() => promisify(execFile)(process.execPath, ["--input-type=module", "-e", script, home, letter.id])));
  assert.equal(results.filter((r) => r.stdout.trim() === "claimed").length, 1);
  assert.equal(readJsonl(agentPaths(home).exchangeClaims).filter((c) => c.message_id === letter.id).length, 1);
});

test("an owner can follow up after completion in the same conversation", (t) => {
  const home = setup(t);
  const letter = submitMail({ agentHome: home, from: "owner", to: "opus", text: "Explain the design" });
  answer(home, letter, "Here is the answer.");
  assert.equal(getMailConversation(home, letter.thread_id).status, "completed");
  submitMail({ agentHome: home, from: "owner", to: "opus", conversationId: letter.thread_id, text: "Please clarify the last point." });
  assert.equal(getMailConversation(home, letter.thread_id).status, "queued");
});

test("each letter carries independent model/effort through delegation and return", (t) => {
  const home = setup(t);
  const first = submitMail({ agentHome: home, from: "owner", to: "otter", subject: "明天的行程", text: "如主旨", model: "gpt-5.6-terra", effort: "low" });
  assert.match(mailPrompt(home, first), /Subject: 明天的行程/);
  answer(home, first, '```agent-mail\n{"to":"codex","text":"分析","model":"gpt-6-astra","effort":"xhigh"}\n```');
  const second = getMailConversation(home, first.thread_id).letters.at(-1);
  assert.equal(second.mail.model, "gpt-6-astra");
  assert.equal(second.mail.effort, "xhigh");
  answer(home, second, "分析完成");
  const returned = getMailConversation(home, first.thread_id).letters.at(-1);
  assert.equal(returned.to, "otter");
  assert.equal(returned.mail.model, "gpt-5.6-terra");
  assert.equal(returned.mail.effort, "low");
  assert.throws(() => submitMail({ agentHome: home, from: "owner", to: "codex", text: "x", effort: "invented" }), /Invalid effort/);
});

test("mail choices reach Codex, Claude and exec invocation boundaries", async (t) => {
  const home = setup(t);
  const { realCodexRunner } = await import("../src/agent/codex-runner.js");
  const { buildClaudeInvocation } = await import("../src/agent/exchange-runner.js");
  const { buildExecEnvelope } = await import("../src/agent/exec-runner.js");
  submitMail({ agentHome: home, from: "owner", to: "codex", text: "analyse", model: "gpt-6-astra", effort: "high" });
  await runCodexExchangeRunnerOnce({ agentHome: home, repoDir: home, codexRunnerImpl: async (options) => {
    assert.equal(options.model, "gpt-6-astra");
    assert.equal(options.effort, "high");
    const result = await realCodexRunner({ ...options, execFileImpl: (_bin, args, _opts, done) => {
      assert.equal(args[args.indexOf("--model") + 1], "gpt-6-astra");
      assert.ok(args.includes('model_reasoning_effort="high"'));
      queueMicrotask(() => done(null, "checked", ""));
      return { stdin: { on() {}, write() {}, end() {} } };
    } });
    return { ok: true, ...result };
  } });
  const claude = submitMail({ agentHome: home, from: "owner", to: "opus", text: "review", model: "opus", effort: "max" });
  const invocation = buildClaudeInvocation({ agentHome: home, repoDir: home, msgId: claude.id, model: "sonnet", settingsPath: "/tmp/settings" });
  assert.equal(invocation.args[invocation.args.indexOf("--model") + 1], "opus");
  assert.equal(invocation.args[invocation.args.indexOf("--effort") + 1], "max");
  const otter = submitMail({ agentHome: home, from: "owner", to: "otter", text: "schedule", model: "gpt-5.6-sol", effort: "medium" });
  const envelope = JSON.parse(buildExecEnvelope({ agentHome: home, message: otter }));
  assert.equal(envelope.model, "gpt-5.6-sol");
  assert.equal(envelope.effort, "medium");
});


test("group mail fans out once, shares prior replies and waits for the owner", (t) => {
  const home = setup(t);
  const sent = submitGroupMail({ agentHome: home, rounds: 1, targets: ["codex", "claude", "otter", "opus"], text: "大家介紹自己" });
  assert.equal(sent.length, 3);
  assert.equal(new Set(sent.map(m => m.thread_id)).size, 1);
  assert.equal(new Set(sent.map(m => m.mail.group.id)).size, 1);
  assert.equal(pickEligibleCodexMessage(home).id, sent[0].id);
  assert.equal(pickEligibleMessage(home).id, sent[1].id);
  assert.equal(pickEligibleExecMessage(home, "otter").id, sent[2].id);
  for (const m of sent) {
    assert.match(mailPrompt(home, m), /owner-led group/);
    answer(home, m, `${m.to} 的介紹`);
  }
  reconcileMail(home);
  reconcileMail(home);
  const thread = getMailConversation(home, sent[0].thread_id);
  assert.equal(thread.status, "completed");
  assert.equal(thread.letters.length, 3);
  assert.deepEqual(thread.groupParticipants, ["codex", "opus", "otter"]);
  const next = submitGroupMail({ agentHome: home, rounds: 1, conversationId: thread.id, targets: ["opus"], text: "請比較大家的觀點" });
  const prompt = mailPrompt(home, next[0]);
  assert.match(prompt, /codex 的介紹/);
  assert.match(prompt, /opus 的介紹/);
  assert.match(prompt, /otter 的介紹/);
  answer(home, next[0], '```agent-mail\n{"to":"codex","text":"Do not forward"}\n```');
  assert.equal(getMailConversation(home, thread.id).letters.length, 4);
  assert.equal(pickEligibleCodexMessage(home), null);
});

test("group validation does not partially send; stopped groups cannot continue", (t) => {
  const home = setup(t);
  for (const targets of [[], ["codex", "absent"], ["any"], "codex", [null]]) {
    assert.throws(() => submitGroupMail({ agentHome: home, rounds: 1, targets, text: "Hello" }));
    assert.equal(listMailConversations(home).length, 0);
  }
  const [letter] = submitGroupMail({ agentHome: home, rounds: 1, targets: ["codex", "opus"], text: "Discuss" });
  stopMail(home, letter.thread_id);
  assert.equal(pickEligibleCodexMessage(home), null);
  assert.equal(pickEligibleMessage(home), null);
  assert.throws(() => submitGroupMail({ agentHome: home, rounds: 1, conversationId: letter.thread_id, targets: ["otter"], text: "Continue" }), /stopped/);
});

test("automatic group waits for all peers, shares every reply and stops at three rounds", (t) => {
  const home = setup(t);
  const first = submitGroupMail({ agentHome: home, targets: ["codex", "opus", "otter"], text: "討論方案" });
  const id = first[0].thread_id;
  for (let round = 1; round <= 3; round++) {
    const batch = getMailConversation(home, id).letters.filter(m => m.mail.group.round === round);
    assert.equal(batch.length, 3);
    for (const m of batch) {
      const prompt = mailPrompt(home, m);
      assert.match(prompt, new RegExp(`Discussion round: ${round}/3`));
      if (round > 1) for (const name of ["codex", "opus", "otter"]) assert.match(prompt, new RegExp(`${name} round ${round - 1}`));
      if (round === 3) assert.match(prompt, /FINAL round/);
    }
    answer(home, batch[0], `codex round ${round}`);
    answer(home, batch[1], `opus round ${round}`);
    reconcileMail(home);
    assert.equal(getMailConversation(home, id).letters.length, round * 3);
    answer(home, batch[2], `otter round ${round}`);
    reconcileMail(home);
    reconcileMail(home);
    assert.equal(getMailConversation(home, id).letters.length, Math.min(round + 1, 3) * 3);
  }
  assert.equal(getMailConversation(home, id).status, "completed");
  assert.equal(pickEligibleCodexMessage(home), null);
});

test("reconciliation repairs a partial automatic fan-out without duplicate delivery", (t) => {
  const home = setup(t);
  const first = submitGroupMail({ agentHome: home, targets: ["codex", "opus", "otter"], text: "Recover", rounds: 2 });
  for (const m of first) answer(home, m, `${m.to} result`);
  const paths = agentPaths(home);
  const rows = readJsonl(paths.exchangeMessages);
  const preserved = rows.filter(m => m.mail.group.round === 1 || m.to === "codex");
  fs.writeFileSync(paths.exchangeMessages, preserved.map(m => JSON.stringify(m)).join("\n") + "\n");
  reconcileMail(home);
  reconcileMail(home);
  const second = getMailConversation(home, first[0].thread_id).letters.filter(m => m.mail.group.round === 2);
  assert.equal(second.length, 3);
  assert.equal(second.find(m => m.to === "codex").id, preserved.at(-1).id);
  assert.equal(new Set(second.map(m => m.mail.group.context)).size, 1);
});

test("stops, blocked replies and invalid group replies prevent automatic rounds", (t) => {
  for (const failure of ["stop", "blocked", "protocol"]) {
    const home = setup(t);
    const batch = submitGroupMail({ agentHome: home, targets: ["codex", "opus"], text: "Discuss", rounds: 3 });
    answer(home, batch[0], "Ready");
    if (failure === "stop") {
      claimExchangeMessage({ agentHome: home, id: batch[1].id, agent: "opus" });
      stopMail(home, batch[0].thread_id);
      replyExchangeMessage({ agentHome: home, id: batch[1].id, agent: "opus", text: "Finished in flight" });
    } else answer(home, batch[1], failure === "blocked" ? "Blocked: runner limit" : '```agent-mail\n{"to":"codex","text":"More work"}\n```');
    reconcileMail(home);
    assert.equal(getMailConversation(home, batch[0].thread_id).letters.length, 2);
  }
});

test("new owner instruction supersedes the previous automatic discussion", (t) => {
  const home = setup(t);
  const old = submitGroupMail({ agentHome: home, targets: ["codex", "opus"], text: "Old topic" });
  const next = submitGroupMail({ agentHome: home, conversationId: old[0].thread_id, targets: ["otter"], text: "New direction", rounds: 1 });
  for (const m of old) answer(home, m, "Old result");
  answer(home, next[0], "New result");
  reconcileMail(home);
  assert.equal(getMailConversation(home, old[0].thread_id).letters.length, 3);
});

test("invalid round budgets never dispatch", (t) => {
  const home = setup(t);
  for (const rounds of [0, 4, -1, 1.5, "3", null]) {
    assert.throws(() => submitGroupMail({ agentHome: home, targets: ["codex"], text: "No", rounds }), /rounds/);
  }
  assert.equal(listMailConversations(home).length, 0);
});

test("automatic rounds retain reassigned recipients and reject duplicate peers", (t) => {
  const home = setup(t);
  const first = submitGroupMail({ agentHome: home, targets: ["codex", "opus"], text: "Discuss", rounds: 2 });
  assert.throws(() => reassignMail({ agentHome: home, id: first[1].id, to: "codex" }), /already participates/);
  const moved = reassignMail({ agentHome: home, id: first[1].id, to: "otter" });
  answer(home, first[0], "Codex opinion");
  answer(home, moved, "Otter opinion");
  const second = getMailConversation(home, first[0].thread_id).letters.filter(m => m.mail.group.round === 2);
  assert.deepEqual(second.map(m => m.to), ["codex", "otter"]);
});
