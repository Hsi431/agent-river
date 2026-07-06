import fs from "node:fs";
import os from "node:os";
import { spawn } from "node:child_process";
import { appendJsonl, readJsonl } from "../lib/jsonl.js";
import { redactSecrets } from "../lib/secret-scan.js";
import { agentPaths } from "./paths.js";
import { checkSafety, getTelegramCodexPolicy } from "./safety.js";
import {
  claimExchangeMessage,
  listExchangeInbox,
  releaseExchangeClaim,
  relaySessionReply,
  replyExchangeMessage,
} from "./exchange.js";
import { createDispatchApproval, DISPATCH_CHANNEL, dispatchTargetAllowlist, parseDispatchProposal } from "./dispatch.js";
import { getSession, isSessionExchangeEligible } from "./sessions.js";
import { listRegisteredAgents } from "./registry.js";
import { terminateGroup } from "./v2/kill.js";
import { resolveMessageRepoBinding } from "./runner-repo.js";

const MAX_STDOUT_BYTES = 64 * 1024;
const MAX_STDERR_BYTES = 4096;
const LOCK_TTL_BUFFER_SECONDS = 120;
const MAX_ATTEMPTS = 2;
const FAILURE_OUTCOMES = new Set(["failed_released", "timed_out_released"]);

export async function runExecRunnerOnce({
  agentHome,
  repoDir = process.cwd(),
  spawnImpl = spawn,
  now = Date.now(),
} = {}) {
  if (!agentHome) {
    throw new Error("Missing agentHome");
  }
  const agents = activeExecAgents(agentHome);
  const paths = agentPaths(agentHome);
  if (!acquireExecRunnerLock(agentHome, execLockTtlSeconds(agents), now)) {
    return { ran: false, reason: "locked", results: [] };
  }

  try {
    const guard = checkSafety(agentHome);
    if (!guard.ok) {
      return { ran: false, reason: guard.reason, results: [] };
    }
    if (agents.length === 0) {
      return { ran: false, reason: "no_exec_agents", results: [] };
    }

    const results = [];
    for (const agent of agents) {
      results.push(await runOneExecAgent({ agentHome, paths, agent, repoDir, spawnImpl, now }));
    }
    return {
      ran: results.some((result) => result.ran),
      reason: results.some((result) => result.ran) ? "ran" : "no_eligible_message",
      results,
    };
  } finally {
    releaseExecRunnerLock(agentHome);
  }
}

export function pickEligibleExecMessage(agentHome, agentName, { now = Date.now() } = {}) {
  const allowedSenders = dispatchTargetAllowlist(agentHome);
  const paths = agentPaths(agentHome);
  const eligible = listExchangeInbox(agentHome, { agent: agentName })
    .filter((message) => message.to === agentName
      && failureAttemptsFor(paths, agentName, message.id) < MAX_ATTEMPTS
      && (message.session_id
        ? isSessionExchangeEligible(agentHome, message, agentName, { now }).eligible
        : (allowedSenders.has(String(message.from))
          && (message.channel === "telegram" || message.channel === DISPATCH_CHANNEL)))
      && isAvailableClaim(message.claim))
    .sort((a, b) => String(a.created_at || "").localeCompare(String(b.created_at || "")));
  return eligible[0] || null;
}

export function buildExecEnvelope({ agentHome, message, repoPromptLine = null }) {
  const session = message.session_id ? getSession(agentHome, message.session_id) : null;
  return `${JSON.stringify({
    agent_river_contract: "exec-v1",
    message_id: message.id,
    sender: String(message.from || ""),
    session_id: message.session_id || null,
    session_topic: session?.topic || null,
    repo_status: repoPromptLine || (message.repo
      ? `本 session 綁定 repo:${message.repo}`
      : "本對話未綁定任何 repo;不要假設題目與你目前所在的 codebase 相關,依題目本身回答"),
    text: String(message.text || ""),
  })}\n`;
}

export function runExecCommand({
  command,
  cwd,
  stdinText,
  timeoutSeconds,
  spawnImpl = spawn,
} = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl("sh", ["-c", String(command || "")], {
        cwd,
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
        env: execChildEnv(),
      });
    } catch (error) {
      resolve({ ok: false, timedOut: false, code: null, stdout: "", stderr: "", error: sanitizeError(error.message) });
      return;
    }

    let settled = false;
    let timedOut = false;
    const stdout = cappedCollector(MAX_STDOUT_BYTES);
    const stderr = cappedCollector(MAX_STDERR_BYTES);
    const timeoutMs = Math.max(1, Number(timeoutSeconds) || 1) * 1000;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      timedOut = true;
      const pid = child?.pid;
      Promise.resolve(pid ? terminateGroup(pid) : null).finally(() => {
        settle({
          ok: false,
          timedOut: true,
          code: null,
          stdout: stdout.text(),
          stderr: stderr.text(),
          error: "exec command timed out",
        });
      });
    }, timeoutMs);

    const settle = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    child.stdout?.on?.("data", (chunk) => stdout.push(chunk));
    child.stderr?.on?.("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => {
      settle({ ok: false, timedOut, code: null, stdout: stdout.text(), stderr: stderr.text(), error: sanitizeError(error.message) });
    });
    child.on("close", (code, signal) => {
      if (timedOut) {
        return;
      }
      settle({
        ok: code === 0,
        timedOut: false,
        code,
        signal: signal || null,
        stdout: stdout.text(),
        stderr: stderr.text(),
        error: code === 0 ? null : sanitizeError(stderr.text() || `exit ${code}`),
      });
    });
    child.stdin?.on?.("error", () => {});
    child.stdin?.end?.(String(stdinText || ""));
  });
}

async function runOneExecAgent({ agentHome, paths, agent, repoDir, spawnImpl, now }) {
  const skippedSession = recordFirstSkippedExecSessionMessage(agentHome, paths, agent.name, now);
  const message = pickEligibleExecMessage(agentHome, agent.name, { now });
  if (!message) {
    return summary(agent.name, skippedSession || { ran: false, reason: "no_eligible_message" });
  }

  const priorAttempts = failureAttemptsFor(paths, agent.name, message.id);
  try {
    claimExchangeMessage({
      agentHome,
      id: message.id,
      agent: agent.name,
      leaseSeconds: Number(agent.exec_timeout_seconds) + LOCK_TTL_BUFFER_SECONDS,
    });
  } catch (error) {
    const sanitized = sanitizeError(error.message);
    recordExecDispatch(paths, { agent: agent.name, messageId: message.id, attempt: priorAttempts, outcome: "claim_failed", now, error: sanitized });
    return summary(agent.name, { ran: false, reason: "claim_failed", message_id: message.id, error: sanitized });
  }

  const attempt = priorAttempts + 1;
  const repoBinding = resolveMessageRepoBinding({ message, repoDir, workspaceRoot: getTelegramCodexPolicy(agentHome).workspace_root });
  const run = await runExecCommand({
    command: agent.exec_command,
    cwd: resolveExecCwd({ agent, repoBinding }),
    stdinText: buildExecEnvelope({ agentHome, message, repoPromptLine: repoBinding.promptLine }),
    timeoutSeconds: agent.exec_timeout_seconds,
    spawnImpl,
  });
  const replyText = run.ok && String(run.stdout || "").trim()
    ? redactSecrets(String(run.stdout || ""))
    : "";

  let reply = replyFor(paths, message.id);
  if (!reply && replyText.trim()) {
    try {
      reply = replyExchangeMessage({
        agentHome,
        id: message.id,
        agent: agent.name,
        text: replyText,
      }).reply;
    } catch (error) {
      run.replyError = sanitizeError(error.message);
    }
  }

  if (reply) {
    const relay = reply.session_id
      ? relaySessionReply({ agentHome, message, reply })
      : null;
    const parsed = parseDispatchProposal(reply.text);
    const proposed = parsed.valid
      ? createDispatchApproval({
        agentHome,
        proposedBy: agent.name,
        proposal: parsed.proposal,
        parentMsgId: message.id,
        parentDispatch: message.dispatch || null,
        chatId: message.chat_id || null,
        now,
      })
      : null;
    recordExecDispatch(paths, { agent: agent.name, messageId: message.id, attempt, outcome: "replied", now, repoFallback: repoBinding.repoFallback });
    return summary(agent.name, {
      ran: true,
      reason: "replied",
      message_id: message.id,
      attempt,
      exec: serializeRun(run),
      reply_error: run.replyError || null,
      relay_message_id: relay?.message?.id || null,
      relay_skipped: relay && !relay.relayed ? relay.reason : null,
      dispatch_approval_id: proposed?.approval?.id || null,
      dispatch_blocked_reason: proposed?.blocked ? proposed.reason : null,
    });
  }

  safeRelease(agentHome, message.id, agent.name);
  const outcome = run.timedOut ? "timed_out_released" : "failed_released";
  recordExecDispatch(paths, { agent: agent.name, messageId: message.id, attempt, outcome, now, error: runError(run), repoFallback: repoBinding.repoFallback });
  return summary(agent.name, {
    ran: true,
    reason: outcome,
    message_id: message.id,
    attempt,
    exec: serializeRun(run),
    reply_error: run.replyError || null,
  });
}

function activeExecAgents(agentHome) {
  return listRegisteredAgents(agentHome)
    .filter((agent) => agent.status === "active" && agent.style === "exec")
    .sort((a, b) => a.name.localeCompare(b.name));
}

function recordFirstSkippedExecSessionMessage(agentHome, paths, agentName, now) {
  const skipped = listExchangeInbox(agentHome, { agent: agentName })
    .filter((message) => message.to === agentName && message.session_id && isAvailableClaim(message.claim))
    .map((message) => ({ message, gate: isSessionExchangeEligible(agentHome, message, agentName, { now }) }))
    .filter(({ gate }) => !gate.eligible)
    .sort((a, b) => String(a.message.created_at || "").localeCompare(String(b.message.created_at || "")))[0];
  if (!skipped) {
    return null;
  }
  const reason = skipped.gate.reason || "session_not_eligible";
  const alreadyRecorded = readJsonl(paths.execRunnerDispatch)
    .some((row) => row.agent === agentName && row.message_id === skipped.message.id && String(row.outcome || "").startsWith("session_skip:"));
  if (alreadyRecorded) {
    return null;
  }
  recordExecDispatch(paths, { agent: agentName, messageId: skipped.message.id, attempt: 0, outcome: `session_skip:${reason}`, now });
  return { ran: false, reason, message_id: skipped.message.id };
}

function resolveExecCwd({ agent, repoBinding }) {
  if (agent.exec_cwd) {
    return agent.exec_cwd;
  }
  if (repoBinding?.cwd) {
    return repoBinding.cwd;
  }
  return os.homedir();
}

function replyFor(paths, messageId) {
  return readJsonl(paths.exchangeReplies).find((reply) => reply.message_id === messageId) || null;
}

function failureAttemptsFor(paths, agentName, messageId) {
  return readJsonl(paths.execRunnerDispatch)
    .filter((row) => row.agent === agentName && row.message_id === messageId && FAILURE_OUTCOMES.has(row.outcome))
    .length;
}

function recordExecDispatch(paths, { agent, messageId, attempt, outcome, now, error = null, repoFallback = null }) {
  appendJsonl(paths.execRunnerDispatch, {
    agent,
    message_id: messageId,
    attempt,
    outcome,
    ...(error ? { error: sanitizeError(error) } : {}),
    ...(repoFallback ? { repo_fallback: repoFallback } : {}),
    created_at: new Date(now).toISOString(),
  });
}

function safeRelease(agentHome, messageId, agentName) {
  try {
    releaseExchangeClaim({ agentHome, id: messageId, agent: agentName });
  } catch {
    // The claim has a lease and will expire even if release fails.
  }
}

function isAvailableClaim(claim) {
  return !claim || claim.status === "released" || claim.status === "expired";
}

function cappedCollector(limit) {
  const chunks = [];
  let size = 0;
  return {
    push(chunk) {
      if (size >= limit) {
        return;
      }
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      const remaining = limit - size;
      const next = buffer.length > remaining ? buffer.subarray(0, remaining) : buffer;
      chunks.push(next);
      size += next.length;
    },
    text() {
      return Buffer.concat(chunks, size).toString("utf8");
    },
  };
}

function execLockTtlSeconds(agents) {
  const longest = agents.reduce((max, agent) => Math.max(max, Number(agent.exec_timeout_seconds) || 0), 300);
  return longest + LOCK_TTL_BUFFER_SECONDS;
}

function acquireExecRunnerLock(agentHome, ttlSeconds, now) {
  const file = agentPaths(agentHome).execRunnerLock;
  fs.mkdirSync(agentHome, { recursive: true });
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

function releaseExecRunnerLock(agentHome) {
  const file = agentPaths(agentHome).execRunnerLock;
  if (fs.existsSync(file)) {
    try {
      fs.unlinkSync(file);
    } catch {
      // best-effort
    }
  }
}

function serializeRun(run) {
  return {
    ok: Boolean(run.ok),
    timed_out: Boolean(run.timedOut),
    code: run.code ?? null,
    error: run.error || null,
    stderr: run.stderr ? sanitizeError(run.stderr) : null,
  };
}

// Third-party exec commands get a minimal env allowlist — never the bot token,
// agent-river token, or provider API keys the parent may hold. A compromised or
// hostile registered command therefore has no host secrets to exfiltrate even
// though it runs a shell.
function execChildEnv() {
  const env = { AGENT_RIVER_MESSAGE: "1" };
  for (const key of ["PATH", "HOME", "LANG", "TZ", "USER"]) {
    if (process.env[key] !== undefined) {
      env[key] = process.env[key];
    }
  }
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("LC_") && value !== undefined) {
      env[key] = value;
    }
  }
  return env;
}

function sanitizeError(message) {
  return String(message || "").replace(/\s+/g, " ").trim().slice(0, 300);
}

function runError(run) {
  return sanitizeError(run?.replyError || run?.error || run?.stderr || "runner produced no reply");
}

function summary(agent, extra) {
  return { agent, ...extra };
}
