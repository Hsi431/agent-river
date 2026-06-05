import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultRunnerSettingsPath, defaultOpusEditSettingsPath } from "./exchange-runner.js";
import { getTelegramCodexPolicy } from "./safety.js";

// Generates systemd --user unit/timer TEXT for the telegram-codex paths. It
// NEVER runs systemctl, never enables/starts anything, and never writes the bot
// token. The token is supplied by the operator via an EnvironmentFile the unit
// references. Both modes force approval-before-send, so unattended operation only
// ever drafts pending approvals — it does not auto-send Codex replies.
//
//   mode "timer"  (default, fallback): a oneshot loop run periodically by a timer.
//   mode "bridge" (R1, near-realtime):  a long-running long-poll bridge process,
//                                        Type=simple + Restart=always, no timer.

const SERVICE_NAME = "codex-agent-telegram.service";
const TIMER_NAME = "codex-agent-telegram.timer";
const BRIDGE_SERVICE_NAME = "codex-agent-telegram-bridge.service";
const ENV_FILE = "%h/.config/codex-agent/telegram.env";
const DEFAULT_BRIDGE_LONG_POLL_SECONDS = 25;
const SERVICE_PATH = [
  path.join(os.homedir(), ".local", "bin"),
  path.join(os.homedir(), ".npm-global", "bin"),
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
].join(":");

export function buildTelegramCodexService({ agentHome, repoDir = process.cwd(), nodePath = process.execPath, intervalSeconds, includeMemory, mode = "timer", longPollSeconds } = {}) {
  if (mode === "bridge") {
    return buildBridgeService({ agentHome, repoDir, nodePath, includeMemory, longPollSeconds });
  }
  if (mode !== "timer") {
    throw new Error(`Unknown service mode: ${mode}`);
  }
  const policy = getTelegramCodexPolicy(agentHome);
  const interval = Number.isFinite(Number(intervalSeconds)) && Number(intervalSeconds) > 0
    ? Math.floor(Number(intervalSeconds))
    : (policy.global_interval_seconds || 60);
  const useMemory = includeMemory === undefined ? Boolean(policy.memory_enabled) : Boolean(includeMemory);
  const memoryState = path.join(os.homedir(), ".codex", "memory-river");

  const args = [
    path.join(repoDir, "bin", "codex-agent.js"),
    "telegram-codex-loop",
    "--state", agentHome,
    "--transport", "curl",
    "--allow-real-codex",
    "--iterations", "1",
    "--sleep-seconds", "0",
  ];
  if (useMemory) {
    args.push("--memory-state", memoryState);
  }
  const execStart = `${nodePath} ${args.join(" ")}`;

  const unit = [
    "[Unit]",
    "Description=Codex Agent Telegram bounded loop (approval-before-send only)",
    "",
    "[Service]",
    "Type=oneshot",
    `WorkingDirectory=${repoDir}`,
    `EnvironmentFile=${ENV_FILE}`,
    `Environment=PATH=${SERVICE_PATH}`,
    `ExecStart=${execStart}`,
    "",
  ].join("\n");

  const timer = [
    "[Unit]",
    "Description=Run the Codex Agent Telegram bounded loop periodically",
    "",
    "[Timer]",
    "OnBootSec=60",
    `OnUnitActiveSec=${interval}`,
    `Unit=${SERVICE_NAME}`,
    "Persistent=false",
    "",
    "[Install]",
    "WantedBy=timers.target",
    "",
  ].join("\n");

  return {
    mode: "timer",
    unit_name: SERVICE_NAME,
    timer_name: TIMER_NAME,
    env_file: ENV_FILE,
    interval_seconds: interval,
    memory: useMemory,
    unit,
    timer,
  };
}

function buildBridgeService({ agentHome, repoDir, nodePath, includeMemory, longPollSeconds }) {
  const policy = getTelegramCodexPolicy(agentHome);
  const useMemory = includeMemory === undefined ? Boolean(policy.memory_enabled) : Boolean(includeMemory);
  const memoryState = path.join(os.homedir(), ".codex", "memory-river");
  const longPoll = Number.isFinite(Number(longPollSeconds)) && Number(longPollSeconds) >= 0
    ? Math.floor(Number(longPollSeconds))
    : DEFAULT_BRIDGE_LONG_POLL_SECONDS;

  const args = [
    path.join(repoDir, "bin", "codex-agent.js"),
    "telegram-codex-bridge",
    "--state", agentHome,
    "--transport", "curl",
    "--allow-real-codex",
    "--long-poll-seconds", String(longPoll),
  ];
  if (useMemory) {
    args.push("--memory-state", memoryState);
  }
  const execStart = `${nodePath} ${args.join(" ")}`;

  const unit = [
    "[Unit]",
    "Description=Codex Agent Telegram bridge (long-poll, approval-before-send only)",
    "",
    "[Service]",
    "Type=simple",
    `WorkingDirectory=${repoDir}`,
    `EnvironmentFile=${ENV_FILE}`,
    `Environment=PATH=${SERVICE_PATH}`,
    `ExecStart=${execStart}`,
    "Restart=always",
    "RestartSec=5",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");

  return {
    mode: "bridge",
    unit_name: BRIDGE_SERVICE_NAME,
    timer_name: null,
    env_file: ENV_FILE,
    long_poll_seconds: longPoll,
    memory: useMemory,
    unit,
    timer: null,
  };
}

export function writeTelegramCodexService({ agentHome, dir, repoDir, intervalSeconds, includeMemory, mode = "timer", longPollSeconds } = {}) {
  if (!dir) {
    throw new Error("Missing required --dir");
  }
  const built = buildTelegramCodexService({ agentHome, repoDir, intervalSeconds, includeMemory, mode, longPollSeconds });
  fs.mkdirSync(dir, { recursive: true });
  const unitPath = path.join(dir, built.unit_name);
  fs.writeFileSync(unitPath, built.unit);
  let timerPath = null;
  if (built.timer && built.timer_name) {
    timerPath = path.join(dir, built.timer_name);
    fs.writeFileSync(timerPath, built.timer);
  }
  return {
    mode: built.mode,
    unit_path: unitPath,
    timer_path: timerPath,
    unit_name: built.unit_name,
    timer_name: built.timer_name,
    env_file: built.env_file,
    note: "Files written but NOT enabled. This tool never runs systemctl.",
    next_steps: telegramCodexServiceStatus({ dir, mode: built.mode }).commands,
  };
}

// ── Opus exchange auto-runner service ────────────────────────────────────────
//
// Generates the one-shot service + periodic timer unit text for the headless
// Opus exchange runner. Follows the same "files only, never systemctl" contract
// as the Telegram service generator above.
//
// Also provides a settings template generator: the restricted Claude settings
// file is the fail-closed safety envelope — the runner refuses to spawn if it
// is absent. Call writeOpusRunnerSettings() to lay it down before first use.

const OPUS_RUNNER_SERVICE_NAME = "codex-agent-opus-runner.service";
const OPUS_RUNNER_TIMER_NAME = "codex-agent-opus-runner.timer";
const DEFAULT_OPUS_RUNNER_INTERVAL_SECONDS = 90;

export function buildOpusRunnerService({ repoDir = process.cwd(), nodePath = process.execPath, intervalSeconds } = {}) {
  const interval = Number.isFinite(Number(intervalSeconds)) && Number(intervalSeconds) > 0
    ? Math.floor(Number(intervalSeconds))
    : DEFAULT_OPUS_RUNNER_INTERVAL_SECONDS;

  const args = [
    path.join(repoDir, "bin", "codex-agent.js"),
    "exchange-runner",
    "--agent", "opus",
    "--once",
  ];
  const execStart = `${nodePath} ${args.join(" ")}`;

  const unit = [
    "[Unit]",
    "Description=Codex Agent Opus exchange auto-runner (one-shot, mailbox task executor)",
    "",
    "[Service]",
    "Type=oneshot",
    `WorkingDirectory=${repoDir}`,
    `Environment=PATH=${SERVICE_PATH}`,
    `ExecStart=${execStart}`,
    "",
  ].join("\n");

  const timer = [
    "[Unit]",
    "Description=Run the Opus exchange auto-runner periodically",
    "",
    "[Timer]",
    "OnBootSec=2min",
    `OnUnitActiveSec=${interval}s`,
    `Unit=${OPUS_RUNNER_SERVICE_NAME}`,
    "Persistent=false",
    "",
    "[Install]",
    "WantedBy=timers.target",
    "",
  ].join("\n");

  return {
    unit_name: OPUS_RUNNER_SERVICE_NAME,
    timer_name: OPUS_RUNNER_TIMER_NAME,
    interval_seconds: interval,
    unit,
    timer,
  };
}

export function writeOpusRunnerService({ dir, repoDir, nodePath, intervalSeconds } = {}) {
  if (!dir) {
    throw new Error("Missing required --dir");
  }
  const built = buildOpusRunnerService({ repoDir, nodePath, intervalSeconds });
  fs.mkdirSync(dir, { recursive: true });
  const unitPath = path.join(dir, built.unit_name);
  const timerPath = path.join(dir, built.timer_name);
  fs.writeFileSync(unitPath, built.unit);
  fs.writeFileSync(timerPath, built.timer);
  return {
    unit_path: unitPath,
    timer_path: timerPath,
    unit_name: built.unit_name,
    timer_name: built.timer_name,
    note: "Files written but NOT enabled. This tool never runs systemctl.",
    next_steps: opusRunnerServiceStatus({ dir }).commands,
  };
}

export function opusRunnerServiceStatus({ dir, repoDir = process.cwd(), nodePath = process.execPath, intervalSeconds, settingsPath } = {}) {
  const targetDir = dir || path.join(os.homedir(), ".config", "systemd", "user");
  const built = buildOpusRunnerService({ repoDir, nodePath, intervalSeconds });
  const unitPath = path.join(targetDir, OPUS_RUNNER_SERVICE_NAME);
  const timerPath = path.join(targetDir, OPUS_RUNNER_TIMER_NAME);
  const runnerSettingsPath = settingsPath || defaultRunnerSettingsPath();
  const expectedSettings = JSON.stringify(buildOpusRunnerSettings(), null, 2) + "\n";
  return {
    dir: targetDir,
    unit: { name: OPUS_RUNNER_SERVICE_NAME, path: unitPath, ...fileDrift(unitPath, built.unit) },
    timer: { name: OPUS_RUNNER_TIMER_NAME, path: timerPath, ...fileDrift(timerPath, built.timer) },
    settings: { path: runnerSettingsPath, ...fileDrift(runnerSettingsPath, expectedSettings) },
    note: "Files are generated only; this tool never runs systemctl, enables, or starts anything.",
    commands: {
      reload: "systemctl --user daemon-reload",
      enable: `systemctl --user enable --now ${OPUS_RUNNER_TIMER_NAME}`,
      disable: `systemctl --user disable --now ${OPUS_RUNNER_TIMER_NAME}`,
      logs: `journalctl --user -u ${OPUS_RUNNER_SERVICE_NAME}`,
    },
  };
}

function fileDrift(filePath, expected) {
  if (!fs.existsSync(filePath)) {
    return { exists: false, drift: "missing" };
  }
  let actual;
  try {
    actual = fs.readFileSync(filePath, "utf8");
  } catch {
    return { exists: true, drift: "unreadable" };
  }
  return { exists: true, drift: actual === expected ? "match" : "drifted" };
}

export function buildOpusRunnerSettings() {
  return {
    $comment: "Least-privilege settings for the headless Opus exchange auto-runner. Read-only repo + exchange/git-read/test commands only. Node records the mailbox reply after Claude returns final text. No file edits, no commits/push, no arbitrary shell. In `claude -p` mode any tool not listed here is auto-denied.",
    permissions: {
      defaultMode: "default",
      allow: [
        "Read",
        "Grep",
        "Glob",
        `Bash(node bin/codex-agent.js exchange-thread:*)`,
        `Bash(node bin/codex-agent.js exchange-status:*)`,
        `Bash(node bin/codex-agent.js exchange-inbox:*)`,
        `Bash(node bin/codex-agent.js exchange-runner-session-status:*)`,
        "Bash(git status)",
        "Bash(git status:*)",
        "Bash(git diff:*)",
        "Bash(git log:*)",
        "Bash(git show:*)",
        "Bash(npm test)",
        "Bash(node --test:*)",
      ],
      deny: [
        "Edit",
        "MultiEdit",
        "NotebookEdit",
        "Write",
        "Bash(git commit:*)",
        "Bash(git push:*)",
        "Bash(git reset:*)",
        "Bash(git checkout:*)",
        "Bash(rm:*)",
        "Bash(sudo:*)",
        `Bash(node bin/codex-agent.js exchange-submit:*)`,
        `Bash(node bin/codex-agent.js exchange-claim:*)`,
        `Bash(node bin/codex-agent.js exchange-release:*)`,
        `Bash(node bin/codex-agent.js run:*)`,
        `Bash(node bin/codex-agent.js approve:*)`,
        `Bash(node bin/codex-agent.js reject:*)`,
        `Bash(node bin/codex-agent.js submit:*)`,
        "Bash(curl:*)",
        "Bash(wget:*)",
        "WebFetch",
        "WebSearch",
      ],
    },
  };
}

export function writeOpusRunnerSettings({ settingsPath } = {}) {
  const dest = settingsPath || defaultRunnerSettingsPath();
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (fs.existsSync(dest)) {
    return { path: dest, written: false, note: "Already exists; not overwritten. Delete manually to regenerate." };
  }
  fs.writeFileSync(dest, JSON.stringify(buildOpusRunnerSettings(), null, 2) + "\n");
  return { path: dest, written: true };
}

// Edit-capable envelope for Opus execution: can read + write/edit files inside
// the allowlisted repo and /tmp, run the test suite, and read git — but NEVER
// commit/push/deploy/install/delete, run arbitrary shell, reach the network, or
// dispatch to other agents. Same v1 boundary as the Codex edit task.
export function buildOpusEditSettings({ repoDir = process.cwd() } = {}) {
  // defaultMode "acceptEdits" is what actually lets a headless `claude -p`
  // process apply file edits without an interactive prompt — path-scoped
  // Edit(<repo>/**) allow rules do NOT match in headless mode (verified: the
  // edit is denied). File edits are constrained to the repo by --add-dir/cwd;
  // Bash still requires the explicit allow list below and obeys the deny list,
  // so commit/push/deploy/install/network/cross-agent dispatch stay blocked.
  return {
    $comment: "Edit-capable least-privilege settings for headless Opus execution. acceptEdits auto-applies file edits (scoped to the repo via --add-dir); Bash is allow-listed (tests + git read) and the deny list blocks commit/push/deploy/install/delete, arbitrary shell, network, and cross-agent dispatch.",
    permissions: {
      defaultMode: "acceptEdits",
      allow: [
        "Read",
        "Grep",
        "Glob",
        "Edit",
        "MultiEdit",
        "Write",
        `Bash(node bin/codex-agent.js exchange-thread:*)`,
        `Bash(node bin/codex-agent.js exchange-status:*)`,
        `Bash(node bin/codex-agent.js exchange-inbox:*)`,
        `Bash(node bin/codex-agent.js exchange-runner-session-status:*)`,
        "Bash(git status)",
        "Bash(git status:*)",
        "Bash(git diff:*)",
        "Bash(git log:*)",
        "Bash(git show:*)",
        "Bash(npm test)",
        "Bash(node --test:*)",
      ],
      deny: [
        "Bash(git commit:*)",
        "Bash(git push:*)",
        "Bash(git reset:*)",
        "Bash(git checkout:*)",
        "Bash(git rebase:*)",
        "Bash(rm:*)",
        "Bash(sudo:*)",
        "Bash(npm install:*)",
        "Bash(npm publish:*)",
        "Bash(npx:*)",
        `Bash(node bin/codex-agent.js exchange-submit:*)`,
        `Bash(node bin/codex-agent.js exchange-claim:*)`,
        `Bash(node bin/codex-agent.js exchange-release:*)`,
        `Bash(node bin/codex-agent.js run:*)`,
        `Bash(node bin/codex-agent.js approve:*)`,
        `Bash(node bin/codex-agent.js reject:*)`,
        `Bash(node bin/codex-agent.js submit:*)`,
        "Bash(curl:*)",
        "Bash(wget:*)",
        "WebFetch",
        "WebSearch",
      ],
    },
  };
}

export function writeOpusEditSettings({ settingsPath, repoDir } = {}) {
  const dest = settingsPath || defaultOpusEditSettingsPath();
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (fs.existsSync(dest)) {
    return { path: dest, written: false, note: "Already exists; not overwritten. Delete manually to regenerate." };
  }
  fs.writeFileSync(dest, JSON.stringify(buildOpusEditSettings({ repoDir }), null, 2) + "\n");
  return { path: dest, written: true };
}

export function telegramCodexServiceStatus({ dir, mode = "timer" } = {}) {
  const targetDir = dir || path.join(os.homedir(), ".config", "systemd", "user");
  if (mode === "bridge") {
    const unitPath = path.join(targetDir, BRIDGE_SERVICE_NAME);
    return {
      mode: "bridge",
      dir: targetDir,
      unit: { name: BRIDGE_SERVICE_NAME, path: unitPath, exists: fs.existsSync(unitPath) },
      timer: null,
      env_file: ENV_FILE,
      note: "Files are generated only; this tool never runs systemctl, enables, or starts anything.",
      commands: {
        reload: "systemctl --user daemon-reload",
        enable: `systemctl --user enable --now ${BRIDGE_SERVICE_NAME}`,
        disable: `systemctl --user disable --now ${BRIDGE_SERVICE_NAME}`,
        logs: `journalctl --user -u ${BRIDGE_SERVICE_NAME}`,
      },
    };
  }
  const unitPath = path.join(targetDir, SERVICE_NAME);
  const timerPath = path.join(targetDir, TIMER_NAME);
  return {
    mode: "timer",
    dir: targetDir,
    unit: { name: SERVICE_NAME, path: unitPath, exists: fs.existsSync(unitPath) },
    timer: { name: TIMER_NAME, path: timerPath, exists: fs.existsSync(timerPath) },
    env_file: ENV_FILE,
    note: "Files are generated only; this tool never runs systemctl, enables, or starts anything.",
    commands: {
      reload: "systemctl --user daemon-reload",
      enable: `systemctl --user enable --now ${TIMER_NAME}`,
      disable: `systemctl --user disable --now ${TIMER_NAME}`,
      logs: `journalctl --user -u ${SERVICE_NAME}`,
    },
  };
}
