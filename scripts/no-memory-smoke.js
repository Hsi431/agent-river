import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const repoDir = path.resolve(import.meta.dirname, "..");
const installedPath = path.join(repoDir, "node_modules", "codex-memory-river");
const hiddenPath = path.join(repoDir, "node_modules", ".codex-memory-river.no-memory-smoke");
const hadInstalledPackage = fs.existsSync(installedPath);

if (fs.existsSync(hiddenPath)) {
  throw new Error(`Refusing to overwrite existing smoke-test path: ${hiddenPath}`);
}

try {
  if (hadInstalledPackage) {
    fs.renameSync(installedPath, hiddenPath);
  }

  run(process.execPath, [
    "--input-type=module",
    "--eval",
    [
      'await import("./src/agent/cli.js");',
      'await import("./src/agent/gateway.js");',
      'await import("./src/agent/telegram.js");',
      'await import("./src/agent/orchestrator.js");',
      'await import("./src/agent/codex-runner.js");',
      'await import("./src/agent/exchange-runner.js");',
      'const { buildMemoryContextBlock } = await import("./src/agent/memory-adapter.js");',
      'try {',
      '  await buildMemoryContextBlock({ enabled: true, repo: process.cwd() });',
      '  throw new Error("Memory River unexpectedly resolved");',
      '} catch (error) {',
      '  if (error.reason !== "memory_unavailable") throw error;',
      '}',
    ].join(""),
  ]);
  run(process.execPath, [
    "--test",
    "test/agent-dispatch.test.js",
    "test/agent-exchange-runner.test.js",
  ]);
  run(process.execPath, [
    "--test",
    "--test-name-pattern",
    "agent run works without Memory River|package exposes codex-agent without hard Memory River dependency|memory adapter skips Memory River",
    "test/agent.test.js",
  ]);
} finally {
  if (hadInstalledPackage) {
    fs.renameSync(hiddenPath, installedPath);
  }
}

function run(file, args) {
  const result = spawnSync(file, args, {
    cwd: repoDir,
    stdio: "inherit",
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exitCode = result.status || 1;
    throw new Error(`${file} ${args.join(" ")} failed`);
  }
}
