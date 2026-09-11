import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { seedSpawnAgents } from "../src/agent/registry.js";
import { enableExchangeAgent } from "../src/agent/safety.js";
import { startWebServer } from "../src/web/server.js";
import { getMailConversation } from "../src/agent/mail.js";

test("browser sends, follows up, reassigns and stops a conversation through real HTTP", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "river-mail-web-"));
  enableExchangeAgent(home, { agentId: "opus", kind: "review" });
  seedSpawnAgents({ agentHome: home });
  const server = await startWebServer({ agentHome: home, port: 0 });
  t.after(() => { server.closeAllConnections(); server.close(); fs.rmSync(home, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const page = await fetch(`${origin}/mail/new`, { headers: { "accept-language": "zh-TW" } });
  const html = await page.text();
  assert.match(html, /中央郵局/);
  assert.match(html, /自動分派/);
  assert.match(html, /尚未回報/);
  const cookie = page.headers.get("set-cookie").split(";")[0];
  const token = html.match(/name="csrf-token" content="([^"]+)"/)[1];
  const post = (url, body) => fetch(`${origin}${url}`, { method: "POST", headers: {
    cookie, origin, "content-type": "application/json", "x-csrf-token": token,
  }, body: JSON.stringify(body) });
  const sent = await post("/api/mail", { target: "any", request: "請審查 <script>alert(1)</script>", subject: "自動往返", model: "opus", effort: "high" });
  assert.equal(sent.status, 201);
  const { conversationId, messageId, target } = await sent.json();
  assert.equal(target, "opus");
  const detail = await (await fetch(`${origin}/mail/${conversationId}`)).text();
  assert.match(detail, /&lt;script&gt;/);
  assert.match(html, /name="model"/);
  assert.match(html, /name="effort"/);
  assert.match(detail, /opus · high/);
  assert.equal(getMailConversation(home, conversationId).letters[0].mail.model, "opus");
  assert.doesNotMatch(detail, /<script>alert/);
  assert.equal((await post(`/api/mail/letters/${messageId}/reassign`, { target: "codex" })).status, 200);
  assert.equal((await post(`/api/mail/${conversationId}/messages`, { target: "opus", request: "Also check delivery." })).status, 201);
  assert.equal(getMailConversation(home, conversationId).letters.length, 3);
  assert.equal((await post(`/api/mail/${conversationId}/stop`, { confirm: "stop" })).status, 200);
  assert.equal((await post(`/api/mail/${conversationId}/messages`, { request: "Too late" })).status, 409);
  const api = await (await fetch(`${origin}/api/mail/${conversationId}`)).json();
  assert.equal(api.status, "stopped");
  assert.equal((await fetch(`${origin}/api/mail`, { method: "POST", headers: { "content-type": "application/json" }, body: '{}' })).status, 403);
  assert.equal((await post("/api/mail", { from: "opus", request: "Impersonation" })).status, 409);
});
