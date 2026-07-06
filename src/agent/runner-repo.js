import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const UNBOUND_REPO_PROMPT_LINE = "本對話未綁定任何 repo;不要假設題目與你目前所在的 codebase 相關,依題目本身回答";

// A bound repo must survive realpath AND (when workspaceRoot is set) stay inside
// it. Anything else fails CLOSED to a neutral home dir + the unbound prompt —
// never to the service checkout, which is the old "everything is agent-river"
// trap. A polluted ledger or a post-open path swap therefore cannot steer a
// runner outside the workspace.
export function resolveMessageRepoBinding({ message, repoDir, workspaceRoot = null }) {
  const requested = typeof message?.repo === "string" ? message.repo.trim() : "";
  if (!requested) {
    return { cwd: neutralCwd(repoDir), promptLine: UNBOUND_REPO_PROMPT_LINE, repoFallback: null };
  }
  let real;
  try {
    real = fs.realpathSync(requested);
  } catch (error) {
    return unbound(requested, "realpath_failed", sanitizeRepoError(error?.message || error?.code || "repo realpath failed"));
  }
  if (workspaceRoot && !isInside(real, workspaceRoot)) {
    return unbound(requested, "outside_workspace", null);
  }
  return { cwd: real, promptLine: `本 session 綁定 repo:${real}`, repoFallback: null };
}

function unbound(requested, reason, error) {
  return {
    cwd: os.homedir(),
    promptLine: UNBOUND_REPO_PROMPT_LINE,
    repoFallback: { requested, reason, ...(error ? { error } : {}) },
  };
}

function neutralCwd(repoDir) {
  return String(repoDir || process.cwd());
}

// Prefix check on realpath'd boundaries with an explicit separator so `/ws-evil`
// does not pass as inside `/ws`.
function isInside(target, root) {
  let realRoot;
  try {
    realRoot = fs.realpathSync(root);
  } catch {
    realRoot = String(root);
  }
  const rel = path.relative(realRoot, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function sanitizeRepoError(message) {
  return String(message || "").replace(/\s+/g, " ").trim().slice(0, 300);
}
