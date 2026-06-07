import fs from "node:fs";
import path from "node:path";
import { agentPaths } from "./paths.js";
import { getSafetyStatus, getTelegramCodexPolicy } from "./safety.js";
import { telegramCodexOnce } from "./telegram-codex.js";
import { acquirePollerLock, releasePollerLock } from "./telegram.js";

// R1: local, foreground, long-poll Telegram <-> Codex bridge. It is ONLY a
// scheduler: each cycle it calls the existing single-shot telegramCodexOnce
// (which owns the one getUpdates long-poll and one read-only `codex exec`), in
// approval-before-send mode. The bridge never sends model output directly, never
// installs/starts a daemon, holds no in-memory session state (on-disk JSONL stays
// authoritative), and refuses to run unless the policy is enabled AND approval is
// forced. Errors back off (bounded); long-poll provides pacing on success.

const DEFAULT_LONG_POLL_SECONDS = 25;
const DEFAULT_BACKOFF_BASE_MS = 1000;
const DEFAULT_BACKOFF_CAP_MS = 60000;

export async function telegramCodexBridge({
  agentHome,
  transport = "fetch",
  memoryStateHome,
  token,
  fetchImpl,
  execFileImpl,
  requestImpl,
  allowRealCodex = false,
  runner,
  longPollSeconds,
  maxCycles,
  maxRuntimeSeconds,
  abortSignal,
  onceImpl,
  sleepImpl,
  backoffBaseMs = DEFAULT_BACKOFF_BASE_MS,
  backoffCapMs = DEFAULT_BACKOFF_CAP_MS,
  now = () => Date.now(),
} = {}) {
  if (!allowRealCodex) {
    throw new Error("Refusing to run: pass --allow-real-codex to enable real Codex invocation");
  }
  const policy = getTelegramCodexPolicy(agentHome);
  if (!policy.enabled) {
    throw new Error("Refusing to run: bridge is disabled (telegram-codex-policy-set --enabled true)");
  }
  if (!policy.require_approval) {
    throw new Error("Refusing to run: bridge requires approval mode (require_approval=true)");
  }

  const longPoll = longPollSeconds === undefined ? DEFAULT_LONG_POLL_SECONDS : Number(longPollSeconds);
  if (!Number.isFinite(longPoll) || longPoll < 0) {
    throw new Error("--long-poll-seconds must be a non-negative number");
  }
  const cyclesLimit = maxCycles === undefined ? null : Number(maxCycles);
  if (cyclesLimit !== null && (!Number.isInteger(cyclesLimit) || cyclesLimit <= 0)) {
    throw new Error("--max-cycles must be a positive integer");
  }
  const runtimeLimitMs = maxRuntimeSeconds === undefined ? null : Number(maxRuntimeSeconds) * 1000;
  if (runtimeLimitMs !== null && (!Number.isFinite(runtimeLimitMs) || runtimeLimitMs < 0)) {
    throw new Error("--max-runtime-seconds must be a non-negative number");
  }

  const runOnce = onceImpl || telegramCodexOnce;
  const sleep = sleepImpl || defaultSleep;
  const startedAtMs = now();

  // §15.H: only one poller process may own getUpdates. Refuse to start a second.
  acquirePollerLock(agentHome);

  writeBridgeStatus(agentHome, {
    running: true,
    last_started_at: iso(startedAtMs),
    last_stopped_at: null,
    last_cycle_at: null,
    last_inbound_at: null,
    last_error: null,
    iterations: 0,
  });

  let cycles = 0;
  let backoffMs = backoffBaseMs;
  let lastError = null;
  let stopReason = null;

  try {
    while (true) {
      if (abortSignal?.aborted) {
        stopReason = "aborted";
        break;
      }
      if (cyclesLimit !== null && cycles >= cyclesLimit) {
        stopReason = "max_cycles";
        break;
      }
      if (runtimeLimitMs !== null && now() - startedAtMs >= runtimeLimitMs) {
        stopReason = "max_runtime";
        break;
      }

      cycles += 1;
      let result;
      try {
        result = await runOnce({
          agentHome,
          transport,
          memoryStateHome,
          token,
          fetchImpl,
          execFileImpl,
          requestImpl,
          runner,
          allowRealCodex: true,
          requireReplyApproval: true,
          longPollSeconds: longPoll,
        });
      } catch (error) {
        lastError = error.message;
        writeBridgeStatus(agentHome, {
          last_cycle_at: iso(now()),
          last_error: lastError,
          iterations: cycles,
        });
        // Bounded backoff: never a tight error loop. Abortable sleep so a
        // SIGINT/SIGTERM during backoff still stops promptly.
        await sleep(Math.min(backoffMs, backoffCapMs) / 1000, abortSignal);
        backoffMs = Math.min(backoffMs * 2, backoffCapMs);
        continue;
      }

      // Success: reset backoff. A non-null inbox_id means a message was received
      // and processed this cycle (drafted into the approval queue).
      backoffMs = backoffBaseMs;
      lastError = null;
      const cycleAt = iso(now());
      writeBridgeStatus(agentHome, {
        last_cycle_at: cycleAt,
        ...(result?.inbox_id ? { last_inbound_at: cycleAt } : {}),
        last_error: null,
        iterations: cycles,
      });
    }
  } finally {
    releasePollerLock(agentHome);
    writeBridgeStatus(agentHome, {
      running: false,
      last_stopped_at: iso(now()),
      last_error: lastError,
      iterations: cycles,
    });
  }

  return {
    stopped: true,
    stop_reason: stopReason,
    cycles,
    long_poll_seconds: longPoll,
    last_error: lastError,
    safety: getSafetyStatus(agentHome),
  };
}

export function telegramCodexBridgeStatus(agentHome) {
  const status = readBridgeStatus(agentHome);
  return {
    running: Boolean(status.running),
    last_started_at: status.last_started_at ?? null,
    last_stopped_at: status.last_stopped_at ?? null,
    last_cycle_at: status.last_cycle_at ?? null,
    last_inbound_at: status.last_inbound_at ?? null,
    last_error: status.last_error ?? null,
    iterations: status.iterations ?? 0,
  };
}

function defaultSleep(seconds, abortSignal) {
  return new Promise((resolve) => {
    if (abortSignal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, Math.max(0, seconds) * 1000);
    abortSignal?.addEventListener?.("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

function readBridgeStatus(agentHome) {
  const file = agentPaths(agentHome).bridgeStatus;
  if (!fs.existsSync(file)) {
    return {};
  }
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

function writeBridgeStatus(agentHome, patch) {
  const file = agentPaths(agentHome).bridgeStatus;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const next = { ...readBridgeStatus(agentHome), ...patch };
  fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

function iso(ms) {
  return new Date(ms).toISOString();
}
