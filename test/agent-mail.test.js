import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { claimExchangeMessage, replyExchangeMessage } from "../src/agent/exchange.js";
import { getMailConversation, listMailConversations, mailPrompt, reassignMail, reconcileMail, stopMail, submitMail } from "../src/agent/mail.js";
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
