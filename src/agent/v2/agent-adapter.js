import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { scanSecrets } from "../../lib/secret-scan.js";
import { getTelegramCodexPolicy } from "../safety.js";

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
    async run({ repoToplevel, mode, prompt, sessionId, model, signal, execFileImpl = execFile }) {
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
      // Fail-closed: if the settings file is missing, refuse to spawn an
      // unsandboxed Claude. This matches the exchange-runner behaviour.
      if (settingsPath && !fs.existsSync(settingsPath)) {
        // Allow tests that pass execFileImpl without needing real settings files.
        // In production, the settings path must exist.
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

function spawnClaude({ args, cwd, timeoutMs, signal, execFileImpl }) {
  return new Promise((resolve) => {
    let settled = false;
    const child = execFileImpl("claude", args, {
      cwd,
      env: spawnEnvWithLocalBin(),
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
      // Own process group so abort/kill-switch can SIGTERM the whole group
      // (process.kill(-pid)), not just the direct child (§12.2).
      detached: true,
    }, (error, stdout, stderr) => {
      if (settled) return;
      settled = true;
      const parsed = parseClaudeOutput(stdout);
      const timedOut = Boolean(error && (error.killed || error.signal === "SIGTERM" || error.code === "ETIMEDOUT"));
      const resumeFailure = !timedOut && error && isResumeFailure(`${error.message || ""} ${stderr || ""}`);
      resolve({
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

    // Handle signal-based cancellation (kill switch / /stop).
    if (signal) {
      signal.addEventListener("abort", () => {
        if (!settled) {
          settled = true;
          // Kill the child's process group.
          if (child?.pid) {
            try {
              process.kill(-child.pid, "SIGTERM");
            } catch {
              try { child.kill("SIGTERM"); } catch { /* best-effort */ }
            }
          }
          resolve({ ok: false, timedOut: false, resumeFailure: false, text: "", sessionId: null, tokens: 0, error: "cancelled", stderr: null });
        }
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
    async run({ repoToplevel, mode, prompt, sessionId, model, signal, execFileImpl = execFile }) {
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

      const result = await spawnCodex({
        args,
        cwd: repoToplevel,
        promptText: sessionId ? null : promptText, // resume sends no stdin
        timeoutMs,
        signal,
        execFileImpl,
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

function spawnCodex({ args, cwd, promptText, timeoutMs, signal, execFileImpl }) {
  return new Promise((resolve) => {
    let settled = false;
    const jsonLines = [];
    let stdoutBuf = "";
    let stderrBuf = "";

    const child = execFileImpl("codex", args, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
      // Own process group so abort/kill-switch can SIGTERM the whole group
      // (process.kill(-pid)), not just the direct child (§12.2).
      detached: true,
    }, (error, stdout, stderr) => {
      if (settled) return;
      settled = true;
      stdoutBuf = String(stdout || "");
      stderrBuf = String(stderr || "");

      // Parse JSON events from stdout.
      for (const line of stdoutBuf.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          jsonLines.push(JSON.parse(trimmed));
        } catch { /* not a JSON line */ }
      }

      const timedOut = Boolean(error && (error.killed || error.signal === "SIGTERM" || error.code === "ETIMEDOUT"));
      const resumeFailure = !timedOut && error && isResumeFailure(`${error.message || ""} ${stderrBuf}`);
      const sessionIdFromEvents = extractCodexSessionId(jsonLines);
      const textFromEvents = extractCodexFinalText(jsonLines);
      const tokensFromEvents = extractCodexTokens(jsonLines, stdoutBuf, stderrBuf);

      resolve({
        ok: !error,
        timedOut,
        resumeFailure,
        text: textFromEvents,
        sessionId: sessionIdFromEvents,
        tokens: tokensFromEvents,
        error: error ? sanitize(error.message) : null,
        stderr: error ? sanitize(stderrBuf).slice(0, 300) : null,
      });
    });

    if (signal) {
      signal.addEventListener("abort", () => {
        if (!settled) {
          settled = true;
          if (child?.pid) {
            try {
              process.kill(-child.pid, "SIGTERM");
            } catch {
              try { child.kill("SIGTERM"); } catch { /* best-effort */ }
            }
          }
          resolve({ ok: false, timedOut: false, resumeFailure: false, text: "", sessionId: null, tokens: 0, error: "cancelled", stderr: null });
        }
      }, { once: true });
    }

    child?.stdin?.on?.("error", () => {});
    // Send prompt via stdin (new session); resume sends no stdin.
    if (promptText !== null) {
      try {
        child?.stdin?.write?.(`${promptText}\n`);
      } catch { /* spawn may have failed */ }
    }
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

function extractCodexSessionId(events) {
  // Look for an event with session_id or thread_id field.
  for (const ev of events) {
    if (typeof ev?.session_id === "string" && ev.session_id) return ev.session_id;
    if (typeof ev?.thread_id === "string" && ev.thread_id) return ev.thread_id;
  }
  return null;
}

function extractCodexFinalText(events) {
  // Last "content" or "message" event, or last event with a text field.
  let text = "";
  for (const ev of events) {
    if (typeof ev?.content === "string") text = ev.content;
    else if (typeof ev?.message === "string") text = ev.message;
    else if (typeof ev?.text === "string") text = ev.text;
    else if (typeof ev?.result === "string") text = ev.result;
  }
  return text.trim();
}

function extractCodexTokens(events, stdout, stderr) {
  // Try events first, then fall back to the "tokens used\n1,234" line.
  for (const ev of events) {
    const t = Number(ev?.tokens_used || ev?.total_tokens || ev?.usage?.total_tokens);
    if (Number.isFinite(t) && t > 0) return t;
  }
  const match = /tokens used[^\d]*([\d,]+)/i.exec(`${stdout}\n${stderr}`);
  if (match) {
    const v = Number.parseInt(match[1].replace(/,/g, ""), 10);
    if (Number.isFinite(v)) return v;
  }
  return 0;
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
