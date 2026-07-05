import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runAgentCli } from "../src/agent/cli.js";
import { agentPaths } from "../src/agent/paths.js";
import { getTelegramCodexPolicy } from "../src/agent/safety.js";

test("init seeds state, writes all units, creates telegram env template, and is idempotent", async (t) => {
  const originalHome = process.env.HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agent-river-init-home-"));
  process.env.HOME = home;
  t.after(() => {
    process.env.HOME = originalHome;
  });

  const agentHome = path.join(home, "state");
  const systemdDir = path.join(home, "systemd-user");
  const workspaceRoot = path.join(home, "workspace");
  const otherWorkspaceRoot = path.join(home, "other-workspace");
  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.mkdirSync(otherWorkspaceRoot, { recursive: true });

  const first = await runCli([
    "init",
    "--state", agentHome,
    "--workspace-root", workspaceRoot,
    "--systemd-dir", systemdDir,
  ]);

  assert.equal(fs.existsSync(agentHome), true);
  assert.equal(fs.existsSync(agentPaths(agentHome).agentRegistry), true);
  assert.equal(getTelegramCodexPolicy(agentHome).workspace_root, workspaceRoot);
  assert.equal(first.workspace_root_written, true);
  assert.deepEqual(first.units.map((unit) => unit.unit_name), [
    "codex-agent-dashboard.service",
    "codex-agent-opus-runner.service",
    "codex-agent-codex-runner.service",
    "codex-agent-exec-runner.service",
  ]);
  for (const name of [
    "codex-agent-dashboard.service",
    "codex-agent-opus-runner.service",
    "codex-agent-opus-runner.timer",
    "codex-agent-codex-runner.service",
    "codex-agent-codex-runner.timer",
    "codex-agent-exec-runner.service",
    "codex-agent-exec-runner.timer",
  ]) {
    assert.equal(fs.existsSync(path.join(systemdDir, name)), true);
  }

  const envPath = path.join(home, ".config", "codex-agent", "telegram.env");
  assert.equal(fs.readFileSync(envPath, "utf8").includes("TELEGRAM_BOT_TOKEN="), true);
  fs.writeFileSync(envPath, "TELEGRAM_BOT_TOKEN=keep-me\n");

  const second = await runCli([
    "init",
    "--state", agentHome,
    "--workspace-root", otherWorkspaceRoot,
    "--systemd-dir", systemdDir,
  ]);

  assert.equal(second.workspace_root, workspaceRoot);
  assert.equal(second.workspace_root_written, false);
  assert.equal(getTelegramCodexPolicy(agentHome).workspace_root, workspaceRoot);
  assert.equal(fs.readFileSync(envPath, "utf8"), "TELEGRAM_BOT_TOKEN=keep-me\n");
  assert.equal(second.telegram_env.written, false);
  assert.equal(second.next_steps.some((step) => step.includes("systemctl --user daemon-reload")), true);
  assert.equal(second.next_steps.some((step) => step.includes("/session codex,opus")), true);

  const helpState = path.join(home, "help-state");
  const helpSystemdDir = path.join(home, "help-systemd-user");
  const helpLines = await captureCli([
    "init",
    "--help",
    "--state", helpState,
    "--systemd-dir", helpSystemdDir,
  ]);
  assert.match(helpLines[0], /init \[--state \/path\]/);
  assert.equal(fs.existsSync(helpState), false);
  assert.equal(fs.existsSync(helpSystemdDir), false);
});

async function runCli(argv) {
  const lines = await captureCli(argv);
  return lines[0] ? JSON.parse(lines[0]) : null;
}

async function captureCli(argv) {
  const lines = [];
  const originalLog = console.log;
  console.log = (value) => lines.push(String(value));
  try {
    await runAgentCli(argv);
  } finally {
    console.log = originalLog;
  }
  return lines;
}
