import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultRunnerSettingsPath, defaultOpusEditSettingsPath } from "./exchange-runner.js";

const ENV_FILE = "%h/.config/codex-agent/telegram.env";
const SERVICE_PATH = [
  path.join(os.homedir(), ".local", "bin"),
  path.join(os.homedir(), ".npm-global", "bin"),
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
].join(":");

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

// ── Codex exchange auto-runner service ───────────────────────────────────────
//
// Mirrors the Opus runner service, but ExecStart runs:
//   node bin/codex-agent.js exchange-runner --agent codex --once
// No settings file needed (codex uses its own sandbox via codex exec).

const CODEX_RUNNER_SERVICE_NAME = "codex-agent-codex-runner.service";
const CODEX_RUNNER_TIMER_NAME = "codex-agent-codex-runner.timer";
const DEFAULT_CODEX_RUNNER_INTERVAL_SECONDS = 90;

export function buildCodexRunnerService({ repoDir = process.cwd(), nodePath = process.execPath, intervalSeconds } = {}) {
  const interval = Number.isFinite(Number(intervalSeconds)) && Number(intervalSeconds) > 0
    ? Math.floor(Number(intervalSeconds))
    : DEFAULT_CODEX_RUNNER_INTERVAL_SECONDS;

  const args = [
    path.join(repoDir, "bin", "codex-agent.js"),
    "exchange-runner",
    "--agent", "codex",
    "--once",
  ];
  const execStart = `${nodePath} ${args.join(" ")}`;

  const unit = [
    "[Unit]",
    "Description=Codex Agent Codex exchange auto-runner (one-shot, mailbox task executor)",
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
    "Description=Run the Codex exchange auto-runner periodically",
    "",
    "[Timer]",
    "OnBootSec=2min",
    `OnUnitActiveSec=${interval}s`,
    `Unit=${CODEX_RUNNER_SERVICE_NAME}`,
    "Persistent=false",
    "",
    "[Install]",
    "WantedBy=timers.target",
    "",
  ].join("\n");

  return {
    unit_name: CODEX_RUNNER_SERVICE_NAME,
    timer_name: CODEX_RUNNER_TIMER_NAME,
    interval_seconds: interval,
    unit,
    timer,
  };
}

export function writeCodexRunnerService({ dir, repoDir, nodePath, intervalSeconds } = {}) {
  if (!dir) {
    throw new Error("Missing required --dir");
  }
  const built = buildCodexRunnerService({ repoDir, nodePath, intervalSeconds });
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
    next_steps: codexRunnerServiceStatus({ dir }).commands,
  };
}

export function codexRunnerServiceStatus({ dir, repoDir = process.cwd(), nodePath = process.execPath, intervalSeconds } = {}) {
  const targetDir = dir || path.join(os.homedir(), ".config", "systemd", "user");
  const built = buildCodexRunnerService({ repoDir, nodePath, intervalSeconds });
  const unitPath = path.join(targetDir, CODEX_RUNNER_SERVICE_NAME);
  const timerPath = path.join(targetDir, CODEX_RUNNER_TIMER_NAME);
  return {
    dir: targetDir,
    unit: { name: CODEX_RUNNER_SERVICE_NAME, path: unitPath, ...fileDrift(unitPath, built.unit) },
    timer: { name: CODEX_RUNNER_TIMER_NAME, path: timerPath, ...fileDrift(timerPath, built.timer) },
    note: "Files are generated only; this tool never runs systemctl, enables, or starts anything.",
    commands: {
      reload: "systemctl --user daemon-reload",
      enable: `systemctl --user enable --now ${CODEX_RUNNER_TIMER_NAME}`,
      disable: `systemctl --user disable --now ${CODEX_RUNNER_TIMER_NAME}`,
      logs: `journalctl --user -u ${CODEX_RUNNER_SERVICE_NAME}`,
    },
  };
}

// ── Exec agent runner service ───────────────────────────────────────────────

const EXEC_RUNNER_SERVICE_NAME = "codex-agent-exec-runner.service";
const EXEC_RUNNER_TIMER_NAME = "codex-agent-exec-runner.timer";
const DEFAULT_EXEC_RUNNER_INTERVAL_SECONDS = 90;

export function buildExecRunnerService({ agentHome, repoDir = process.cwd(), nodePath = process.execPath, intervalSeconds } = {}) {
  const interval = Number.isFinite(Number(intervalSeconds)) && Number(intervalSeconds) > 0
    ? Math.floor(Number(intervalSeconds))
    : DEFAULT_EXEC_RUNNER_INTERVAL_SECONDS;
  const args = [
    path.join(repoDir, "bin", "codex-agent.js"),
    "exec-runner-once",
    "--state", agentHome,
    "--repo", repoDir,
  ];
  const execStart = `${nodePath} ${args.join(" ")}`;
  const unit = [
    "[Unit]",
    "Description=Codex Agent exec-style agent runner (one-shot, stdin/stdout mailbox executor)",
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
    "Description=Run the exec-style agent runner periodically",
    "",
    "[Timer]",
    "OnBootSec=2min",
    `OnUnitActiveSec=${interval}s`,
    `Unit=${EXEC_RUNNER_SERVICE_NAME}`,
    "Persistent=false",
    "",
    "[Install]",
    "WantedBy=timers.target",
    "",
  ].join("\n");
  return {
    unit_name: EXEC_RUNNER_SERVICE_NAME,
    timer_name: EXEC_RUNNER_TIMER_NAME,
    interval_seconds: interval,
    unit,
    timer,
  };
}

export function writeExecRunnerService({ agentHome, dir, repoDir, nodePath, intervalSeconds } = {}) {
  if (!dir) {
    throw new Error("Missing required --dir");
  }
  const built = buildExecRunnerService({ agentHome, repoDir, nodePath, intervalSeconds });
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
    next_steps: execRunnerServiceStatus({ agentHome, dir }).commands,
  };
}

export function execRunnerServiceStatus({ agentHome, dir, repoDir = process.cwd(), nodePath = process.execPath, intervalSeconds } = {}) {
  const targetDir = dir || path.join(os.homedir(), ".config", "systemd", "user");
  const built = buildExecRunnerService({ agentHome, repoDir, nodePath, intervalSeconds });
  const unitPath = path.join(targetDir, EXEC_RUNNER_SERVICE_NAME);
  const timerPath = path.join(targetDir, EXEC_RUNNER_TIMER_NAME);
  return {
    dir: targetDir,
    unit: { name: EXEC_RUNNER_SERVICE_NAME, path: unitPath, ...fileDrift(unitPath, built.unit) },
    timer: { name: EXEC_RUNNER_TIMER_NAME, path: timerPath, ...fileDrift(timerPath, built.timer) },
    note: "Files are generated only; this tool never runs systemctl, enables, or starts anything.",
    commands: {
      reload: "systemctl --user daemon-reload",
      enable: `systemctl --user enable --now ${EXEC_RUNNER_TIMER_NAME}`,
      disable: `systemctl --user disable --now ${EXEC_RUNNER_TIMER_NAME}`,
      logs: `journalctl --user -u ${EXEC_RUNNER_SERVICE_NAME}`,
    },
  };
}

// ── v3 dashboard bridge service ─────────────────────────────────────────────

const DASHBOARD_SERVICE_NAME = "codex-agent-dashboard.service";
const DEFAULT_DASHBOARD_LONG_POLL_SECONDS = 25;

export function buildDashboardService({ agentHome, repoDir = process.cwd(), nodePath = process.execPath, longPollSeconds } = {}) {
  const longPoll = Number.isFinite(Number(longPollSeconds)) && Number(longPollSeconds) >= 0
    ? Math.floor(Number(longPollSeconds))
    : DEFAULT_DASHBOARD_LONG_POLL_SECONDS;
  const args = [
    path.join(repoDir, "bin", "codex-agent.js"),
    "dashboard-bridge",
    "--state", agentHome,
    "--transport", "curl",
    "--long-poll-seconds", String(longPoll),
  ];
  const unit = [
    "[Unit]",
    "Description=Codex Agent v3 Telegram dashboard bridge",
    "",
    "[Service]",
    "Type=simple",
    `WorkingDirectory=${repoDir}`,
    `EnvironmentFile=${ENV_FILE}`,
    `Environment=PATH=${SERVICE_PATH}`,
    `ExecStart=${nodePath} ${args.join(" ")}`,
    "Restart=always",
    "RestartSec=5",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
  return {
    unit_name: DASHBOARD_SERVICE_NAME,
    env_file: ENV_FILE,
    long_poll_seconds: longPoll,
    unit,
  };
}

export function writeDashboardService({ agentHome, dir, repoDir, nodePath, longPollSeconds } = {}) {
  if (!dir) {
    throw new Error("Missing required --dir");
  }
  const built = buildDashboardService({ agentHome, repoDir, nodePath, longPollSeconds });
  fs.mkdirSync(dir, { recursive: true });
  const unitPath = path.join(dir, built.unit_name);
  fs.writeFileSync(unitPath, built.unit);
  return {
    unit_path: unitPath,
    unit_name: built.unit_name,
    env_file: built.env_file,
    note: "Files written but NOT enabled. This tool never runs systemctl.",
    next_steps: dashboardServiceStatus({ dir }).commands,
  };
}

export function dashboardServiceStatus({ dir, agentHome, repoDir = process.cwd(), nodePath = process.execPath, longPollSeconds } = {}) {
  const targetDir = dir || path.join(os.homedir(), ".config", "systemd", "user");
  const built = buildDashboardService({ agentHome, repoDir, nodePath, longPollSeconds });
  const unitPath = path.join(targetDir, DASHBOARD_SERVICE_NAME);
  return {
    dir: targetDir,
    unit: { name: DASHBOARD_SERVICE_NAME, path: unitPath, ...fileDrift(unitPath, built.unit) },
    env_file: ENV_FILE,
    note: "Files are generated only; this tool never runs systemctl, enables, or starts anything.",
    commands: {
      reload: "systemctl --user daemon-reload",
      enable: `systemctl --user enable --now ${DASHBOARD_SERVICE_NAME}`,
      disable: `systemctl --user disable --now ${DASHBOARD_SERVICE_NAME}`,
      logs: `journalctl --user -u ${DASHBOARD_SERVICE_NAME}`,
    },
  };
}

// ── local Web GUI service ────────────────────────────────────────────────────

const WEB_SERVICE_NAME = "codex-agent-web.service";
const DEFAULT_WEB_PORT = 4310;

export function buildWebService({ agentHome, repoDir = process.cwd(), nodePath = process.execPath, port = DEFAULT_WEB_PORT } = {}) {
  if (!agentHome) {
    throw new Error("Missing agentHome");
  }
  const webPort = normalizeWebPort(port);
  const args = [
    path.join(repoDir, "bin", "codex-agent.js"),
    "web",
    "--state", agentHome,
    "--repo", repoDir,
    "--port", String(webPort),
  ];
  const unit = [
    "[Unit]",
    "Description=Agent River local Web GUI",
    "",
    "[Service]",
    "Type=simple",
    `WorkingDirectory=${repoDir}`,
    `Environment=PATH=${SERVICE_PATH}`,
    `ExecStart=${nodePath} ${args.join(" ")}`,
    "Restart=on-failure",
    "RestartSec=5",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
  return {
    unit_name: WEB_SERVICE_NAME,
    bind_address: "127.0.0.1",
    port: webPort,
    unit,
  };
}

export function writeWebService({ agentHome, dir, repoDir, nodePath, port } = {}) {
  if (!dir) {
    throw new Error("Missing required --dir");
  }
  const built = buildWebService({ agentHome, repoDir, nodePath, port });
  fs.mkdirSync(dir, { recursive: true });
  const unitPath = path.join(dir, built.unit_name);
  fs.writeFileSync(unitPath, built.unit);
  return {
    unit_path: unitPath,
    unit_name: built.unit_name,
    bind_address: built.bind_address,
    port: built.port,
    note: "File written but NOT enabled. This tool never runs systemctl.",
    next_steps: webServiceStatus({ agentHome, dir, repoDir, nodePath, port }).commands,
  };
}

export function webServiceStatus({ agentHome, dir, repoDir = process.cwd(), nodePath = process.execPath, port } = {}) {
  const targetDir = dir || path.join(os.homedir(), ".config", "systemd", "user");
  const built = buildWebService({ agentHome, repoDir, nodePath, port });
  const unitPath = path.join(targetDir, WEB_SERVICE_NAME);
  return {
    dir: targetDir,
    unit: { name: WEB_SERVICE_NAME, path: unitPath, ...fileDrift(unitPath, built.unit) },
    bind_address: built.bind_address,
    port: built.port,
    note: "File is generated only; this tool never runs systemctl, enables, or starts anything.",
    commands: {
      reload: "systemctl --user daemon-reload",
      enable: `systemctl --user enable --now ${WEB_SERVICE_NAME}`,
      disable: `systemctl --user disable --now ${WEB_SERVICE_NAME}`,
      logs: `journalctl --user -u ${WEB_SERVICE_NAME}`,
    },
  };
}

function normalizeWebPort(value) {
  const port = Number(value ?? DEFAULT_WEB_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Web port must be an integer between 1 and 65535");
  }
  return port;
}
