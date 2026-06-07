import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { scanSecrets } from "../../lib/secret-scan.js";
import { getTelegramCodexPolicy } from "../safety.js";
import { terminateGroup } from "./kill.js";

// Thin AgentAdapter interface (§4).
//
// AgentAdapter.run({ repoToplevel, mode, prompt, sessionId, model, signal, execFileImpl })
//   → { ok, text, sessionId, tokens, outcome }
//
// outcome ∈ ok | capability_blocked | provider_permission_denied |
//            repo_access_denied | timed_out | outcome_unknown | spawn_error

const ADAPTER_TIMEOUT_MS = 600_000; // 10 min default

// ─── Claude adapter ──────────────────────────────────────────────────────────

// Settings profiles (reuse existing generator pattern from exchange-runner.js).
// For local-parity Phase 1 we do NOT use --ignore-user-config; project settings
// are inherited exactly as when running locally.
function defaultReadSettingsPath() {
  return path.join(os.homedir(), ".config", "codex-agent", "opus-runner-settings.json");
}

function defaultWriteSettingsPath() {
  return path.join(os.homedir(), ".config", "codex-agent", "opus-edit-settings.json");
}

export function makeClaudeAdapter({
  agentHome,
  readSettingsPath = defaultReadSettingsPath(),
  writeSettingsPath = defaultWriteSettingsPath(),
  timeoutMs = ADAPTER_TIMEOUT_MS,
} = {}) {
  return {
    name: "claude",
    async run({ repoToplevel, mode, prompt, sessionId, model, signal, execFileImpl = execFile, onSpawn }) {
      const promptText = String(prompt || "");
      if (!promptText.trim()) {
        return failOutcome("spawn_error", null, 0, "Empty prompt");
      }
      if (scanSecrets(promptText).length > 0) {
        return failOutcome("spawn_error", null, 0, "Prompt may contain a secret");
      }

      // Capability ceiling: never expose full-access from Telegram (§2.3).
      if (mode !== "read" && mode !== "write") {
        return failOutcome("capability_blocked", null, 0, `Unsupported mode: ${mode}`);
      }

      const settingsPath = mode === "write" ? writeSettingsPath : readSettingsPath;
      // Fail-closed (§15.F): if the required settings profile is missing, refuse
      // to spawn Claude with provider defaults. Tests pass execFileImpl to bypass
      // the binary entirely, so this check must fire only when execFileImpl is the
      // real execFile AND the path is missing.
      if (settingsPath && execFileImpl === execFile && !fs.existsSync(settingsPath)) {
        return failOutcome("capability_blocked", null, 0, `Settings profile missing: ${settingsPath}`);
      }

      const policy = agentHome ? getTelegramCodexPolicy(agentHome) : {};
      const effectiveModel = model || policy.exchange_runner_model || null;

      const args = [
        "-p",
        "--output-format", "json",
        "--add-dir", repoToplevel,
      ];
      if (settingsPath && fs.existsSync(settingsPath)) {
        args.push("--settings", settingsPath);
      }
      if (effectiveModel) {
        args.push("--model", String(effectiveModel));
      }
      if (sessionId) {
        args.push("--resume", String(sessionId));
      }
      args.push(promptText);

      const result = await spawnClaude({
        args,
        cwd: repoToplevel,
        timeoutMs,
        signal,
        execFileImpl,
        onSpawn,
      });

      return interpretClaudeResult(result, sessionId);
    },
  };
}

function interpretClaudeResult(result, priorSessionId) {
  if (result.timedOut) {
    return failOutcome("timed_out", priorSessionId, result.tokens);
  }
  if (result.resumeFailure) {
    // Caller's session-model layer handles stale retry; surface the failure.
    return failOutcome("spawn_error", null, 0, "resume_failure");
  }
  if (!result.ok) {
    // Try to classify the error.
    const msg = String(result.error || result.stderr || "");
    if (/permission denied|access denied/i.test(msg)) {
      return failOutcome("provider_permission_denied", result.sessionId, result.tokens);
    }
    if (/repository|repo|no such file|ENOENT/i.test(msg)) {
      return failOutcome("repo_access_denied", result.sessionId, result.tokens);
    }
    if (/spawn|ENOENT.*claude/i.test(msg)) {
      return failOutcome("spawn_error", null, 0, msg.slice(0, 200));
    }
    // Uncertain result — do not auto-rerun writes.
    return failOutcome("outcome_unknown", result.sessionId, result.tokens);
  }
  if (!result.text) {
    return failOutcome("outcome_unknown", result.sessionId, result.tokens);
  }
  return {
    ok: true,
    text: result.text,
    sessionId: result.sessionId || null,
    tokens: result.tokens,
    outcome: "ok",
  };
}

function spawnClaude({ args, cwd, timeoutMs, signal, execFileImpl, onSpawn }) {
  return new Promise((resolve) => {
    let settled = false;
    let killTimer = null;

    function settle(value) {
      if (settled) return;
      settled = true;
      if (killTimer) { clearTimeout(killTimer); killTimer = null; }
      resolve(value);
    }

    // Do NOT pass execFile's built-in timeout (§15.C): with detached=true it
    // kills only the direct child and leaves grandchildren running. Use a manual
    // timer instead (SIGTERM → grace → SIGKILL → confirm gone → timed_out).
    const child = execFileImpl("claude", args, {
      cwd,
      env: spawnEnvWithLocalBin(),
      maxBuffer: 8 * 1024 * 1024,
      detached: true,
    }, (error, stdout, stderr) => {
      const parsed = parseClaudeOutput(stdout);
      const timedOut = Boolean(error && (error.killed || error.signal === "SIGTERM" || error.code === "ETIMEDOUT"));
      const resumeFailure = !timedOut && error && isResumeFailure(`${error.message || ""} ${stderr || ""}`);
      settle({
        ok: !error,
        timedOut,
        resumeFailure,
        text: parsed.text,
        sessionId: parsed.sessionId,
        tokens: parsed.tokens,
        error: error ? sanitize(error.message) : null,
        stderr: error ? sanitize(String(stderr || "")).slice(0, 300) : null,
      });
    });

    // Report PID immediately via onSpawn hook so registry gets the real PID (§15.B).
    if (child?.pid && onSpawn) {
      onSpawn(child.pid);
    }

    // Manual process-group timeout (§15.C). Skip if the exec callback already
    // settled synchronously (e.g. injected execFileImpl in tests) — otherwise the
    // timer is installed after settle() ran and never gets cleared, keeping the
    // event loop alive for timeoutMs.
    if (!settled && timeoutMs > 0 && child?.pid) {
      const pid = child.pid;
      killTimer = setTimeout(async () => {
        killTimer = null;
        await terminateGroup(pid); // SIGTERM → grace → SIGKILL → confirm gone
        settle({ ok: false, timedOut: true, resumeFailure: false, text: "", sessionId: null, tokens: 0, error: "timed_out", stderr: null });
      }, timeoutMs);
    }

    // Handle signal-based cancellation (kill switch / /stop). Confirm the group
    // is gone before reporting cancelled (§15.B/C).
    if (signal) {
      signal.addEventListener("abort", async () => {
        if (settled) return;
        if (child?.pid) await terminateGroup(child.pid);
        settle({ ok: false, timedOut: false, resumeFailure: false, text: "", sessionId: null, tokens: 0, error: "cancelled", stderr: null });
      }, { once: true });
    }

    child?.stdin?.on?.("error", () => {});
    child?.stdin?.end?.();
  });
}

// ─── Codex adapter ───────────────────────────────────────────────────────────

export function makeCodexAdapter({ agentHome, timeoutMs = ADAPTER_TIMEOUT_MS } = {}) {
  return {
    name: "codex",
    async run({ repoToplevel, mode, prompt, sessionId, model, signal, execFileImpl = execFile, onSpawn }) {
      const promptText = String(prompt || "");
      if (!promptText.trim()) {
        return failOutcome("spawn_error", null, 0, "Empty prompt");
      }
      if (scanSecrets(promptText).length > 0) {
        return failOutcome("spawn_error", null, 0, "Prompt may contain a secret");
      }

      if (mode !== "read" && mode !== "write") {
        return failOutcome("capability_blocked", null, 0, `Unsupported mode: ${mode}`);
      }

      const sandbox = mode === "write" ? "workspace-write" : "read-only";

      const policy = agentHome ? getTelegramCodexPolicy(agentHome) : {};
      const effectiveModel = model || policy.codex_runner_model || null;

      // Build args for codex exec or codex exec resume.
      const args = sessionId
        ? buildCodexResumeArgs({ sessionId, sandbox, repoToplevel, model: effectiveModel })
        : buildCodexExecArgs({ sandbox, repoToplevel, model: effectiveModel });

      // §15.E: resume ALWAYS sends the new prompt via stdin (same as a fresh turn).
      // Never null the prompt on resume.
      const result = await spawnCodex({
        args,
        cwd: repoToplevel,
        promptText,
        timeoutMs,
        signal,
        execFileImpl,
        onSpawn,
      });

      return interpretCodexResult(result, sessionId, promptText, mode);
    },
  };
}

function buildCodexExecArgs({ sandbox, repoToplevel, model }) {
  const args = [
    "exec",
    "--sandbox", sandbox,
    "--cd", repoToplevel,
    "--json",
  ];
  if (model) {
    args.push("--model", String(model));
  }
  return args;
}

function buildCodexResumeArgs({ sessionId, sandbox, repoToplevel, model }) {
  const args = [
    "exec", "resume", String(sessionId),
    "--sandbox", sandbox,
    "--cd", repoToplevel,
    "--json",
  ];
  if (model) {
    args.push("--model", String(model));
  }
  return args;
}

function spawnCodex({ args, cwd, promptText, timeoutMs, signal, execFileImpl, onSpawn }) {
  return new Promise((resolve) => {
    let settled = false;
    let killTimer = null;
    const jsonLines = [];

    function settle(value) {
      if (settled) return;
      settled = true;
      if (killTimer) { clearTimeout(killTimer); killTimer = null; }
      resolve(value);
    }

    // Do NOT pass execFile's built-in timeout (§15.C): with detached=true it
    // kills only the direct child and leaves grandchildren running.
    const child = execFileImpl("codex", args, {
      cwd,
      maxBuffer: 16 * 1024 * 1024,
      detached: true,
    }, (error, stdout, stderr) => {
      const stdoutBuf = String(stdout || "");
      const stderrBuf = String(stderr || "");

      // Parse JSON events from stdout (§15.D).
      for (const line of stdoutBuf.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try { jsonLines.push(JSON.parse(trimmed)); } catch { /* not a JSON line */ }
      }

      const timedOut = Boolean(error && (error.killed || error.signal === "SIGTERM" || error.code === "ETIMEDOUT"));
      const resumeFailure = !timedOut && error && isResumeFailure(`${error.message || ""} ${stderrBuf}`);

      settle({
        ok: !error,
        timedOut,
        resumeFailure,
        text: extractCodexFinalText(jsonLines),
        sessionId: extractCodexSessionId(jsonLines),
        tokens: extractCodexTokens(jsonLines),
        error: error ? sanitize(error.message) : null,
        stderr: error ? sanitize(stderrBuf).slice(0, 300) : null,
      });
    });

    // Report PID immediately via onSpawn hook so registry gets the real PID (§15.B).
    if (child?.pid && onSpawn) {
      onSpawn(child.pid);
    }

    // Manual process-group timeout (§15.C). Skip if already settled synchronously
    // (injected execFileImpl in tests) so the timer can't linger and keep the
    // event loop alive for timeoutMs.
    if (!settled && timeoutMs > 0 && child?.pid) {
      const pid = child.pid;
      killTimer = setTimeout(async () => {
        killTimer = null;
        await terminateGroup(pid); // SIGTERM → grace → SIGKILL → confirm gone
        settle({ ok: false, timedOut: true, resumeFailure: false, text: "", sessionId: null, tokens: 0, error: "timed_out", stderr: null });
      }, timeoutMs);
    }

    // Confirm the group is gone before reporting cancelled (§15.B/C).
    if (signal) {
      signal.addEventListener("abort", async () => {
        if (settled) return;
        if (child?.pid) await terminateGroup(child.pid);
        settle({ ok: false, timedOut: false, resumeFailure: false, text: "", sessionId: null, tokens: 0, error: "cancelled", stderr: null });
      }, { once: true });
    }

    child?.stdin?.on?.("error", () => {});
    // §15.E: Always send the prompt via stdin — on fresh sessions AND on resume.
    try {
      child?.stdin?.write?.(`${promptText}\n`);
    } catch { /* spawn may have failed */ }
    child?.stdin?.end?.();
  });
}

function interpretCodexResult(result, priorSessionId, prompt, mode) {
  if (result.timedOut) {
    return failOutcome("timed_out", priorSessionId, result.tokens);
  }
  if (result.resumeFailure) {
    return failOutcome("spawn_error", null, 0, "resume_failure");
  }
  if (!result.ok) {
    const msg = String(result.error || result.stderr || "");
    if (/permission denied|sandbox|capability/i.test(msg)) {
      return failOutcome("capability_blocked", result.sessionId, result.tokens);
    }
    if (/repository|ENOENT/i.test(msg)) {
      return failOutcome("repo_access_denied", result.sessionId, result.tokens);
    }
    if (/spawn|ENOENT.*codex/i.test(msg)) {
      return failOutcome("spawn_error", null, 0, msg.slice(0, 200));
    }
    // Write turn with uncertain result → outcome_unknown.
    if (mode === "write") {
      return failOutcome("outcome_unknown", result.sessionId, result.tokens);
    }
    return failOutcome("outcome_unknown", result.sessionId, result.tokens);
  }
  if (!result.text) {
    return failOutcome("outcome_unknown", result.sessionId, result.tokens);
  }
  return {
    ok: true,
    text: result.text,
    sessionId: result.sessionId || null,
    tokens: result.tokens,
    outcome: "ok",
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function failOutcome(outcome, sessionId, tokens, errorDetail) {
  return {
    ok: false,
    text: "",
    sessionId: sessionId || null,
    tokens: tokens || 0,
    outcome,
    errorDetail: errorDetail || null,
  };
}

function parseClaudeOutput(stdout) {
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

// ─── Codex --json event extractors (real format per §15.D) ───────────────────
//
// Real event shapes (from `codex exec --json`):
//   session/thread start: { "type": "thread.created" | "session.created", "id": "..." }
//                      or: { "type": "...", "thread_id": "..." } / { "session_id": "..." }
//   final text:  { "type": "item.completed", "item": { "type": "agent_message", "text": "..." } }
//   tokens:      { "type": "turn.completed", "usage": { "input_tokens": N, "output_tokens": N } }
//
// Concatenate all agent_message texts; sum input+output from turn.completed.

function extractCodexSessionId(events) {
  for (const ev of events) {
    // Direct id field on session/thread creation events.
    if (
      (ev?.type === "thread.created" || ev?.type === "session.created") &&
      typeof ev?.id === "string" && ev.id
    ) {
      return ev.id;
    }
    // Fallback: thread_id or session_id on any event.
    if (typeof ev?.thread_id === "string" && ev.thread_id) return ev.thread_id;
    if (typeof ev?.session_id === "string" && ev.session_id) return ev.session_id;
  }
  return null;
}

function extractCodexFinalText(events) {
  // Concatenate all agent_message texts from item.completed events (§15.D).
  const parts = [];
  for (const ev of events) {
    if (
      ev?.type === "item.completed" &&
      ev?.item?.type === "agent_message" &&
      typeof ev.item.text === "string"
    ) {
      parts.push(ev.item.text);
    }
  }
  if (parts.length > 0) return parts.join("").trim();
  return "";
}

function extractCodexTokens(events) {
  // Sum input_tokens + output_tokens from turn.completed events (§15.D).
  let total = 0;
  for (const ev of events) {
    if (ev?.type === "turn.completed" && ev?.usage) {
      total += (Number(ev.usage.input_tokens) || 0) + (Number(ev.usage.output_tokens) || 0);
    }
  }
  return total;
}

function isResumeFailure(msg) {
  return /No conversation found|session ID|--resume/i.test(String(msg || ""));
}

function spawnEnvWithLocalBin() {
  const localBin = path.join(os.homedir(), ".local", "bin");
  const current = process.env.PATH || "";
  const PATH = current.split(":").includes(localBin) ? current : `${localBin}:${current}`;
  return { ...process.env, PATH };
}

function sanitize(message) {
  return String(message || "").replace(/\s+/g, " ").trim().slice(0, 300);
}
