import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { submitExchangeMessage } from "../src/agent/exchange.js";
import { agentPaths } from "../src/agent/paths.js";
import { seedSpawnAgents } from "../src/agent/registry.js";
import { disableExchangeAgent, enableExchangeAgent } from "../src/agent/safety.js";
import { openSession } from "../src/agent/sessions.js";
import { startWebServer } from "../src/web/server.js";

test("web server renders dashboard, assets, and restrictive security headers", async (t) => {
  const server = await startTestServer(t);
  const dashboard = await request(server, "/");
  assert.equal(dashboard.status, 200);
  assert.match(dashboard.body, /Agent River/);
  assert.match(dashboard.body, /Recent completions/);
  assert.match(dashboard.headers["content-security-policy"], /default-src 'self'/);
  assert.match(dashboard.headers["content-security-policy"], /frame-ancestors 'none'/);
  assert.equal(dashboard.headers["access-control-allow-origin"], undefined);
  assert.equal(dashboard.headers["x-content-type-options"], "nosniff");

  const asset = await request(server, "/assets/styles.css");
  assert.equal(asset.status, 200);
  assert.match(asset.headers["content-type"], /^text\/css/);
  assert.match(asset.body, /--purple/);
});

test("web server exposes real inbox JSON and escaped HTML detail", async (t) => {
  const agentHome = makeAgentHome();
  const message = submitExchangeMessage({
    agentHome,
    from: "codex",
    to: "opus",
    text: "Review <script>alert('river')</script> & report.",
  });
  const server = await startTestServer(t, agentHome);

  const inbox = await request(server, "/api/inbox");
  assert.equal(inbox.status, 200);
  assert.equal(JSON.parse(inbox.body)[0].id, message.id);

  const apiDetail = await request(server, `/api/inbox/${encodeURIComponent(message.id)}`);
  assert.equal(apiDetail.status, 200);
  assert.equal(JSON.parse(apiDetail.body).sender, "codex");

  const detail = await request(server, `/inbox/${encodeURIComponent(message.id)}`);
  assert.equal(detail.status, 200);
  assert.doesNotMatch(detail.body, /<script>alert/);
  assert.match(detail.body, /&lt;script&gt;alert/);
  assert.match(detail.body, /Raw JSON/);
});

test("web server rejects unknown routes, methods, malformed paths, and unexpected hosts", async (t) => {
  const server = await startTestServer(t);
  assert.equal((await request(server, "/missing")).status, 404);
  assert.equal((await request(server, "/api/inbox/missing")).status, 404);
  assert.equal((await request(server, "/%zz")).status, 400);

  const method = await request(server, "/api/status", { method: "POST" });
  assert.equal(method.status, 405);
  assert.equal(method.headers.allow, "GET");

  const host = await request(server, "/", { host: "attacker.example" });
  assert.equal(host.status, 421);
  assert.doesNotMatch(host.body, /Agent River/);
  const actualPort = server.address().port;
  const wrongPort = actualPort === 65535 ? actualPort - 1 : actualPort + 1;
  assert.equal((await request(server, "/", { host: `127.0.0.1:${wrongPort}` })).status, 421);
});

test("web server covers every read-only page and API route", async (t) => {
  const agentHome = makeAgentHome();
  enableExchangeAgent(agentHome, { agentId: "opus", kind: "review" });
  seedSpawnAgents({ agentHome });
  const session = await openSession({
    agentHome,
    initiator: "owner",
    participants: "codex,opus",
    topic: "Verify every required Web route.",
  });
  const message = submitExchangeMessage({
    agentHome,
    from: "owner",
    to: "codex",
    sessionId: session.session_id,
    text: "Route completeness check.",
  });
  const server = await startTestServer(t, agentHome);
  const htmlRoutes = [
    "/", "/compose", "/inbox", `/inbox/${message.id}`, "/dispatch", "/sessions",
    `/sessions/${session.session_id}`, "/agents", "/safety", "/archive",
  ];
  for (const route of htmlRoutes) {
    const response = await request(server, route);
    assert.equal(response.status, 200, route);
    assert.match(response.headers["content-type"], /^text\/html/, route);
  }
  const apiRoutes = [
    "/api/status", "/api/request-options", "/api/inbox", `/api/inbox/${message.id}`, "/api/dispatch",
    "/api/sessions", `/api/sessions/${session.session_id}`, "/api/agents", "/api/safety", "/api/archive",
  ];
  for (const route of apiRoutes) {
    const response = await request(server, route);
    assert.equal(response.status, 200, route);
    assert.match(response.headers["content-type"], /^application\/json/, route);
    assert.doesNotThrow(() => JSON.parse(response.body), route);
  }

  const requestOptions = JSON.parse((await request(server, "/api/request-options")).body);
  assert.deepEqual(requestOptions.targets.map((target) => target.name), ["codex", "opus"]);
  assert.deepEqual(requestOptions.sessionParticipants.map((target) => target.name), ["codex", "opus"]);

  assert.match((await request(server, `/inbox/${message.id}`)).body, /<body data-auto-refresh="5000">/);
  assert.match((await request(server, `/sessions/${session.session_id}`)).body, /<body data-auto-refresh="5000">/);
  assert.doesNotMatch((await request(server, "/inbox")).body, /data-auto-refresh/);
  const app = await request(server, "/assets/app.js");
  assert.match(app.body, /!formDirty && !focusedFormControl\(\)/);
});

test("agents separate registry and routing state, and safety reports lock files only", async (t) => {
  const agentHome = makeAgentHome();
  enableExchangeAgent(agentHome, { agentId: "opus", kind: "review" });
  seedSpawnAgents({ agentHome });
  disableExchangeAgent(agentHome, "opus");
  const paths = agentPaths(agentHome);
  fs.writeFileSync(paths.exchangeRunnerLock, "{}");
  fs.writeFileSync(paths.codexExchangeRunnerLock, "{}");
  fs.writeFileSync(paths.execRunnerLock, "{}");
  const server = await startTestServer(t, agentHome);

  const agents = await request(server, "/agents");
  assert.match(agents.body, /opus[\s\S]*?active[\s\S]*?dispatch route disabled/);

  const safety = await request(server, "/safety");
  for (const label of ["Opus runner lock file", "Codex runner lock file", "Exec runner lock file"]) {
    assert.match(safety.body, new RegExp(`${label}[\\s\\S]*?present`));
  }
  assert.doesNotMatch(safety.body, /runner healthy|runner running/i);
});

async function startTestServer(t, agentHome = makeAgentHome()) {
  const server = await startWebServer({ agentHome, port: 0 });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  assert.equal(server.address().address, "127.0.0.1");
  return server;
}

function request(server, requestPath, { method = "GET", host = null } = {}) {
  const address = server.address();
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: "127.0.0.1",
      port: address.port,
      path: requestPath,
      method,
      headers: { host: host || `127.0.0.1:${address.port}` },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    req.on("error", reject);
    req.end();
  });
}

function makeAgentHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agent-web-server-"));
}
