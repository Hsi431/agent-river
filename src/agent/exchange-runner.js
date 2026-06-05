import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { appendJsonl, readJsonl } from "codex-memory-river/src/jsonl.js";
import { agentPaths } from "./paths.js";
import { checkSafety, getPrimaryAgentId, getTelegramCodexPolicy } from "./safety.js";
import {
  claimExchangeMessage,
  listExchangeInbox,
  releaseExchangeClaim,
  replyExchangeMessage,
} from "./exchange.js";
import { createDispatchApproval, DISPATCH_CHANNEL, parseDispatchProposal } from "./dispatch.js";

// Opus-side exchange auto-runner (v1). Single-shot: pick at most one eligible
// message addressed to opus over Telegram from codex, claim it in Node, then
// spawn a tool-restricted headless Claude to review and reply. The runner never
// passes raw message text to the spawned process (only the message id), never
// creates a new exchange message, and never edits files. Spawn is injectable so
// tests do not launch a real Claude process.
//
// Safety envelope: `settingsPath` (the restricted Claude settings file) is the
// fail-closed boundary that enforces read-only/no-edit/exchange-only access for
// the spawned headless Claude. If that file is missing the runner refuses to
// claim or spawn (reason "missing_settings") rather than launch an unsandboxed
// Claude. `repoDir` is the working directory for the spawned Claude and must be
// the repo root (the systemd unit sets WorkingDirectory; otherwise pass --repo).

const RUNNER_AGENT = "opus";
const LOCK_TTL_BUFFER_SECONDS = 120;
const SPAWN_OUTCOMES = new Set(["replied", "failed_released", "blocked_terminal"]);

export function defaultRunnerSettingsPath() {
  return path.join(os.homedir(), ".config", "codex-agent", "opus-runner-settings.json");
}

// Edit-capable restricted settings for Opus execution (separate, broader-than-
// review envelope: can write repo files, still no commit/push/deploy/install).
export function defaultOpusEditSettingsPath() {
  return path.join(os.homedir(), ".config", "codex-agent", "opus-edit-settings.json");
}

// Builds a runEditTask-compatible runner that executes an edit task by spawning
// a tool-restricted headless Claude (edit-capable settings), resuming the same
// per-chat session so Opus keeps the conversation context while it edits.
// Returns `({ prompt, task }) => { text, sessionPath, exit, tokens }`.
// Fail-closed: throws if the edit settings file is missing (never spawns an
// unsandboxed Claude); runEditTask records that as a failed task.
export function makeOpusEditRunner({ agentHome, settingsPath = defaultOpusEditSettingsPath(), execFileImpl = execFile } = {}) {
  return async ({ prompt, task }) => {
    if (!fs.existsSync(settingsPath)) {
      throw new Error("Opus edit settings file is missing; refusing to spawn.");
    }
    const paths = agentPaths(agentHome);
    const policy = getTelegramCodexPolicy(agentHome);
    const chatId = task?.chat_id || null;
    const sessionId = chatId ? readRunnerSession(paths, chatId) : null;
    const model = policy.exchange_runner_model;
    const timeoutSeconds = Number(policy.exchange_runner_timeout_seconds) || 600;
    const repoDir = task.repo;

    // Note: never pass --no-session-persistence. Sessions must be persisted so a
    // later --resume can find them; storing an id from a non-persisted run is
    // exactly what made resume fail ("No conversation found").
    const baseArgs = [
      "-p",
      "--model", String(model),
      "--output-format", "json",
      "--add-dir", repoDir,
      "--settings", settingsPath,
    ];
    const buildArgs = (resumeId) => [
      ...baseArgs,
      ...(resumeId ? ["--resume", String(resumeId)] : []),
      prompt,
    ];

    let result = await spawnOpusEdit({ command: "claude", args: buildArgs(sessionId), cwd: repoDir, timeoutSeconds, execFileImpl });
    // Fail-safe continuity: a stale/expired/missing session must never block
    // execution. Drop the bad session and retry once with a fresh one.
    if (!result.ok && sessionId && isResumeFailure(result)) {
      if (chatId) clearRunnerSession(paths, chatId);
      result = await spawnOpusEdit({ command: "claude", args: buildArgs(null), cwd: repoDir, timeoutSeconds, execFileImpl });
    }
    if (chatId && result.sessionId) {
      writeRunnerSession(paths, chatId, result.sessionId);
    }
    // On failure, surface a diagnosable reason instead of an empty string so the
    // task's run record explains what went wrong (spawn error + stderr).
    const failureText = `Opus edit spawn failed: ${result.error || "no output"}${result.stderr ? ` | stderr: ${result.stderr}` : ""}`;
    return {
      text: result.ok ? result.text : failureText,
      sessionPath: null,
      exit: result.ok ? 0 : 1,
      tokens: result.tokens,
    };
  };
}

function isResumeFailure(result) {
  return /No conversation found|session ID|--resume/i.test(`${result.error || ""} ${result.stderr || ""}`);
}

function spawnOpusEdit({ command, args, cwd, timeoutSeconds, execFileImpl = execFile }) {
  return new Promise((resolve) => {
    const child = execFileImpl(command, args, {
      cwd,
      env: spawnEnvWithLocalBin(),
      timeout: Math.max(1, Number(timeoutSeconds) || 1) * 1000,
      maxBuffer: 8 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      const parsed = parseClaudeResult(stdout);
      resolve({
        ok: !error,
        text: parsed.text,
        sessionId: parsed.sessionId,
        tokens: parsed.tokens,
        error: error ? sanitizeError(error.message) : null,
        stderr: error ? sanitizeError(String(stderr || "")).slice(0, 300) : null,
      });
    });
    child?.stdin?.on?.("error", () => {});
    child?.stdin?.end?.();
  });
}

// Ensure the spawned `claude` is found regardless of the parent environment.
// Systemd user services (the bridge / timer) often run with a minimal PATH that
// excludes ~/.local/bin where the claude CLI is installed; without this an
// execFile would fail with ENOENT, produce empty stdout, and the runner would
// (misleadingly) report the task as Blocked.
function spawnEnvWithLocalBin() {
  const localBin = path.join(os.homedir(), ".local", "bin");
  const current = process.env.PATH || "";
  const PATH = current.split(":").includes(localBin) ? current : `${localBin}:${current}`;
  return { ...process.env, PATH };
}

function parseClaudeResult(stdout) {
  try {
    const data = JSON.parse(String(stdout || "").trim());
    const usage = data?.usage || {};
    const tokens = (Number(usage.input_tokens) || 0) + (Number(usage.output_tokens) || 0);
    return {
      text: typeof data?.result === "string" ? data.result : "",
      sessionId: typeof data?.session_id === "string" && data.session_id ? data.session_id : null,
      tokens,
    };
  } catch {
    return { text: "", sessionId: null, tokens: 0 };
  }
}

export async function runExchangeRunnerOnce({
  agentHome,
  repoDir = process.cwd(),
  settingsPath = defaultRunnerSettingsPath(),
  spawnImpl = defaultSpawnClaude,
  execFileImpl = execFile,
  now = Date.now(),
} = {}) {
  if (!agentHome) {
    throw new Error("Missing agentHome");
  }
  const paths = agentPaths(agentHome);
  if (!acquireRunnerLock(agentHome, lockTtlSeconds(agentHome), now)) {
    return summary({ ran: false, reason: "locked" });
  }

  try {
    const policy = getTelegramCodexPolicy(agentHome);
    if (!policy.exchange_runner_enabled) {
      return summary({ ran: false, reason: "disabled" });
    }

    // Reuse the Phase B seatbelts (kill switch / token budget).
    const guard = checkSafety(agentHome);
    if (!guard.ok) {
      return summary({ ran: false, reason: guard.reason });
    }

    const maxAttempts = Math.max(1, Number(policy.exchange_runner_max_attempts) || 1);
    const dailyMax = Math.max(0, Number(policy.exchange_runner_daily_max) || 0);
    if (dispatchCountForDay(paths, now) >= dailyMax) {
      return summary({ ran: false, reason: "daily_max" });
    }

    const message = pickEligibleMessage(agentHome);
    if (!message) {
      return summary({ ran: false, reason: "no_eligible_message" });
    }

    // Fail closed: the restricted Claude settings file is the safety envelope
    // (read-only repo, /tmp-only writes, exchange/git-read commands, no edits).
    // If it is missing we must NOT spawn an unsandboxed Claude — leave the
    // message open and unclaimed so a fixed config can process it later.
    if (!fs.existsSync(settingsPath)) {
      return summary({ ran: false, reason: "missing_settings", message_id: message.id, settings_path: settingsPath });
    }

    const priorAttempts = spawnAttemptsFor(paths, message.id);

    // Claim in Node before spawning — this is the lock/dedup primitive.
    try {
      claimExchangeMessage({
        agentHome,
        id: message.id,
        agent: RUNNER_AGENT,
        leaseSeconds: Number(policy.exchange_runner_timeout_seconds) + LOCK_TTL_BUFFER_SECONDS,
      });
    } catch (error) {
      recordDispatch(paths, { messageId: message.id, attempt: priorAttempts, outcome: "claim_failed", model: null, now });
      return summary({ ran: false, reason: "claim_failed", message_id: message.id, error: error.message });
    }

    const attempt = priorAttempts + 1;
    const model = policy.exchange_runner_model;
    const timeoutSeconds = Number(policy.exchange_runner_timeout_seconds);
    const chatId = message.chat_id || null;
    const sessionId = chatId ? readRunnerSession(paths, chatId) : null;
    const invocation = buildClaudeInvocation({ repoDir, agentHome, msgId: message.id, model, settingsPath, timeoutSeconds, sessionId });
    const logPath = path.join(paths.exchangeRunnerLogsDir, `${message.id}.attempt-${attempt}.log`);

    let spawnResult;
    try {
      spawnResult = await spawnImpl({ invocation, timeoutSeconds, execFileImpl, logPath });
    } catch (error) {
      spawnResult = { ok: false, timedOut: false, code: null, error: error.message };
    }

    // Persist the session_id returned by Claude so the next exchange message
    // from the same Telegram chat resumes the same conversation context.
    if (chatId && spawnResult.sessionId) {
      writeRunnerSession(paths, chatId, spawnResult.sessionId, now);
    }

    // Node owns mailbox writes for the review lane. The spawned Claude returns
    // final text only; it does not need Write permission or exchange-reply.
    let reply = replyFor(paths, message.id);
    if (!reply && spawnResult.ok && String(spawnResult.text || "").trim()) {
      try {
        reply = replyExchangeMessage({
          agentHome,
          id: message.id,
          agent: RUNNER_AGENT,
          text: spawnResult.text,
        }).reply;
      } catch (error) {
        spawnResult = { ...spawnResult, replyError: sanitizeError(error.message) };
      }
    }
    if (reply) {
      const parsed = parseDispatchProposal(reply.text);
      const proposed = parsed.valid
        ? createDispatchApproval({
          agentHome,
          proposedBy: RUNNER_AGENT,
          proposal: parsed.proposal,
          parentMsgId: message.id,
          parentDispatch: message.dispatch || null,
          chatId,
          now,
        })
        : null;
      recordDispatch(paths, { messageId: message.id, attempt, outcome: "replied", model, now });
      return summary({
        ran: true,
        reason: "replied",
        message_id: message.id,
        attempt,
        spawn: spawnResult,
        reply_error: spawnResult.replyError || null,
        dispatch_approval_id: proposed?.approval?.id || null,
        dispatch_blocked_reason: proposed?.blocked ? proposed.reason : null,
      });
    }

    if (attempt < maxAttempts) {
      safeRelease(agentHome, message.id);
      recordDispatch(paths, { messageId: message.id, attempt, outcome: "failed_released", model, now });
      return summary({
        ran: true,
        reason: "failed_released",
        message_id: message.id,
        attempt,
        spawn: spawnResult,
        reply_error: spawnResult.replyError || null,
      });
    }

    // Final attempt failed: write a terminal blocked reply (we still hold the
    // claim) so the message stops re-dispatching, then it is completed.
    const blocked = `Blocked: opus auto-runner could not complete this request after ${maxAttempts} attempt(s). Please review ${message.id} manually with the local exchange skill.`;
    let blockedOk = true;
    try {
      replyExchangeMessage({ agentHome, id: message.id, agent: RUNNER_AGENT, text: blocked });
    } catch {
      blockedOk = false;
      safeRelease(agentHome, message.id);
    }
    recordDispatch(paths, { messageId: message.id, attempt, outcome: "blocked_terminal", model, now });
    return summary({
      ran: true,
      reason: blockedOk ? "blocked_terminal" : "blocked_reply_failed",
      message_id: message.id,
      attempt,
      spawn: spawnResult,
      reply_error: spawnResult.replyError || null,
    });
  } finally {
    releaseRunnerLock(agentHome);
  }
}

// Pure construction of the headless Claude invocation. Only the message id and
// fixed boilerplate go into argv — never the raw message text.
export function buildClaudeInvocation({ repoDir, agentHome, msgId, model, settingsPath, maxTurns = 40, sessionId = null }) {
  const prompt = [
    `You are the "opus" exchange agent for Codex Memory River.`,
    `Exchange message ${msgId} is ALREADY claimed. Do NOT claim, release, reply, or create new exchange messages.`,
    `Step 1 — read the thread:`,
    `  node bin/codex-agent.js exchange-thread --state ${agentHome} --id ${msgId}`,
    `Step 2 — for continuity, inspect same-chat exchange metadata, then read any relevant prior threads:`,
    `  node bin/codex-agent.js exchange-runner-session-status --state ${agentHome}`,
    `Step 3 — process the task using read-only tools (Read, Grep, Glob, git diff/log/show, npm test). Do not edit repo files.`,
    `Step 4 — return only your final reply text as the Claude result. Node will record it in the mailbox.`,
    `Reply contract:`,
    `  • Code review: list findings by severity (file:line). Say "No findings." when clean. Include residual risks and missing tests.`,
    `  • Question: concise direct answer.`,
    `  • Task requiring file edits or external actions: describe exactly what you would do and ask the owner to authorize via the Telegram @opus interface. NEVER edit files yourself.`,
    `Never include raw secrets; redact as [redacted].`,
    `If you cannot complete it, return "Blocked: <reason>" as your final reply text.`,
  ].join("\n");

  const args = [
    "-p",
    "--model", String(model),
    "--output-format", "json",
    "--max-turns", String(maxTurns),
    "--add-dir", repoDir,
    "--settings", settingsPath,
  ];
  // Persist sessions (no --no-session-persistence) so a later --resume can
  // actually find them; storing an id from a non-persisted run is what broke
  // resume with "No conversation found".
  if (sessionId) {
    args.push("--resume", String(sessionId));
  }
  args.push(prompt);
  return { command: "claude", args, cwd: repoDir, prompt, session_id_used: sessionId };
}

function defaultSpawnClaude({ invocation, timeoutSeconds, execFileImpl = execFile, logPath }) {
  return new Promise((resolve) => {
    const child = execFileImpl(invocation.command, invocation.args, {
      cwd: invocation.cwd,
      env: spawnEnvWithLocalBin(),
      timeout: Math.max(1, Number(timeoutSeconds) || 1) * 1000,
      maxBuffer: 8 * 1024 * 1024,
    }, (error, stdout) => {
      if (logPath) {
        try {
          fs.mkdirSync(path.dirname(logPath), { recursive: true });
          fs.writeFileSync(logPath, String(stdout || ""));
        } catch {
          // best-effort logging
        }
      }
      const parsed = parseClaudeResult(stdout);
      resolve({
        ok: !error,
        timedOut: Boolean(error && (error.killed || error.signal === "SIGTERM" || error.code === "ETIMEDOUT")),
        code: error?.code ?? 0,
        error: error ? sanitizeError(error.message) : null,
        text: parsed.text,
        sessionId: parsed.sessionId,
        tokens: parsed.tokens,
      });
    });
    // No stdin input: the prompt is an argv positional (id-only, no secret).
    child?.stdin?.on?.("error", () => {});
    child?.stdin?.end?.();
  });
}

export function pickEligibleMessage(agentHome) {
  const expectedFrom = getPrimaryAgentId(agentHome);
  const eligible = listExchangeInbox(agentHome, { agent: RUNNER_AGENT })
    .filter((message) => message.to === RUNNER_AGENT
      && (message.channel === "telegram" || message.channel === DISPATCH_CHANNEL)
      && message.from === expectedFrom
      && isAvailableClaim(message.claim))
    .sort((a, b) => String(a.created_at || "").localeCompare(String(b.created_at || "")));
  return eligible[0] || null;
}

function isAvailableClaim(claim) {
  return !claim || claim.status === "released" || claim.status === "expired";
}

function replyFor(paths, messageId) {
  return readJsonl(paths.exchangeReplies).find((reply) => reply.message_id === messageId) || null;
}

function spawnAttemptsFor(paths, messageId) {
  return readJsonl(paths.exchangeRunnerDispatch)
    .filter((row) => row.message_id === messageId && SPAWN_OUTCOMES.has(row.outcome))
    .length;
}

function dispatchCountForDay(paths, now) {
  const day = new Date(now).toISOString().slice(0, 10);
  return readJsonl(paths.exchangeRunnerDispatch)
    .filter((row) => SPAWN_OUTCOMES.has(row.outcome) && String(row.created_at || "").slice(0, 10) === day)
    .length;
}

function recordDispatch(paths, { messageId, attempt, outcome, model, now }) {
  appendJsonl(paths.exchangeRunnerDispatch, {
    message_id: messageId,
    attempt,
    outcome,
    model: model || null,
    created_at: new Date(now).toISOString(),
  });
}

function safeRelease(agentHome, messageId) {
  try {
    releaseExchangeClaim({ agentHome, id: messageId, agent: RUNNER_AGENT });
  } catch {
    // The claim has a lease and will expire even if release fails.
  }
}

function sanitizeError(message) {
  return String(message || "").replace(/\s+/g, " ").trim().slice(0, 300);
}

function lockTtlSeconds(agentHome) {
  const policy = getTelegramCodexPolicy(agentHome);
  return Number(policy.exchange_runner_timeout_seconds) + LOCK_TTL_BUFFER_SECONDS;
}

function acquireRunnerLock(agentHome, ttlSeconds, now) {
  const file = agentPaths(agentHome).exchangeRunnerLock;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const payload = `${JSON.stringify({ acquired_at: new Date(now).toISOString(), pid: process.pid })}\n`;
  try {
    fs.writeFileSync(file, payload, { flag: "wx" });
    return true;
  } catch (error) {
    if (error.code !== "EEXIST") {
      throw error;
    }
  }
  if (isLockFresh(file, ttlSeconds, now)) {
    return false;
  }
  try {
    fs.unlinkSync(file);
  } catch {
    // someone else may have removed it
  }
  try {
    fs.writeFileSync(file, payload, { flag: "wx" });
    return true;
  } catch {
    return false;
  }
}

function isLockFresh(file, ttlSeconds, now) {
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    const ts = Date.parse(data.acquired_at || "");
    return Number.isFinite(ts) && now - ts < Math.max(0, Number(ttlSeconds) || 0) * 1000;
  } catch {
    return false;
  }
}

function releaseRunnerLock(agentHome) {
  const file = agentPaths(agentHome).exchangeRunnerLock;
  if (fs.existsSync(file)) {
    try {
      fs.unlinkSync(file);
    } catch {
      // best-effort
    }
  }
}

// Session store: maps chat_id → { session_id, updated_at } in a single JSON
// file. Per-chat session gives Opus the same conversational continuity as
// Codex: all @opus exchanges in a Telegram chat resume the same Claude session.
// Errors are ignored — a missing/corrupt store just falls back to a fresh session.
export function readRunnerSession(paths, chatId) {
  try {
    const store = JSON.parse(fs.readFileSync(paths.exchangeRunnerSessions, "utf8"));
    return store?.[chatId]?.session_id || null;
  } catch {
    return null;
  }
}

export function writeRunnerSession(paths, chatId, sessionId, now = Date.now()) {
  let store = {};
  try {
    store = JSON.parse(fs.readFileSync(paths.exchangeRunnerSessions, "utf8"));
  } catch {
    // start fresh
  }
  store[chatId] = { session_id: sessionId, updated_at: new Date(now).toISOString() };
  try {
    fs.mkdirSync(path.dirname(paths.exchangeRunnerSessions), { recursive: true });
    fs.writeFileSync(paths.exchangeRunnerSessions, JSON.stringify(store, null, 2) + "\n");
  } catch {
    // best-effort
  }
}

export function clearRunnerSession(paths, chatId) {
  try {
    const store = JSON.parse(fs.readFileSync(paths.exchangeRunnerSessions, "utf8"));
    delete store[chatId];
    fs.writeFileSync(paths.exchangeRunnerSessions, JSON.stringify(store, null, 2) + "\n");
  } catch {
    // best-effort
  }
}

export function runnerSessionStatus(agentHome, { chatId } = {}) {
  const paths = agentPaths(agentHome);
  const sessions = readRunnerSessionStore(paths);
  const messages = readJsonl(paths.exchangeMessages);
  const replies = readJsonl(paths.exchangeReplies);
  const repliesByMessage = new Map(replies.map((reply) => [reply.message_id, reply]));
  return Object.entries(sessions)
    .filter(([id]) => !chatId || id === String(chatId))
    .sort((a, b) => String(b[1]?.updated_at || "").localeCompare(String(a[1]?.updated_at || "")))
    .map(([id, session]) => {
      const chatMessages = messages
        .filter((message) => String(message.chat_id || "") === id)
        .sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
      const recent = chatMessages.slice(0, 5).map((message) => {
        const reply = repliesByMessage.get(message.id) || null;
        return {
          message_id: message.id,
          created_at: message.created_at || null,
          thread_id: message.thread_id || null,
          request_hash: message.text_hash || null,
          reply_id: reply?.id || null,
          reply_hash: reply?.text_hash || null,
          reply_at: reply?.created_at || null,
        };
      });
      return {
        chat_id: id,
        session_id: session?.session_id || null,
        updated_at: session?.updated_at || null,
        recent_messages: recent,
      };
    });
}

function readRunnerSessionStore(paths) {
  try {
    const store = JSON.parse(fs.readFileSync(paths.exchangeRunnerSessions, "utf8"));
    return store && typeof store === "object" ? store : {};
  } catch {
    return {};
  }
}

function summary(extra) {
  return { agent: RUNNER_AGENT, ...extra };
}
