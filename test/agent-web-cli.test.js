import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { runAgentCli } from "../src/agent/cli.js";
import { buildWebService, webServiceStatus, writeWebService } from "../src/agent/service.js";
import { readWebSafety } from "../src/web/read-model.js";
import { renderPage } from "../src/web/render.js";

const REPO = path.resolve(".");

test("Web service generator writes one local-only unit and reports drift without systemctl", () => {
  const agentHome = makeTemp("agent-web-cli-state-");
  const dir = makeTemp("agent-web-cli-units-");
  const built = buildWebService({ agentHome, repoDir: REPO, nodePath: "/usr/bin/node", port: 4312 });

  assert.equal(built.unit_name, "codex-agent-web.service");
  assert.equal(built.bind_address, "127.0.0.1");
  assert.match(built.unit, /Type=simple/);
  assert.match(built.unit, /web --state .* --repo .* --port 4312/);
  assert.match(built.unit, /Restart=on-failure/);
  assert.doesNotMatch(built.unit, /0\.0\.0\.0|systemctl/);
  assert.equal(webServiceStatus({ agentHome, dir, repoDir: REPO, nodePath: "/usr/bin/node", port: 4312 }).unit.drift, "missing");

  const written = writeWebService({ agentHome, dir, repoDir: REPO, nodePath: "/usr/bin/node", port: 4312 });
  assert.equal(written.note.includes("NOT enabled"), true);
  assert.equal(webServiceStatus({ agentHome, dir, repoDir: REPO, nodePath: "/usr/bin/node", port: 4312 }).unit.drift, "match");
  fs.appendFileSync(written.unit_path, "# drift\n");
  assert.equal(webServiceStatus({ agentHome, dir, repoDir: REPO, nodePath: "/usr/bin/node", port: 4312 }).unit.drift, "drifted");
  const safety = readWebSafety(agentHome, { repoDir: REPO, systemdDir: dir, webPort: 4312 });
  assert.equal(safety.serviceUnitFiles.dashboard.drift, "missing");
  assert.equal(safety.serviceUnitFiles.opus.drift, "missing");
  assert.equal(safety.serviceUnitFiles.codex.drift, "missing");
  assert.equal(safety.serviceUnitFiles.exec.drift, "missing");
  assert.equal(safety.serviceUnitFiles.web.drift, "drifted");
  const html = renderPage({ view: "safety", title: "Safety", data: safety });
  assert.match(html, /Dashboard unit file/);
  assert.match(html, /Web unit file/);
  assert.match(html, /drifted/);
});

test("Web service CLI print, write, status, help, and port validation", async () => {
  const agentHome = makeTemp("agent-web-cli-state-");
  const dir = makeTemp("agent-web-cli-units-");
  const printed = await captureOutput(() => runAgentCli([
    "web-service-print", "--state", agentHome, "--repo", REPO, "--port", "4313",
  ]));
  assert.equal(JSON.parse(printed).unit_name, "codex-agent-web.service");

  const written = await captureOutput(() => runAgentCli([
    "web-service-write", "--state", agentHome, "--repo", REPO, "--port", "4313", "--dir", dir,
  ]));
  assert.equal(fs.existsSync(JSON.parse(written).unit_path), true);
  const status = await captureOutput(() => runAgentCli([
    "web-service-status", "--state", agentHome, "--repo", REPO, "--port", "4313", "--dir", dir,
  ]));
  assert.equal(JSON.parse(status).unit.drift, "match");

  const help = await captureOutput(() => runAgentCli(["--help"]));
  assert.match(help, /web \[--state/);
  assert.match(help, /web-service-print/);
  assert.match(help, /web-service-write/);
  assert.match(help, /web-service-status/);
  await assert.rejects(
    () => runAgentCli(["web", "--state", agentHome, "--repo", REPO, "--port", "invalid"]),
    /Web port must be an integer/,
  );
  await assert.rejects(
    () => runAgentCli(["web", "--state", agentHome, "--repo", REPO, "--port", "0"]),
    /Web port must be an integer between 1 and 65535/,
  );
});

test("web CLI starts on 127.0.0.1 and exits cleanly on SIGTERM", async (t) => {
  const agentHome = makeTemp("agent-web-cli-live-");
  const port = await availablePort();
  const child = spawn(process.execPath, [
    "bin/codex-agent.js", "web", "--state", agentHome, "--repo", REPO, "--port", String(port),
  ], { cwd: REPO, stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  });
  const stdout = await waitForOutput(child, `"port": ${port}`);
  assert.match(stdout, /"address": "127\.0\.0\.1"/);

  const response = await getStatus(port);
  assert.equal(response.status, 200);
  assert.equal(JSON.parse(response.body).system, "available");

  child.kill("SIGTERM");
  const exit = await waitForExit(child);
  assert.deepEqual(exit, { code: 0, signal: null });
});

async function captureOutput(run) {
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.join(" "));
  try {
    await run();
  } finally {
    console.log = original;
  }
  return lines.join("\n");
}

function availablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function waitForOutput(child, expected) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => finish(new Error(`Timed out waiting for Web startup. stderr=${stderr}`)), 5000);
    const finish = (error) => {
      clearTimeout(timer);
      child.stdout.off("data", onStdout);
      child.stderr.off("data", onStderr);
      child.off("exit", onExit);
      if (error) reject(error);
      else resolve(stdout);
    };
    const onStdout = (chunk) => {
      stdout += chunk;
      if (stdout.includes(expected)) finish();
    };
    const onStderr = (chunk) => { stderr += chunk; };
    const onExit = (code, signal) => finish(new Error(`Web exited before startup: code=${code} signal=${signal} stderr=${stderr}`));
    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    child.once("exit", onExit);
  });
}

function getStatus(port) {
  return new Promise((resolve, reject) => {
    const request = http.get({ hostname: "127.0.0.1", port, path: "/api/status" }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
    });
    request.on("error", reject);
  });
}

function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for Web shutdown")), 5000);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

function makeTemp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
