import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDispatchApproval, listDispatchApprovals } from "../src/agent/dispatch.js";
import { agentPaths } from "../src/agent/paths.js";
import { agentTokenPath, joinAgentRegistry, rejectAgentRegistration, seedSpawnAgents } from "../src/agent/registry.js";
import { openSession } from "../src/agent/sessions.js";
import { enableExchangeAgent, getSafetyStatus, setTelegramCodexPolicy } from "../src/agent/safety.js";
import { startWebServer } from "../src/web/server.js";

test("web actions reject missing or forged browser authority without mutation", async (t) => {
  const agentHome = configuredHome();
  const dispatch = pendingDispatch(agentHome, "Security boundary dispatch request.");
  const server = await startTestServer(t, agentHome);
  const browser = await browserAuthority(server, "/dispatch");
  const endpoint = `/api/dispatch/${dispatch.id}/approve`;
  const dispatchFile = agentPaths(agentHome).dispatchApprovals;
  const configFile = agentPaths(agentHome).config;
  const before = { dispatch: fs.readFileSync(dispatchFile), config: fs.readFileSync(configFile) };

  assert.equal((await request(server, endpoint)).status, 404);

  const tokenless = await request(server, endpoint, {
    method: "POST",
    headers: { origin: browser.origin, "content-type": "application/json" },
    body: JSON.stringify({ confirm: "approve" }),
  });
  assert.equal(tokenless.status, 403);

  const wrongOrigin = await post(server, endpoint, browser, { confirm: "approve" }, { origin: "http://attacker.example" });
  assert.equal(wrongOrigin.status, 403);
  assert.equal(JSON.parse(wrongOrigin.body).error, "invalid_origin");

  const wrongToken = await post(server, endpoint, { ...browser, token: "wrong" }, { confirm: "approve" });
  assert.equal(wrongToken.status, 403);
  assert.equal(JSON.parse(wrongToken.body).error, "invalid_csrf");

  const forgedCookie = await post(server, endpoint, { ...browser, cookie: `${browser.cookie}forged` }, { confirm: "approve" });
  assert.equal(forgedCookie.status, 403);
  assert.equal(JSON.parse(forgedCookie.body).error, "invalid_session");

  const wrongHost = await request(server, endpoint, {
    method: "POST",
    headers: { host: "attacker.example", origin: browser.origin, cookie: browser.cookie, "content-type": "application/json", "x-csrf-token": browser.token },
    body: JSON.stringify({ confirm: "approve" }),
  });
  assert.equal(wrongHost.status, 421);

  const nonJson = await request(server, endpoint, {
    method: "POST",
    headers: { origin: browser.origin, cookie: browser.cookie, "content-type": "text/plain", "x-csrf-token": browser.token },
    body: "approve",
  });
  assert.equal(nonJson.status, 415);

  const malformed = await request(server, endpoint, {
    method: "POST",
    headers: { origin: browser.origin, cookie: browser.cookie, "content-type": "application/json", "x-csrf-token": browser.token },
    body: "{",
  });
  assert.equal(malformed.status, 400);

  const oversized = await request(server, endpoint, {
    method: "POST",
    headers: { origin: browser.origin, cookie: browser.cookie, "content-type": "application/json", "x-csrf-token": browser.token },
    body: JSON.stringify({ confirm: "approve", padding: "x".repeat(17 * 1024) }),
  });
  assert.equal(oversized.status, 413);

  const wrongConfirm = await post(server, endpoint, browser, { confirm: "reject" });
  assert.equal(wrongConfirm.status, 400);
  assert.equal(JSON.parse(wrongConfirm.body).error, "confirmation_required");
  assert.equal(listDispatchApprovals(agentHome).find((item) => item.id === dispatch.id).status, "pending");
  assert.equal(fs.existsSync(agentPaths(agentHome).tasksDir), false);
  assert.deepEqual(fs.readFileSync(dispatchFile), before.dispatch);
  assert.deepEqual(fs.readFileSync(configFile), before.config);
});

test("web dispatch actions reuse core approval and preserve the execution gate", async (t) => {
  const agentHome = configuredHome();
  const approvedDispatch = pendingDispatch(agentHome, "Create a separately gated Codex task from the Web action.");
  const rejectedDispatch = pendingDispatch(agentHome, "Reject this independent Web dispatch request.", 2);
  const server = await startTestServer(t, agentHome);
  const browser = await browserAuthority(server, "/dispatch");

  const approved = await post(server, `/api/dispatch/${approvedDispatch.id}/approve`, browser, { confirm: "approve" });
  assert.equal(approved.status, 200);
  const approvalResult = JSON.parse(approved.body);
  assert.equal(approvalResult.outcome.type, "task");
  const task = JSON.parse(fs.readFileSync(path.join(agentPaths(agentHome).tasksDir, `${approvalResult.outcome.id}.json`), "utf8"));
  assert.equal(task.approval, "pending");
  assert.equal(task.source, "dispatch");

  const rejected = await post(server, `/api/dispatch/${rejectedDispatch.id}/reject`, browser, { confirm: "reject" });
  assert.equal(rejected.status, 200);
  assert.equal(JSON.parse(rejected.body).approval.status, "rejected");
});

test("web session, routing, stop, and archive actions stay truthful", async (t) => {
  const agentHome = configuredHome();
  const session = await openSession({
    agentHome,
    initiator: "owner",
    participants: "codex,opus",
    topic: "Exercise the protected Web owner actions.",
  });
  const server = await startTestServer(t, agentHome);
  const browser = await browserAuthority(server, `/sessions/${session.session_id}`);

  const killed = await post(server, `/api/sessions/${session.session_id}/kill`, browser, { confirm: "kill" });
  assert.equal(killed.status, 200);
  assert.equal(JSON.parse(killed.body).session.state, "killed");

  const disabled = await post(server, "/api/agents/opus/disable", browser, { confirm: "disable" });
  assert.equal(disabled.status, 200);
  assert.equal(JSON.parse(disabled.body).dispatchRouteEnabled, false);
  assert.equal(getSafetyStatus(agentHome).config.exchange_agents.find((agent) => agent.agent_id === "opus").enabled, false);
  const enabled = await post(server, "/api/agents/opus/enable", browser, { confirm: "enable" });
  assert.equal(enabled.status, 200);
  assert.equal(JSON.parse(enabled.body).dispatchRouteEnabled, true);
  assert.equal(getSafetyStatus(agentHome).config.exchange_agents.find((agent) => agent.agent_id === "opus").enabled, true);
  const primary = await post(server, "/api/agents/codex/disable", browser, { confirm: "disable" });
  assert.equal(primary.status, 409);

  const stopped = await post(server, "/api/stop", browser, { confirm: "stop_all" });
  assert.equal(stopped.status, 200);
  const stopResult = JSON.parse(stopped.body);
  assert.equal(stopResult.killSwitch, true);
  assert.equal(stopResult.crossProcessTermination, false);
  assert.match(stopResult.limitation, /other processes/);
  assert.equal(getSafetyStatus(agentHome).config.kill_switch, true);

  const archive = await post(server, "/api/inbox/msg_missing/archive", browser, { confirm: "archive" });
  assert.equal(archive.status, 501);
  assert.equal(JSON.parse(archive.body).error, "not_implemented");
});

test("pending poll agents cannot be enabled through the dispatch route action", async (t) => {
  const agentHome = fs.mkdtempSync(path.join(os.tmpdir(), "agent-web-pending-route-"));
  setTelegramCodexPolicy(agentHome, {});
  joinAgentRegistry({ agentHome, name: "otter", style: "poll", capabilities: "read" });
  joinAgentRegistry({ agentHome, name: "raven", style: "poll", capabilities: "read" });
  rejectAgentRegistration({ agentHome, name: "raven" });
  const paths = agentPaths(agentHome);
  const beforeConfig = fs.readFileSync(paths.config);
  const beforeLedgers = ledgerSnapshot(paths);
  const server = await startTestServer(t, agentHome);
  const browser = await browserAuthority(server, "/agents");
  const page = await request(server, "/agents");
  assert.doesNotMatch(page.body, /\/api\/agents\/(?:otter|raven)\/(?:enable|disable)/);

  for (const name of ["otter", "raven", "ghost"]) {
    const response = await post(server, `/api/agents/${name}/enable`, browser, { confirm: "enable" });
    assert.equal(response.status, 409, name);
    assert.equal(JSON.parse(response.body).error, "agent_routing_not_eligible", name);
  }
  assert.deepEqual(fs.readFileSync(paths.config), beforeConfig);
  assert.deepEqual(ledgerSnapshot(paths), beforeLedgers);
  assert.equal(fs.existsSync(agentTokenPath(agentHome, "otter")), false);
});

test("rendered controls are scoped to actionable records", async (t) => {
  const agentHome = configuredHome();
  const dispatch = pendingDispatch(agentHome, "Render only the real pending dispatch actions.");
  const server = await startTestServer(t, agentHome);

  const page = await request(server, "/dispatch");
  assert.match(page.headers["set-cookie"][0], /HttpOnly/);
  assert.match(page.headers["set-cookie"][0], /SameSite=Strict/);
  assert.match(page.body, /meta name="csrf-token" content="[^"]+"/);
  assert.match(page.body, new RegExp(`/api/dispatch/${dispatch.id}/approve`));
  assert.match(page.body, new RegExp(`/api/dispatch/${dispatch.id}/reject`));
});

function configuredHome() {
  const agentHome = fs.mkdtempSync(path.join(os.tmpdir(), "agent-web-actions-"));
  enableExchangeAgent(agentHome, { agentId: "opus", kind: "review" });
  seedSpawnAgents({ agentHome });
  setTelegramCodexPolicy(agentHome, { default_repo: "/repo/agent-river" });
  return agentHome;
}

function ledgerSnapshot(paths) {
  return [paths.agentRegistry, paths.exchangeMessages, paths.exchangeClaims, paths.exchangeReplies, paths.dispatchApprovals, paths.sessions]
    .map((file) => fs.existsSync(file) ? fs.readFileSync(file).toString("base64") : null);
}

function pendingDispatch(agentHome, task, offset = 1) {
  return createDispatchApproval({
    agentHome,
    proposedBy: "opus",
    proposal: { to: "codex", task, reason: "Web action integration test", suggested_mode: "edit" },
    now: Date.now() + offset,
  }).approval;
}

async function startTestServer(t, agentHome) {
  const server = await startWebServer({ agentHome, port: 0 });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return server;
}

async function browserAuthority(server, pathname) {
  const page = await request(server, pathname);
  const token = page.body.match(/<meta name="csrf-token" content="([^"]+)"/)?.[1];
  const cookie = page.headers["set-cookie"]?.[0]?.split(";", 1)[0];
  assert.ok(token);
  assert.ok(cookie);
  return { token, cookie, origin: `http://127.0.0.1:${server.address().port}` };
}

function post(server, pathname, browser, value, overrides = {}) {
  return request(server, pathname, {
    method: "POST",
    headers: {
      origin: overrides.origin || browser.origin,
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
    const req = http.request({
      hostname: "127.0.0.1",
      port,
      path: pathname,
      method,
      headers: { host: `127.0.0.1:${port}`, ...headers },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end(body);
  });
}
