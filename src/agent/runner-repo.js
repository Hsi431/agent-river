import fs from "node:fs";

export const UNBOUND_REPO_PROMPT_LINE = "本對話未綁定任何 repo;不要假設題目與你目前所在的 codebase 相關,依題目本身回答";

export function resolveMessageRepoBinding({ message, repoDir }) {
  const fallback = String(repoDir || process.cwd());
  const requested = typeof message?.repo === "string" ? message.repo.trim() : "";
  if (!requested) {
    return {
      cwd: fallback,
      promptLine: UNBOUND_REPO_PROMPT_LINE,
      repoFallback: null,
    };
  }
  try {
    const real = fs.realpathSync(requested);
    return {
      cwd: real,
      promptLine: `本 session 綁定 repo:${real}`,
      repoFallback: null,
    };
  } catch (error) {
    return {
      cwd: fallback,
      promptLine: `本 session 綁定 repo:${fallback}`,
      repoFallback: {
        requested,
        fallback,
        error: sanitizeRepoError(error?.message || error?.code || "repo realpath failed"),
      },
    };
  }
}

function sanitizeRepoError(message) {
  return String(message || "").replace(/\s+/g, " ").trim().slice(0, 300);
}
