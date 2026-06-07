// v2 Router — deterministic grammar parser (§8).
//
// Grammar:
//   @<agent> [repo=<name|/abs>] [mode=read|write] [--] <free text>
//
// Rules:
// - Only LEADING control tokens (immediately after @agent) are parsed.
// - First non-control token ends control parsing; any later repo=/mode= is
//   part of the prompt. `--` explicitly ends control parsing.
// - Unknown or duplicated control token → error.
// - mode=write requires an explicit repo=.
// - @claude → claude agent; @codex → codex agent; @opus → claude (back-compat).
//
// Returns one of:
//   { ok: true, agent, repo, mode, prompt }
//   { ok: false, reason, detail }

const CONTROL_TOKEN = /^(repo|mode)=/;
const MODE_VALUES = new Set(["read", "write"]);
// Capability ceiling: full-access/bypass may never be selected from Telegram.
const FORBIDDEN_MODES = new Set(["full-access", "bypass", "danger-full-access", "bypassPermissions"]);

export function parseV2Message(text) {
  const raw = String(text || "").trim();

  // Must start with @<agent>.
  const agentMatch = raw.match(/^@([a-z][a-z0-9_-]*)\b/);
  if (!agentMatch) {
    return null; // Not a v2 message.
  }

  const rawAgent = agentMatch[1];
  const agent = normalizeAgent(rawAgent);
  const rest = raw.slice(agentMatch[0].length).replace(/^\s+/, "");

  // Parse leading control tokens.
  let repo = null;
  let mode = null;
  const errors = [];
  let remaining = rest;

  while (remaining.length > 0) {
    // End-of-control marker.
    if (remaining.startsWith("-- ") || remaining === "--") {
      remaining = remaining === "--" ? "" : remaining.slice(3);
      break;
    }

    // Check for a control token at the front.
    const tokenMatch = remaining.match(/^([a-z][a-z0-9_-]*)=(\S*)/);
    if (!tokenMatch || !CONTROL_TOKEN.test(tokenMatch[0])) {
      // Non-control token: stop parsing control tokens.
      break;
    }

    const key = tokenMatch[1];
    const value = tokenMatch[2];
    remaining = remaining.slice(tokenMatch[0].length).replace(/^\s+/, "");

    if (key === "repo") {
      if (repo !== null) {
        errors.push("duplicate_repo");
      } else {
        repo = value || null;
      }
    } else if (key === "mode") {
      if (mode !== null) {
        errors.push("duplicate_mode");
      } else if (FORBIDDEN_MODES.has(value)) {
        errors.push("forbidden_mode");
      } else if (!MODE_VALUES.has(value)) {
        errors.push(`unknown_mode:${value}`);
      } else {
        mode = value;
      }
    } else {
      errors.push(`unknown_control:${key}`);
    }
  }

  const prompt = remaining.trim();

  // Validate: errors → report the first one.
  if (errors.length > 0) {
    return { ok: false, reason: "control_error", detail: errors[0], agent, raw };
  }

  // mode=write requires explicit repo= (§8, §12.1).
  const effectiveMode = mode || "read";
  if (effectiveMode === "write" && !repo) {
    return { ok: false, reason: "write_requires_repo", detail: "mode=write requires an explicit repo=", agent, raw };
  }

  // A prompt is required.
  if (!prompt) {
    return { ok: false, reason: "empty_prompt", detail: "No prompt text after control tokens", agent, raw };
  }

  return {
    ok: true,
    agent,
    repo: repo ? buildRepoInput(repo) : null,
    mode: effectiveMode,
    prompt,
  };
}

// Normalise @agent names. @opus → claude (back-compat); @claude → claude.
function normalizeAgent(raw) {
  if (raw === "opus" || raw === "claude") return "claude";
  return raw;
}

// Build the `input` string expected by resolveRepo.
function buildRepoInput(value) {
  if (value.startsWith("/")) {
    return `repo=${value}`;
  }
  return `repo=${value}`;
}
