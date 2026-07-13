import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pickEligibleCodexMessage } from "../src/agent/codex-exchange-runner.js";
import { pickEligibleMessage } from "../src/agent/exchange-runner.js";
import { submitExchangeMessage } from "../src/agent/exchange.js";
import { pickEligibleExecMessage } from "../src/agent/exec-runner.js";
import { agentPaths } from "../src/agent/paths.js";
import { approveAgentRegistration, joinAgentRegistry, seedSpawnAgents } from "../src/agent/registry.js";
import { enableExchangeAgent, setTelegramCodexPolicy, writeAgentConfig } from "../src/agent/safety.js";
import { readJsonl } from "../src/lib/jsonl.js";
import { handleWebAction } from "../src/web/actions.js";
import { startWebServer } from "../src/web/server.js";

test("Web composer lists eligible routes and submits a canonical request without confirmation", async (t) => {
  const workspace = makeTemp("agent-web-workspace-");
  const repo = path.join(workspace, "project");
  fs.mkdirSync(repo);
  execFileSync("git", ["init", "-q", repo]);
  const agentHome = makeTemp("agent-web-compose-");
  enableExchangeAgent(agentHome, { agentId: "opus", kind: "review" });
  seedSpawnAgents({ agentHome });
  joinAgentRegistry({ agentHome, name: "pending", style: "poll", capabilities: "read" });
  setTelegramCodexPolicy(agentHome, { workspace_root: workspace, default_repo: repo });
  const server = await startTestServer(t, agentHome, repo);
  const browser = await browserAuthority(server, "/compose");

  assert.match(browser.body, /<option value="codex">/);
  assert.match(browser.body, /<option value="opus">/);
  assert.doesNotMatch(browser.body, /<option value="pending">/);
  assert.match(browser.body, /action="\/api\/requests"/);
  assert.doesNotMatch(browser.body, /name="mode"/);

  const response = await post(server, "/api/requests", browser, {
    target: "opus",
    subject: "Review the river",
    request: "Inspect the current mailbox behavior.",
    repo: "project",
  });
  assert.equal(response.status, 201);
  const result = JSON.parse(response.body);
  assert.equal(result.queued, true);
  assert.deepEqual(result.nudge, { status: "requested", managed: true });
  const messages = readJsonl(agentPaths(agentHome).exchangeMessages);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].id, result.messageId);
  assert.equal(messages[0].from, "codex");
  assert.equal(messages[0].to, "opus");
  assert.equal(messages[0].channel, "web");
  assert.equal(messages[0].subject, "Review the river");
  assert.equal(messages[0].repo, fs.realpathSync(repo));

  const inbox = await request(server, "/inbox");
  assert.match(inbox.body, /Review the river/);

  const secretResponse = await post(server, "/api/requests", browser, {
    target: "codex",
    subject: "token = abcdefghijklmnopqrstuvwxyz",
    request: "api_key = zyxwvutsrqponmlkjihgfedcba",
  });
  assert.equal(secretResponse.status, 201);
  const secretMessage = readJsonl(agentPaths(agentHome).exchangeMessages)[1];
  assert.match(secretMessage.subject, /\[redacted:/);
  assert.match(secretMessage.text, /\[redacted:/);
  assert.doesNotMatch(JSON.stringify(secretMessage), /abcdefghijklmnopqrstuvwxyz|zyxwvutsrqponmlkjihgfedcba/);
});

test("Web request endpoint reuses browser authority and fails closed on invalid fields", async (t) => {
  const workspace = makeTemp("agent-web-policy-");
  const repo = path.join(workspace, "project");
  fs.mkdirSync(repo);
  execFileSync("git", ["init", "-q", repo]);
  const outside = makeTemp("agent-web-outside-");
  execFileSync("git", ["init", "-q", outside]);
  const agentHome = makeTemp("agent-web-validation-");
  enableExchangeAgent(agentHome, { agentId: "opus", kind: "review" });
  seedSpawnAgents({ agentHome });
  setTelegramCodexPolicy(agentHome, { workspace_root: workspace, default_repo: repo });
  const server = await startTestServer(t, agentHome, repo);
  const browser = await browserAuthority(server, "/compose");
  const ledger = agentPaths(agentHome).exchangeMessages;

  const unauthorized = await request(server, "/api/requests", {
    method: "POST",
    headers: { origin: browser.origin, "content-type": "application/json" },
    body: JSON.stringify({ target: "opus", request: "Must not be stored." }),
  });
  assert.equal(unauthorized.status, 403);
  assert.equal(fs.existsSync(ledger), false);

  const wrongCsrf = await request(server, "/api/requests", {
    method: "POST",
    headers: { origin: browser.origin, cookie: browser.cookie, "content-type": "application/json", "x-csrf-token": "wrong" },
    body: JSON.stringify({ target: "opus", request: "Must not be stored either." }),
  });
  assert.equal(wrongCsrf.status, 403);
  assert.equal(JSON.parse(wrongCsrf.body).error, "invalid_csrf");
  assert.equal(fs.existsSync(ledger), false);

  for (const [body, error] of [
    [{ target: "OPUS", request: "Bad target." }, "invalid_target"],
    [{ target: "opus", request: "" }, "request_required"],
    [{ target: "opus", subject: "x".repeat(121), request: "Too long." }, "invalid_subject"],
    [{ target: "opus", request: "No write mode.", mode: "edit" }, "invalid_field"],
    [{ target: "opus", request: "Outside repo.", repo: outside }, "invalid_repo"],
    [{ target: "ghost", request: "No route." }, "target_not_eligible"],
  ]) {
    const response = await post(server, "/api/requests", browser, body);
    assert.equal(JSON.parse(response.body).error, error);
  }
  assert.equal(fs.existsSync(ledger), false);
});

test("managed runners accept trusted Web envelopes under their existing sender rules", () => {
  const agentHome = makeTemp("agent-web-runner-filter-");
  enableExchangeAgent(agentHome, { agentId: "opus", kind: "review" });
  seedSpawnAgents({ agentHome });
  submitExchangeMessage({ agentHome, from: "stranger", to: "opus", channel: "web", text: "Untrusted Opus work." });
  submitExchangeMessage({ agentHome, from: "codex", to: "opus", channel: "browser", text: "Unsupported Opus channel." });
  const opusMessage = submitExchangeMessage({ agentHome, from: "codex", to: "opus", channel: "web", text: "Trusted Opus work." });
  assert.equal(pickEligibleMessage(agentHome)?.id, opusMessage.id);

  submitExchangeMessage({ agentHome, from: "stranger", to: "codex", channel: "web", text: "Untrusted Codex work." });
  submitExchangeMessage({ agentHome, from: "opus", to: "codex", channel: "browser", text: "Unsupported Codex channel." });
  const codexMessage = submitExchangeMessage({ agentHome, from: "opus", to: "codex", channel: "web", text: "Trusted Codex work." });
  assert.equal(pickEligibleCodexMessage(agentHome)?.id, codexMessage.id);

  joinAgentRegistry({ agentHome, name: "echo", style: "exec", capabilities: "read", execCommand: "printf ok" });
  approveAgentRegistration({ agentHome, name: "echo" });
  enableExchangeAgent(agentHome, { agentId: "echo", kind: "exec" });
  submitExchangeMessage({ agentHome, from: "stranger", to: "echo", channel: "web", text: "Untrusted exec work." });
  submitExchangeMessage({ agentHome, from: "codex", to: "echo", channel: "browser", text: "Unsupported exec channel." });
  const execMessage = submitExchangeMessage({ agentHome, from: "codex", to: "echo", channel: "web", text: "Trusted exec work." });
  assert.equal(pickEligibleExecMessage(agentHome, "echo")?.id, execMessage.id);
});

test("non-Codex primary ids are not implicit Web targets", async (t) => {
  const agentHome = makeTemp("agent-web-primary-");
  writeAgentConfig(agentHome, { primary_agent_id: "river" });
  seedSpawnAgents({ agentHome });
  const server = await startTestServer(t, agentHome, process.cwd());
  const browser = await browserAuthority(server, "/compose");

  assert.doesNotMatch(browser.body, /<option value="river">/);
  const response = await post(server, "/api/requests", browser, { target: "river", request: "Do not invent a runner." });
  assert.equal(response.status, 409);
  assert.equal(JSON.parse(response.body).error, "target_not_eligible");
  assert.equal(fs.existsSync(agentPaths(agentHome).exchangeMessages), false);
});

test("exec runner nudge keeps the server repo as its stable fallback", async () => {
  const workspace = makeTemp("agent-web-fallback-");
  const serverRepo = path.join(workspace, "server");
  const messageRepo = path.join(workspace, "message");
  for (const repo of [serverRepo, messageRepo]) {
    fs.mkdirSync(repo);
    execFileSync("git", ["init", "-q", repo]);
  }
  const agentHome = makeTemp("agent-web-fallback-state-");
  joinAgentRegistry({ agentHome, name: "echo", style: "exec", capabilities: "read", execCommand: "printf ok" });
  approveAgentRegistration({ agentHome, name: "echo" });
  enableExchangeAgent(agentHome, { agentId: "echo", kind: "exec" });
  setTelegramCodexPolicy(agentHome, { workspace_root: workspace, default_repo: serverRepo });
  let nudgeInput = null;

  const response = await handleWebAction({
    agentHome,
    pathname: "/api/requests",
    body: { target: "echo", request: "Use the envelope repo.", repo: "message" },
    repoDir: serverRepo,
    runnerNudge: (input) => {
      nudgeInput = input;
      return { status: "requested", managed: true };
    },
  });

  assert.equal(response.status, 201);
  assert.equal(nudgeInput.repoDir, serverRepo);
  assert.equal(readJsonl(agentPaths(agentHome).exchangeMessages)[0].repo, fs.realpathSync(messageRepo));
});

async function startTestServer(t, agentHome, repoDir) {
  const server = await startWebServer({ agentHome, repoDir, port: 0 });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return server;
}

async function browserAuthority(server, pathname) {
  const page = await request(server, pathname);
  const token = page.body.match(/<meta name="csrf-token" content="([^"]+)"/)?.[1];
  const cookie = page.headers["set-cookie"]?.[0]?.split(";", 1)[0];
  assert.ok(token);
  assert.ok(cookie);
  return { ...page, token, cookie, origin: `http://127.0.0.1:${server.address().port}` };
}

function post(server, pathname, browser, value) {
  return request(server, pathname, {
    method: "POST",
    headers: {
      origin: browser.origin,
      cookie: browser.cookie,
      "content-type": "application/json",
      "x-csrf-token": browser.token,
    },
    body: JSON.stringify(value),
  });
}

function request(server, pathname, { method = "GET", headers = {}, body = "" } = {}) {
  const port = server.address().port;
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, path: pathname, method, headers: { host: `127.0.0.1:${port}`, ...headers } }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

function makeTemp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
