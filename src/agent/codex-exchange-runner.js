import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { appendJsonl, readJsonl } from "../lib/jsonl.js";
import { redactSecrets } from "../lib/secret-scan.js";
import { agentPaths } from "./paths.js";
import { checkSafety, isExchangeAgentEnabled, getTelegramCodexPolicy } from "./safety.js";
import {
  claimExchangeMessage,
  listExchangeInbox,
  releaseExchangeClaim,
  replyExchangeMessage,
} from "./exchange.js";
import { DISPATCH_CHANNEL, dispatchTargetAllowlist } from "./dispatch.js";
import { realCodexRunner } from "./codex-runner.js";

// Codex-side exchange auto-runner (v1). Single-shot: pick at most one eligible
// message addressed to codex, claim it in Node, invoke codex exec via
// codex-runner.js (read-only sandbox), then write the reply back to the mailbox.
//
// Mirrors exchange-runner.js in structure, lock, dispatch log, attempt tracking,
// daily cap, and blocked-reply behavior. Inject codexRunnerImpl to avoid
// spawning a real codex process in tests.

const RUNNER_AGENT = "codex";
const LOCK_TTL_BUFFER_SECONDS = 120;
const SPAWN_OUTCOMES = new Set(["replied", "failed_released", "blocked_terminal"]);

export async function runCodexExchangeRunnerOnce({
  agentHome,
  repoDir = process.cwd(),
  codexRunnerImpl = defaultCodexRunner,
  now = Date.now(),
} = {}) {
  if (!agentHome) {
    throw new Error("Missing agentHome");
  }
  const paths = agentPaths(agentHome);
  if (!acquireCodexRunnerLock(agentHome, codexLockTtlSeconds(agentHome), now)) {
    return summary({ ran: false, reason: "locked" });
  }

  try {
    const policy = getTelegramCodexPolicy(agentHome);
    if (!policy.exchange_runner_enabled) {
      return summary({ ran: false, reason: "disabled" });
    }

    const guard = checkSafety(agentHome);
    if (!guard.ok) {
      return summary({ ran: false, reason: guard.reason });
    }

    const maxAttempts = Math.max(1, Number(policy.exchange_runner_max_attempts) || 1);
    const dailyMax = Math.max(0, Number(policy.exchange_runner_daily_max) || 0);
    if (codexDispatchCountForDay(paths, now) >= dailyMax) {
      return summary({ ran: false, reason: "daily_max" });
    }

    const message = pickEligibleCodexMessage(agentHome);
    if (!message) {
      return summary({ ran: false, reason: "no_eligible_message" });
    }

    const priorAttempts = codexSpawnAttemptsFor(paths, message.id);

    try {
      claimExchangeMessage({
        agentHome,
        id: message.id,
        agent: RUNNER_AGENT,
        leaseSeconds: codexLockTtlSeconds(agentHome),
      });
    } catch (error) {
      recordCodexDispatch(paths, { messageId: message.id, attempt: priorAttempts, outcome: "claim_failed", model: null, now });
      return summary({ ran: false, reason: "claim_failed", message_id: message.id, error: error.message });
    }

    const attempt = priorAttempts + 1;
    const model = policy.codex_runner_model || null;
    const timeoutSeconds = Number(policy.exchange_runner_timeout_seconds) || 600;
    const effectiveRepoDir = resolveRepo(message, policy, repoDir);
    const prompt = buildCodexPrompt({ agentHome, msgId: message.id, repoDir: effectiveRepoDir });
    const logPath = path.join(paths.codexExchangeRunnerLogsDir, `${message.id}.attempt-${attempt}.log`);

    let runResult;
    try {
      runResult = await codexRunnerImpl({ prompt, cwd: effectiveRepoDir, agentHome, timeoutSeconds, logPath, execFileImpl: execFile });
    } catch (error) {
      runResult = { ok: false, text: "", error: sanitizeError(error.message) };
    }

    // Redact any secrets from the reply before writing to the mailbox.
    const replyText = runResult.ok && runResult.text
      ? redactSecrets(String(runResult.text))
      : "";

    let reply = codexReplyFor(paths, message.id);
    if (!reply && replyText.trim()) {
      try {
        reply = replyExchangeMessage({
          agentHome,
          id: message.id,
          agent: RUNNER_AGENT,
          text: replyText,
        }).reply;
      } catch (error) {
        runResult = { ...runResult, replyError: sanitizeError(error.message) };
      }
    }

    if (reply) {
      recordCodexDispatch(paths, { messageId: message.id, attempt, outcome: "replied", model, now });
      return summary({
        ran: true,
        reason: "replied",
        message_id: message.id,
        attempt,
        run: serializeRunResult(runResult),
        reply_error: runResult.replyError || null,
      });
    }

    if (attempt < maxAttempts) {
      safeCodexRelease(agentHome, message.id);
      recordCodexDispatch(paths, { messageId: message.id, attempt, outcome: "failed_released", model, now });
      return summary({
        ran: true,
        reason: "failed_released",
        message_id: message.id,
        attempt,
        run: serializeRunResult(runResult),
        reply_error: runResult.replyError || null,
      });
    }

    // Final attempt failed: write a terminal blocked reply.
    const blocked = `Blocked: codex auto-runner could not complete this request after ${maxAttempts} attempt(s). Please review ${message.id} manually with the local exchange skill.`;
    let blockedOk = true;
    try {
      replyExchangeMessage({ agentHome, id: message.id, agent: RUNNER_AGENT, text: blocked });
    } catch {
      blockedOk = false;
      safeCodexRelease(agentHome, message.id);
    }
    recordCodexDispatch(paths, { messageId: message.id, attempt, outcome: "blocked_terminal", model, now });
    return summary({
      ran: true,
      reason: blockedOk ? "blocked_terminal" : "blocked_reply_failed",
      message_id: message.id,
      attempt,
      run: serializeRunResult(runResult),
      reply_error: runResult.replyError || null,
    });
  } finally {
    releaseCodexRunnerLock(agentHome);
  }
}

// Default codex invocation: delegates to the shared codex-runner.js (the ONLY
// module allowed to call `codex exec`). Logs stdout to logPath best-effort.
async function defaultCodexRunner({ prompt, cwd, agentHome, timeoutSeconds, logPath, execFileImpl } = {}) {
  try {
    const timeoutMs = Number.isFinite(Number(timeoutSeconds)) && Number(timeoutSeconds) > 0
      ? Number(timeoutSeconds) * 1000
      : undefined;
    const result = await realCodexRunner({ prompt, execFileImpl, cwd, agentHome, timeoutMs });
    if (logPath) {
      try {
        fs.mkdirSync(path.dirname(logPath), { recursive: true });
        fs.writeFileSync(logPath, String(result.text || ""));
      } catch {
        // best-effort
      }
    }
    return { ok: true, text: result.text, tokens: result.tokens };
  } catch (error) {
    return { ok: false, text: "", error: sanitizeError(error.message) };
  }
}

// Build the review/Q&A prompt for codex. Only the message id and fixed
// boilerplate go into the prompt — never raw message text. Codex reads the
// message via the exchange-thread command.
export function buildCodexPrompt({ agentHome, msgId, repoDir }) {
  return [
    `You are the Codex agent for Agent River.`,
    `Exchange message ${msgId} is ALREADY claimed. Do NOT claim, release, reply, or create new exchange messages.`,
    `Step 1 — read the thread:`,
    `  node bin/codex-agent.js exchange-thread --state ${agentHome} --id ${msgId}`,
    `Step 2 — process the task using read-only tools. Do not edit repo files.`,
    `  Use: Read, Grep, Glob, git diff/log/show, npm test`,
    `Step 3 — return only your final reply text as the result. Node will record it in the mailbox.`,
    `Reply contract:`,
    `  • Language: reply in the owner's language. If the owner writes Chinese, use Traditional Chinese.`,
    `  • Code review: list findings by severity (file:line). Say "No findings." when clean. Include residual risks and missing tests.`,
    `  • Question: concise direct answer.`,
    `  • Capability boundary: this lane is read-only. Do not edit files from this lane.`,
    `Never include raw secrets; redact as [redacted].`,
    `If you cannot complete it, return "Blocked: <reason>" as your final reply text.`,
  ].join("\n");
}

export function pickEligibleCodexMessage(agentHome) {
  // Sender allowlist: only trusted agents (the primary agent + enabled exchange
  // agents, e.g. opus) may auto-task codex. A message from any other source is
  // NOT picked up by the runner, mirroring the opus runner's from-filter.
  const allowedSenders = dispatchTargetAllowlist(agentHome);
  const eligible = listExchangeInbox(agentHome, { agent: RUNNER_AGENT })
    .filter((message) => message.to === RUNNER_AGENT
      && allowedSenders.has(String(message.from))
      && (message.channel === "telegram" || message.channel === DISPATCH_CHANNEL)
      && isAvailableClaim(message.claim))
    .sort((a, b) => String(a.created_at || "").localeCompare(String(b.created_at || "")));
  return eligible[0] || null;
}

function isAvailableClaim(claim) {
  return !claim || claim.status === "released" || claim.status === "expired";
}

function codexReplyFor(paths, messageId) {
  return readJsonl(paths.exchangeReplies).find((reply) => reply.message_id === messageId) || null;
}

function codexSpawnAttemptsFor(paths, messageId) {
  return readJsonl(paths.codexExchangeRunnerDispatch)
    .filter((row) => row.message_id === messageId && SPAWN_OUTCOMES.has(row.outcome))
    .length;
}

function codexDispatchCountForDay(paths, now) {
  const day = new Date(now).toISOString().slice(0, 10);
  return readJsonl(paths.codexExchangeRunnerDispatch)
    .filter((row) => SPAWN_OUTCOMES.has(row.outcome) && String(row.created_at || "").slice(0, 10) === day)
    .length;
}

function recordCodexDispatch(paths, { messageId, attempt, outcome, model, now }) {
  appendJsonl(paths.codexExchangeRunnerDispatch, {
    message_id: messageId,
    attempt,
    outcome,
    model: model || null,
    created_at: new Date(now).toISOString(),
  });
}

function safeCodexRelease(agentHome, messageId) {
  try {
    releaseExchangeClaim({ agentHome, id: messageId, agent: RUNNER_AGENT });
  } catch {
    // The claim has a lease and will expire even if release fails.
  }
}

function codexLockTtlSeconds(agentHome) {
  const policy = getTelegramCodexPolicy(agentHome);
  return Number(policy.exchange_runner_timeout_seconds) + LOCK_TTL_BUFFER_SECONDS;
}

function acquireCodexRunnerLock(agentHome, ttlSeconds, now) {
  const file = agentPaths(agentHome).codexExchangeRunnerLock;
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
  if (isCodexLockFresh(file, ttlSeconds, now)) {
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

function isCodexLockFresh(file, ttlSeconds, now) {
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    const ts = Date.parse(data.acquired_at || "");
    return Number.isFinite(ts) && now - ts < Math.max(0, Number(ttlSeconds) || 0) * 1000;
  } catch {
    return false;
  }
}

function releaseCodexRunnerLock(agentHome) {
  const file = agentPaths(agentHome).codexExchangeRunnerLock;
  if (fs.existsSync(file)) {
    try {
      fs.unlinkSync(file);
    } catch {
      // best-effort
    }
  }
}

function resolveRepo(message, policy, fallbackRepoDir) {
  // If the message names a repo, use it; otherwise use the policy default or fallback.
  if (message.repo && typeof message.repo === "string" && message.repo.trim()) {
    return message.repo.trim();
  }
  if (policy.default_repo && typeof policy.default_repo === "string" && policy.default_repo.trim()) {
    return policy.default_repo.trim();
  }
  return fallbackRepoDir;
}

function sanitizeError(message) {
  return String(message || "").replace(/\s+/g, " ").trim().slice(0, 300);
}

function serializeRunResult(runResult) {
  return {
    ok: Boolean(runResult.ok),
    error: runResult.error || null,
    tokens: runResult.tokens || null,
  };
}

function summary(extra) {
  return { agent: RUNNER_AGENT, ...extra };
}
