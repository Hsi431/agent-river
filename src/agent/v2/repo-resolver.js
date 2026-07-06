import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";

// Repo resolver: §3 of the spec.
// resolveRepo({ workspaceRoot, input, defaultRepo, execFileImpl })
//   → { ok: true, toplevel } | { ok: false, reason }
//
// Accepted reason codes:
//   missing_workspace_root   – no workspace_root and no default_repo to derive it from
//   invalid_input            – input is not repo=<name> or repo=/abs/path form
//   repo_not_found           – target does not exist or is not a directory
//   repo_access_denied       – git rev-parse failed (non-git dir, bare repo, permission error)
//   repo_outside_workspace   – top-level escapes the workspace root

export async function resolveRepo({ workspaceRoot, input, defaultRepo, execFileImpl = execFile } = {}) {
  // Derive workspaceRoot from defaultRepo when not explicitly provided.
  const wsRoot = workspaceRoot
    ? workspaceRoot
    : defaultRepo
      ? path.dirname(path.resolve(String(defaultRepo)))
      : null;

  if (!wsRoot) {
    return err("missing_workspace_root");
  }

  // Determine candidate path from input.
  let candidatePath;
  if (!input) {
    // No input → use defaultRepo.
    if (!defaultRepo) {
      return err("missing_workspace_root");
    }
    candidatePath = path.resolve(String(defaultRepo));
  } else {
    const raw = String(input);
    // Only accept repo=<name> or repo=/absolute/path. No NL, no recursive search.
    const nameMatch = raw.match(/^repo=([^/][^=\s]*)$/);
    const absMatch = raw.match(/^repo=(\/[^\s=]*)$/);
    if (nameMatch) {
      candidatePath = path.join(realOrRaw(wsRoot), nameMatch[1]);
    } else if (absMatch) {
      candidatePath = absMatch[1];
    } else {
      return err("invalid_input");
    }
  }

  // realpath the workspace root (tolerate if it does not exist — we check target).
  const wsRealpath = realOrRaw(wsRoot);

  // Check target exists and is a directory.
  let targetReal;
  try {
    targetReal = fs.realpathSync(candidatePath);
  } catch {
    return err("repo_not_found");
  }

  if (!fs.statSync(targetReal, { throwIfNoEntry: false })?.isDirectory()) {
    return err("repo_not_found");
  }

  // Run git rev-parse --show-toplevel.
  let toplevelRaw;
  try {
    toplevelRaw = await gitToplevel(targetReal, execFileImpl);
  } catch {
    return err("repo_access_denied");
  }

  if (!toplevelRaw) {
    return err("repo_access_denied");
  }

  // realpath the toplevel.
  let toplevel;
  try {
    toplevel = fs.realpathSync(toplevelRaw.trim());
  } catch {
    return err("repo_access_denied");
  }

  // Containment check: toplevel must be ws root or a direct/indirect child.
  if (toplevel !== wsRealpath && !toplevel.startsWith(wsRealpath + path.sep)) {
    return err("repo_outside_workspace");
  }

  return { ok: true, toplevel };
}

// Re-validate that the toplevel still exists, just before spawn (TOCTOU best-effort).
export async function revalidateRepo(toplevel, execFileImpl = execFile) {
  try {
    const result = await gitToplevel(toplevel, execFileImpl);
    if (!result || result.trim() !== toplevel) {
      return { ok: false, reason: "repo_access_denied" };
    }
    return { ok: true };
  } catch {
    return { ok: false, reason: "repo_access_denied" };
  }
}

function gitToplevel(cwd, execFileImpl) {
  return new Promise((resolve, reject) => {
    execFileImpl("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
      timeout: 5000,
    }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(stdout);
    });
  });
}

function realOrRaw(p) {
  try {
    return fs.realpathSync(String(p));
  } catch {
    return path.resolve(String(p));
  }
}

function err(reason) {
  return { ok: false, reason };
}

// Make a bare git repo for testing (returns the dir path).
export function makeBareRepo(parentDir, name, execFileImpl = execFile) {
  const dir = path.join(parentDir, name);
  fs.mkdirSync(dir, { recursive: true });
  return new Promise((resolve, reject) => {
    execFileImpl("git", ["init", "--bare", dir], { timeout: 5000 }, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(dir);
    });
  });
}
