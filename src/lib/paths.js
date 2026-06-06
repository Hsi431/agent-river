import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function expandHome(input) {
  if (!input) {
    return input;
  }
  if (input === "~") {
    return os.homedir();
  }
  if (input.startsWith("~/")) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

export function defaultMemoryStateHome() {
  return path.join(os.homedir(), ".codex", "memory-river");
}

export async function resolveStateHome(input, { create = true } = {}) {
  if (input) {
    const resolved = path.resolve(expandHome(input));
    if (create) {
      fs.mkdirSync(resolved, { recursive: true });
    }
    return resolved;
  }

  if (process.env.CODEX_MEMORY_HOME) {
    const resolved = path.resolve(expandHome(process.env.CODEX_MEMORY_HOME));
    if (create) {
      fs.mkdirSync(resolved, { recursive: true });
    }
    return resolved;
  }

  const preferred = defaultMemoryStateHome();
  if (!create) {
    return preferred;
  }
  try {
    fs.mkdirSync(preferred, { recursive: true });
    return preferred;
  } catch (error) {
    if (!["EACCES", "EROFS", "EPERM"].includes(error.code)) {
      throw error;
    }
    const fallback = path.resolve(".local-state");
    fs.mkdirSync(fallback, { recursive: true });
    return fallback;
  }
}

export function statePaths(stateHome) {
  return {
    chunks: path.join(stateHome, "raw-index", "chunks.jsonl"),
    terms: path.join(stateHome, "raw-index", "terms.jsonl"),
    vectors: path.join(stateHome, "raw-index", "vectors.jsonl"),
    manifest: path.join(stateHome, "raw-index", "manifest.json"),
    memories: path.join(stateHome, "durable", "memories.jsonl"),
    tombstones: path.join(stateHome, "durable", "tombstones.jsonl"),
    candidates: path.join(stateHome, "durable", "candidates.jsonl"),
    audit: path.join(stateHome, "durable", "audit.jsonl"),
    recallUsage: path.join(stateHome, "usage", "recalls.jsonl"),
    reports: path.join(stateHome, "reports"),
  };
}
