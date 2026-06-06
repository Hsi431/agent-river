import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { sha256 } from "../lib/hash.js";
import {
  appendRun,
  approveTask,
  createTask,
  listTasks,
  recordTaskEvent,
  readRuns,
  readTask,
  rejectTask,
  transitionTask,
} from "./tasks.js";
import { runEditStep, runPlanStep } from "./worker.js";
import { appendCost, checkSafety, getSafetyStatus, getTelegramCodexPolicy } from "./safety.js";
import { makeOpusEditRunner } from "./exchange-runner.js";
import { redactSecrets, scanSecrets } from "../lib/secret-scan.js";
import { buildMemoryContextBlock } from "./memory-adapter.js";

export const EDIT_VERIFY_COMMAND = ["npm", "test"];

export function submitAgentTask({ agentHome, repo, request, mode = "plan", approval = "not_required", executor = "codex", chatId = null, source = "cli", requester = "local" }) {
  return createTask({ agentHome, repo, request, mode, approval, executor, chatId, source, requester });
}

export function approveAgentTask({ agentHome, id }) {
  return approveTask(agentHome, id);
}

export function rejectAgentTask({ agentHome, id }) {
  return rejectTask(agentHome, id);
}

export function getAgentStatus({ agentHome, id } = {}) {
  if (id) {
    const task = readTask(agentHome, id);
    if (!task) {
      throw new Error(`Task not found: ${id}`);
    }
    return { task, runs: readRuns(agentHome).filter((run) => run.task_id === id) };
  }
  return { tasks: listTasks(agentHome), runs: readRuns(agentHome), safety: getSafetyStatus(agentHome) };
}

export async function runAgentOnce({ agentHome, memoryStateHome, memoryContextImpl, runner, taskId, execFileImpl } = {}) {
  const runnable = listTasks(agentHome)
    .filter((task) => !taskId || task.id === taskId)
    .filter((task) => isAdvanceable(task.status));
  const lockedRepos = new Set();
  const results = [];
  let advanced = 0;
  for (const task of runnable) {
    if (task.mode !== "plan" && task.mode !== "edit") {
      results.push(rejectNonPlanTask(agentHome, task));
      advanced += 1;
      continue;
    }
    if (!isApprovalRunnable(task.approval)) {
      continue;
    }
    if (task.status !== "queued") {
      results.push(recoverInterruptedTask(agentHome, task));
      advanced += 1;
      continue;
    }
    if (lockedRepos.has(task.repo)) {
      continue;
    }
    const guard = checkSafety(agentHome);
    if (!guard.ok) {
      results.push(parkTask(agentHome, task, guard.reason));
      continue;
    }
    lockedRepos.add(task.repo);
    if (task.mode === "edit") {
      results.push(await runEditTask({ agentHome, memoryStateHome, memoryContextImpl, task, runner, execFileImpl }));
    } else {
      results.push(await runPlanOnlyTask({ agentHome, memoryStateHome, memoryContextImpl, task, runner }));
    }
    advanced += 1;
  }
  return { advanced, tasks: results, safety: getSafetyStatus(agentHome) };
}

function isAdvanceable(status) {
  return status === "queued" || status === "planning" || status === "reporting";
}

function isApprovalRunnable(approval) {
  return approval === "not_required" || approval === "approved";
}

function recoverInterruptedTask(agentHome, task) {
  return transitionTask(agentHome, task, "failed", `Task was interrupted while ${task.status}.`);
}

function rejectNonPlanTask(agentHome, task) {
  return transitionTask(agentHome, task, "failed", `Refusing to run unsupported mode: ${task.mode}.`);
}

function parkTask(agentHome, task, reason) {
  const note = `Safety guard parked task: ${reason}.`;
  if (task.history.at(-1)?.note === note) {
    return task;
  }
  return recordTaskEvent(agentHome, task, note);
}

async function runPlanOnlyTask({ agentHome, memoryStateHome, memoryContextImpl, task, runner }) {
  let current = transitionTask(agentHome, task, "planning", "Planning started.");
  const startedAt = new Date().toISOString();

  let contextBlock;
  let workerResult;
  try {
    contextBlock = await buildContextBlock({ agentHome, memoryStateHome, memoryContextImpl, repo: current.repo });
    workerResult = await runPlanStep({ task: current, contextBlock, runner });
  } catch (error) {
    // A throw (e.g. preflight or the runner failing) must not strand the task in
    // "planning". Record a sanitized run error and transition it to failed.
    appendRun(agentHome, {
      task_id: current.id,
      step: "planning",
      started_at: startedAt,
      ended_at: new Date().toISOString(),
      exit: 1,
      codex_session: null,
      tokens: 0,
      usd_estimate: 0,
      error: redactSecrets(String(error?.message ?? "Planning threw an error.")),
    });
    return transitionTask(agentHome, current, "failed", "Planning threw an error.", {
      patch: { attempts: current.attempts + 1 },
    });
  }
  const endedAt = new Date().toISOString();

  appendRun(agentHome, {
    task_id: current.id,
    step: "planning",
    started_at: startedAt,
    ended_at: endedAt,
    exit: workerResult.exit,
    codex_session: workerResult.sessionPath,
    tokens: workerResult.tokens,
    usd_estimate: 0,
    error: workerResult.exit === 0 ? null : redactSecrets(String(workerResult.text ?? "")),
  });
  appendCost(agentHome, {
    task_id: current.id,
    step: "planning",
    tokens: workerResult.tokens,
    usd_estimate: 0,
  });

  if (workerResult.exit !== 0) {
    return transitionTask(agentHome, current, "failed", "Planning failed.", {
      codexSession: workerResult.sessionPath,
      patch: {
        attempts: current.attempts + 1,
        cost: { ...current.cost, tokens: current.cost.tokens + workerResult.tokens },
      },
    });
  }

  current = transitionTask(agentHome, current, "reporting", "Planning completed.", {
    codexSession: workerResult.sessionPath,
    patch: {
      cost: { ...current.cost, tokens: current.cost.tokens + workerResult.tokens },
      result: { ...current.result, summary: redactSecrets(String(workerResult.text ?? "")) },
    },
  });
  return transitionTask(agentHome, current, "done", "Plan-only task done.");
}

async function runEditTask({ agentHome, memoryStateHome, memoryContextImpl, task, runner, execFileImpl: execFileImplArg }) {
  // Repo allowlist: only run against the policy-configured default_repo.
  const policy = getTelegramCodexPolicy(agentHome);
  const allowedRepo = policy.default_repo ? path.resolve(policy.default_repo) : null;
  if (!allowedRepo || path.resolve(task.repo) !== allowedRepo) {
    return transitionTask(agentHome, task, "failed", "Edit task repo is not in the allowlist.");
  }

  let current = transitionTask(agentHome, task, "planning", "Edit task started.");
  const startedAt = new Date().toISOString();
  const execImpl = execFileImplArg || execFile;
  // executor=opus runs via a tool-restricted headless Claude (edit-capable
  // settings, same per-chat session). executor=codex keeps the injected/default
  // runner. An injected runner (tests) always wins for either executor.
  const effectiveRunner = runner ?? (task.executor === "opus"
    ? makeOpusEditRunner({ agentHome, execFileImpl: execImpl })
    : undefined);
  const headBefore = await captureGitHead(current.repo, execImpl);
  const diffBefore = await captureGitState(current.repo, execImpl);

  let contextBlock;
  let workerResult;
  try {
    contextBlock = await buildContextBlock({ agentHome, memoryStateHome, memoryContextImpl, repo: current.repo });
    workerResult = await runEditStep({ task: current, contextBlock, runner: effectiveRunner });
  } catch (error) {
    const diffStat = formatGitDelta(diffBefore, await captureGitState(current.repo, execImpl));
    if (diffStat && isNoReplyError(error)) {
      workerResult = {
        text: "Edit changed files, but Codex produced no final reply. Wrapper verification captured the resulting diff.",
        sessionPath: null,
        exit: 0,
        tokens: 0,
      };
    } else {
      appendRun(agentHome, {
        task_id: current.id,
        step: "editing",
        started_at: startedAt,
        ended_at: new Date().toISOString(),
        exit: 1,
        codex_session: null,
        tokens: 0,
        usd_estimate: 0,
        error: redactSecrets(String(error?.message ?? "Edit task threw an error.")),
      });
      return transitionTask(agentHome, current, "failed", "Edit task threw an error.", {
        patch: { attempts: current.attempts + 1 },
      });
    }
  }
  const tests = workerResult.exit === 0
    ? await runEditVerification({ repoDir: current.repo, execImpl })
    : null;
  // Capture git state after verification so owner sees the complete worktree,
  // including any side effects from the fixed verification command.
  const headAfter = await captureGitHead(current.repo, execImpl);
  const headChanged = Boolean(headBefore && headAfter && headBefore !== headAfter);
  const diffStat = formatGitDelta(diffBefore, await captureGitState(current.repo, execImpl));
  const endedAt = new Date().toISOString();

  appendRun(agentHome, {
    task_id: current.id,
    step: "editing",
    started_at: startedAt,
    ended_at: endedAt,
    exit: headChanged ? 1 : workerResult.exit,
    codex_session: workerResult.sessionPath,
    tokens: workerResult.tokens,
    usd_estimate: 0,
    error: headChanged
      ? "Edit task changed git HEAD; commits are not allowed."
      : (workerResult.exit === 0 ? null : redactSecrets(String(workerResult.text ?? ""))),
  });
  appendCost(agentHome, {
    task_id: current.id,
    step: "editing",
    tokens: workerResult.tokens,
    usd_estimate: 0,
  });

  if (headChanged || workerResult.exit !== 0) {
    return transitionTask(agentHome, current, "failed", "Edit task failed.", {
      codexSession: workerResult.sessionPath,
      patch: {
        attempts: current.attempts + 1,
        cost: { ...current.cost, tokens: current.cost.tokens + workerResult.tokens },
        result: { ...current.result, diff_stat: diffStat || null, tests },
      },
    });
  }

  current = transitionTask(agentHome, current, "reporting", "Edit task completed.", {
    codexSession: workerResult.sessionPath,
    patch: {
      cost: { ...current.cost, tokens: current.cost.tokens + workerResult.tokens },
      result: {
        ...current.result,
        summary: redactSecrets(String(workerResult.text ?? "")),
        diff_stat: diffStat || null,
        tests,
      },
    },
  });
  return transitionTask(agentHome, current, "done", "Edit task done.");
}

function isNoReplyError(error) {
  return /Codex produced no reply/i.test(String(error?.message ?? ""));
}

// Snapshot of the worktree relative to HEAD: tracked text-file line counts, the
// set of tracked binary files that differ, and the set of untracked files. Taken
// before and after the task so formatGitDelta can attribute only what the task
// changed and exclude a pre-existing dirty worktree.
function captureGitState(repoDir, execImpl = execFile) {
  return Promise.all([
    captureGitNumstat(repoDir, execImpl),
    captureUntracked(repoDir, execImpl),
  ]).then(([numstat, untracked]) => ({
    stats: numstat.stats,
    // Fingerprint binary and untracked files by content hash (not raw content),
    // so an edit to a file that was ALREADY dirty/untracked before the task is
    // detected by a changed hash rather than missed because the name is in both
    // snapshots.
    binary: fingerprintFiles(repoDir, numstat.binary),
    untracked: fingerprintFiles(repoDir, untracked),
  }));
}

// name -> sha256(content) | null. null means the file could not be read or sits
// outside the repo; callers fail closed and never claim such a file as changed.
function fingerprintFiles(repoDir, names) {
  const out = new Map();
  for (const name of names) {
    out.set(name, hashRepoFile(repoDir, name));
  }
  return out;
}

function hashRepoFile(repoDir, name) {
  try {
    const root = fs.realpathSync(path.resolve(repoDir));
    const resolved = path.resolve(root, name);
    // Cheap string gate first.
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      return null;
    }
    // A symlink final component must not be followed out of the repo: fail closed.
    if (fs.lstatSync(resolved).isSymbolicLink()) {
      return null;
    }
    // Resolve any symlinked intermediate directories and re-check containment, so
    // readFileSync cannot follow a link inside the repo to a file outside it.
    const real = fs.realpathSync(resolved);
    if (real !== root && !real.startsWith(root + path.sep)) {
      return null;
    }
    return sha256(fs.readFileSync(real));
  } catch {
    return null;
  }
}

function captureGitNumstat(repoDir, execImpl = execFile) {
  return new Promise((resolve) => {
    execImpl("git", ["diff", "HEAD", "--numstat"], { cwd: repoDir, timeout: 10000 }, (error, stdout) => {
      const raw = String(stdout || "").trim();
      if (!raw || scanSecrets(raw).length > 0) {
        resolve({ stats: new Map(), binary: new Set() });
        return;
      }
      const stats = new Map();
      const binary = new Set();
      for (const line of raw.split("\n")) {
        const [added, deleted, ...rest] = line.split("\t");
        const name = rest.join("\t");
        if (!name) continue;
        // numstat reports binary files as "-\t-": no line counts to subtract.
        if (added === "-" || deleted === "-") {
          binary.add(name);
        } else {
          stats.set(name, { added: Number(added) || 0, deleted: Number(deleted) || 0 });
        }
      }
      resolve({ stats, binary });
    });
  });
}

function captureUntracked(repoDir, execImpl = execFile) {
  return new Promise((resolve) => {
    execImpl("git", ["ls-files", "--others", "--exclude-standard"], { cwd: repoDir, timeout: 10000 }, (error, stdout) => {
      const raw = String(stdout || "").trim();
      if (!raw || scanSecrets(raw).length > 0) {
        resolve(new Set());
        return;
      }
      resolve(new Set(raw.split("\n").filter(Boolean)));
    });
  });
}

// Reports only what the task changed by subtracting the pre-task snapshot from
// the post-task one: tracked text deltas, plus binary files and untracked files
// that appeared during the task. Pre-existing dirty files (same in both
// snapshots) are excluded.
//
// Known limitation: tracked text deltas are the absolute difference of numstat
// counts, so an edit to a file that was ALREADY dirty before the task — and that
// nets the same added/deleted line counts, or that reverts a pre-existing hunk —
// can be under-reported or shown without direction. This only shapes the
// owner-facing summary; headChanged / approval gating is unaffected.
function formatGitDelta(before, after) {
  const lines = [];
  let files = 0;
  let insertions = 0;
  let deletions = 0;
  for (const name of new Set([...before.stats.keys(), ...after.stats.keys()])) {
    const current = after.stats.get(name) || { added: 0, deleted: 0 };
    const prior = before.stats.get(name) || { added: 0, deleted: 0 };
    const added = Math.abs(current.added - prior.added);
    const deleted = Math.abs(current.deleted - prior.deleted);
    if (added === 0 && deleted === 0) continue;
    files += 1;
    insertions += added;
    deletions += deleted;
    lines.push(` ${name} | ${added + deleted} ${"+".repeat(added)}${"-".repeat(deleted)}`);
  }
  for (const [name, hash] of after.binary) {
    if (changedFingerprint(before.binary, name, hash)) {
      files += 1;
      lines.push(` ${name} | Bin (changed)`);
    }
  }
  for (const [name, hash] of after.untracked) {
    if (!before.untracked.has(name)) {
      // New untracked file. Fail closed: only claim it if we could read it.
      if (hash === null) continue;
      files += 1;
      lines.push(` ${name} | new file`);
    } else if (changedFingerprint(before.untracked, name, hash)) {
      files += 1;
      lines.push(` ${name} | changed`);
    }
  }
  if (files === 0) return "";
  lines.push(` ${files} file${files === 1 ? "" : "s"} changed, ${insertions} insertion${insertions === 1 ? "" : "s"}(+), ${deletions} deletion${deletions === 1 ? "" : "s"}(-)`);
  return lines.join("\n");
}

// True only when the task demonstrably changed the file's content. A file that
// newly appeared in this snapshot counts as changed (if readable); an entry
// present in both is changed only when the hashes differ. Any null hash means we
// could not read/hash it, so we fail closed and do not claim a change.
function changedFingerprint(beforeMap, name, afterHash) {
  if (!beforeMap.has(name)) {
    return afterHash !== null;
  }
  const beforeHash = beforeMap.get(name);
  if (beforeHash === null || afterHash === null) {
    return false;
  }
  return beforeHash !== afterHash;
}

function captureGitHead(repoDir, execImpl = execFile) {
  return new Promise((resolve) => {
    execImpl("git", ["rev-parse", "HEAD"], { cwd: repoDir, timeout: 10000 }, (error, stdout) => {
      resolve(error ? "" : String(stdout || "").trim());
    });
  });
}

function runEditVerification({ repoDir, execImpl = execFile }) {
  const [file, ...args] = EDIT_VERIFY_COMMAND;
  const startedAt = new Date().toISOString();
  return new Promise((resolve) => {
    execImpl(file, args, {
      cwd: repoDir,
      timeout: 120000,
      maxBuffer: 1024 * 1024,
    }, (error, stdout, stderr) => {
      resolve({
        command: [file, ...args],
        exit: error ? (Number.isInteger(error.code) ? error.code : 1) : 0,
        passed: !error,
        stdout: safeOutput(stdout),
        stderr: safeOutput(stderr),
        started_at: startedAt,
        ended_at: new Date().toISOString(),
      });
    });
  });
}

function safeOutput(text, maxChars = 1200) {
  const raw = redactSecrets(String(text || "")).trim();
  if (!raw) {
    return "";
  }
  return raw.length > maxChars ? `${raw.slice(0, maxChars - 3)}...` : raw;
}

async function buildContextBlock({ agentHome, memoryStateHome, memoryContextImpl, repo }) {
  const policy = getTelegramCodexPolicy(agentHome);
  const buildContext = memoryContextImpl || buildMemoryContextBlock;
  return buildContext({
    enabled: Boolean(memoryStateHome || policy.memory_enabled),
    memoryStateHome,
    repo,
  });
}
