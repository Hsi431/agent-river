import { resolveStateHome } from "../lib/paths.js";

const MEMORY_UNAVAILABLE_MESSAGE = "Memory River unavailable; disable memory or install codex-memory-river.";

export async function buildMemoryContextBlock({
  enabled = false,
  memoryStateHome,
  repo,
  preflightImpl,
  contextBlockImpl,
  importImpl = importMemoryModule,
} = {}) {
  if (!enabled || !repo) {
    return "";
  }

  let preflight = preflightImpl;
  let formatContextBlock = contextBlockImpl;
  if (!preflight || !formatContextBlock) {
    try {
      const integration = await loadMemoryIntegration(importImpl);
      preflight = preflight || integration.preflight;
      formatContextBlock = formatContextBlock || integration.formatContextBlock;
    } catch {
      throw Object.assign(new Error(MEMORY_UNAVAILABLE_MESSAGE), { reason: "memory_unavailable" });
    }
  }

  try {
    const stateHome = memoryStateHome || await resolveStateHome(undefined, { create: false });
    const result = await preflight({ stateHome, repo, brief: true, maxRecent: 3 });
    return formatContextBlock(result, { brief: true });
  } catch (error) {
    if (error?.reason === "memory_unavailable") {
      throw error;
    }
    throw Object.assign(new Error("Memory context failed"), { reason: "memory_context_failed" });
  }
}

async function loadMemoryIntegration(importImpl) {
  const [preflightModule, contextBlockModule] = await Promise.all([
    importImpl("codex-memory-river/src/preflight.js"),
    importImpl("codex-memory-river/src/context-block.js"),
  ]);
  if (typeof preflightModule.preflight !== "function" || typeof contextBlockModule.formatContextBlock !== "function") {
    throw new Error("Memory River integration exports are missing.");
  }
  return {
    preflight: preflightModule.preflight,
    formatContextBlock: contextBlockModule.formatContextBlock,
  };
}

function importMemoryModule(specifier) {
  return import(specifier);
}
