import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { scanSecrets } from "../lib/secret-scan.js";
import { getTelegramCodexPolicy } from "./safety.js";

// The ONLY module that invokes real `codex exec`. It passes no shell,
// secret-scans the prompt before invocation, and is injectable so tests never
// spawn a real process. Plan/direct replies run read-only; owner-approved edit
// tasks use workspace-write explicitly.

const CODEX_TIMEOUT_MS = 120000;
const CODEX_MAX_BUFFER_BYTES = 16 * 1024 * 1024;

export async function realCodexRunner({ prompt, execFileImpl = execFile, cwd, agentHome, timeoutMs } = {}) {
  return realCodexRunnerWithSandbox({ prompt, execFileImpl, cwd, sandbox: "read-only", agentHome, timeoutMs });
}

export async function realEditCodexRunner({ prompt, execFileImpl = execFile, cwd, agentHome, timeoutMs } = {}) {
  return realCodexRunnerWithSandbox({ prompt, execFileImpl, cwd, sandbox: "workspace-write", agentHome, timeoutMs });
}

async function realCodexRunnerWithSandbox({ prompt, execFileImpl = execFile, cwd, sandbox, agentHome, timeoutMs } = {}) {
  const promptText = String(prompt || "");
  if (!promptText.trim()) {
    throw new Error("Codex prompt is empty");
  }
  if (scanSecrets(promptText).length > 0) {
    throw new Error("Prompt may contain a secret; refusing to invoke Codex");
  }
  const outFile = path.join(os.tmpdir(), `codex-reply-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
  try {
    const model = agentHome ? getTelegramCodexPolicy(agentHome).codex_runner_model : "";
    const run = await runCodexExec({ prompt: promptText, outFile, execFileImpl, cwd, sandbox, model, timeoutMs });

    const outRaw = fs.existsSync(outFile) ? fs.readFileSync(outFile) : Buffer.alloc(0);
    const stdoutText = String(run.stdout || "");
    const diag = {
      outFileBytes: outRaw.length,
      stdoutBytes: Buffer.byteLength(stdoutText, "utf8"),
      stderrBytes: Buffer.byteLength(String(run.stderr || ""), "utf8"),
      errored: Boolean(run.error),
      timedOut: Boolean(run.timedOut),
    };

    // On exec error, never return partial output — surface a sanitized diagnostic.
    if (run.error) {
      throw new Error(`Codex exec failed (${formatDiag(diag)})`);
    }

    // Primary: the -o output file. Fallback: stdout final text.
    const text = outRaw.toString("utf8").trim() || stdoutText.trim();
    if (!text) {
      throw new Error(`Codex produced no reply (${formatDiag(diag)})`);
    }

    // Real token usage, if codex printed it (stdout preferred, then stderr).
    const tokens = parseCodexTokenUsage(stdoutText) ?? parseCodexTokenUsage(String(run.stderr || ""));
    return { text, tokens: tokens ?? null, usageParsed: tokens != null };
  } finally {
    if (fs.existsSync(outFile)) {
      try {
        fs.unlinkSync(outFile);
      } catch {
        // best-effort cleanup
      }
    }
  }
}

function runCodexExec({ prompt, outFile, execFileImpl, cwd, sandbox, model, timeoutMs }) {
  return new Promise((resolve) => {
    // The prompt is NOT a process argument — it goes on stdin so inbound text is
    // never visible in a process listing (`ps`).
    const args = [
      "exec",
      "--sandbox", sandbox || "read-only",
      "--skip-git-repo-check",
      "-o", outFile,
    ];
    if (model) {
      args.push("--model", String(model));
    }
    const child = execFileImpl("codex", args, {
      cwd: cwd || process.cwd(),
      timeout: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : CODEX_TIMEOUT_MS,
      maxBuffer: CODEX_MAX_BUFFER_BYTES,
    }, (error, stdout, stderr) => {
      resolve({
        error: error || null,
        timedOut: Boolean(error && (error.killed || error.signal === "SIGTERM" || error.code === "ETIMEDOUT")),
        stdout: stdout ?? "",
        stderr: stderr ?? "",
      });
    });
    // Write the prompt to stdin, then close it (codex reads the prompt to EOF).
    child?.stdin?.on?.("error", () => {});
    try {
      child?.stdin?.write?.(`${prompt}\n`);
    } catch {
      // if the process failed to spawn, the exec callback reports the error
    }
    child?.stdin?.end?.();
  });
}

function formatDiag({ outFileBytes, stdoutBytes, stderrBytes, errored, timedOut }) {
  return `outFile=${outFileBytes}B, stdout=${stdoutBytes}B, stderr=${stderrBytes}B, errored=${errored}, timedOut=${timedOut}`;
}

// Wraps realCodexRunner into the plan-step result shape worker.runPlanStep
// expects ({ text, exit, tokens, sessionPath }). Used as the production
// fallback when no test runner is injected into runAgentOnce. realCodexRunner
// throws on exec failure; that throw is handled by runPlanOnlyTask, which
// transitions the task to failed rather than leaving it planning.
export async function realPlanRunner({ prompt, task, step, execFileImpl, agentHome } = {}) {
  const result = await realCodexRunner({ prompt, execFileImpl, cwd: task?.repo, agentHome });
  return {
    text: result.text,
    prompt,
    sessionPath: null,
    exit: 0,
    tokens: result.tokens ?? estimateReplyTokens(prompt, result.text),
    step,
  };
}

export async function realEditRunner({ prompt, task, step, execFileImpl, agentHome } = {}) {
  const result = await realEditCodexRunner({ prompt, execFileImpl, cwd: task?.repo, agentHome });
  return {
    text: result.text,
    prompt,
    sessionPath: null,
    exit: 0,
    tokens: result.tokens ?? estimateReplyTokens(prompt, result.text),
    step,
  };
}

export function estimateReplyTokens(prompt, reply) {
  const words = `${prompt || ""} ${reply || ""}`.split(/\s+/).filter(Boolean).length;
  return Math.ceil(words * 1.4);
}

// Pure parser for the "tokens used\n1,645" line codex prints. Returns the
// integer (comma-formatted accepted) or null. Not yet wired into cost
// accounting — kept available for a future real-usage upgrade.
export function parseCodexTokenUsage(text) {
  const match = /tokens used[^\d]*([\d,]+)/i.exec(String(text || ""));
  if (!match) {
    return null;
  }
  const value = Number.parseInt(match[1].replace(/,/g, ""), 10);
  return Number.isFinite(value) ? value : null;
}
