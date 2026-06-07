import fs from "node:fs";
import { appendJsonl, readJsonl } from "../lib/jsonl.js";
import { agentPaths } from "./paths.js";

const DEFAULT_DAILY_TOKEN_BUDGET = 20000;
// The primary local agent identity (the sender of gateway-originated exchange
// messages and the `from` the Opus runner expects). Defaults to "codex" for
// backward compatibility; configurable so a Claude-only or differently-named
// deployment is not hardwired to "codex".
const DEFAULT_PRIMARY_AGENT_ID = "codex";
// Deliberate sentinel for a disabled local token budget. We store the largest
// safe integer (not null) so every consumer's arithmetic (`budget - tokens`,
// `tokens >= budget`) keeps working without special-casing: the gate is
// effectively unreachable while the config schema stays a plain number.
const DISABLED_DAILY_TOKEN_BUDGET = Number.MAX_SAFE_INTEGER;
const VALID_AGENT_ID = /^[a-z][a-z0-9_-]*$/;

export function readAgentConfig(agentHome) {
  const filePath = agentPaths(agentHome).config;
  if (!fs.existsSync(filePath)) {
    return defaultConfig();
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return normalizeConfig(parsed);
  } catch {
    return closedConfig("corrupt_config");
  }
}

export function writeAgentConfig(agentHome, config) {
  const filePath = agentPaths(agentHome).config;
  fs.mkdirSync(agentHome, { recursive: true });
  const next = normalizeConfig(config);
  fs.writeFileSync(filePath, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

export function setKillSwitch(agentHome, enabled) {
  return writeAgentConfig(agentHome, {
    ...readAgentConfig(agentHome),
    kill_switch: Boolean(enabled),
  });
}

export function setDailyTokenBudget(agentHome, tokens) {
  if (isDisabledBudget(tokens)) {
    return writeAgentConfig(agentHome, {
      ...readAgentConfig(agentHome),
      daily_token_budget: DISABLED_DAILY_TOKEN_BUDGET,
    });
  }
  const budget = Number(tokens);
  if (!Number.isFinite(budget) || budget < 0) {
    throw new Error("Daily token budget must be a non-negative number or disabled");
  }
  return writeAgentConfig(agentHome, {
    ...readAgentConfig(agentHome),
    daily_token_budget: Math.floor(budget),
  });
}

export function allowGatewayUser(agentHome, userId) {
  const normalized = normalizeUserId(userId);
  const config = readAgentConfig(agentHome);
  return writeAgentConfig(agentHome, {
    ...config,
    gateway_allowlist: Array.from(new Set([...(config.gateway_allowlist || []), normalized])).sort(),
  });
}

export function denyGatewayUser(agentHome, userId) {
  const normalized = normalizeUserId(userId);
  const config = readAgentConfig(agentHome);
  return writeAgentConfig(agentHome, {
    ...config,
    gateway_allowlist: (config.gateway_allowlist || []).filter((item) => item !== normalized),
  });
}

export function enableExchangeAgent(agentHome, { agentId, kind = "manual" }) {
  const id = normalizeAgentId(agentId);
  const agentKind = normalizeAgentKind(kind);
  const config = readAgentConfig(agentHome);
  const agents = (config.exchange_agents || []).filter((agent) => agent.agent_id !== id);
  return writeAgentConfig(agentHome, {
    ...config,
    exchange_agents: [...agents, { agent_id: id, kind: agentKind, enabled: true }]
      .sort((a, b) => a.agent_id.localeCompare(b.agent_id)),
  });
}

export function disableExchangeAgent(agentHome, agentId) {
  const id = normalizeAgentId(agentId);
  const config = readAgentConfig(agentHome);
  const agents = (config.exchange_agents || []).filter((agent) => agent.agent_id !== id);
  return writeAgentConfig(agentHome, {
    ...config,
    exchange_agents: [...agents, { agent_id: id, kind: "manual", enabled: false }]
      .sort((a, b) => a.agent_id.localeCompare(b.agent_id)),
  });
}

export function isExchangeAgentEnabled(agentHome, agentId) {
  const id = normalizeAgentId(agentId);
  return (readAgentConfig(agentHome).exchange_agents || [])
    .some((agent) => agent.agent_id === id && agent.enabled);
}

export function isGatewayUserAllowed(agentHome, userId) {
  const normalized = String(userId || "").trim();
  if (!normalized) {
    return false;
  }
  const config = readAgentConfig(agentHome);
  return (config.gateway_allowlist || []).includes(normalized);
}

export function getSafetyStatus(agentHome, now = new Date()) {
  const config = readAgentConfig(agentHome);
  const date = dayKey(now);
  const tokens = readCostEntries(agentHome)
    .filter((entry) => entry.date === date)
    .reduce((sum, entry) => sum + Number(entry.tokens || 0), 0);
  return {
    config,
    today: {
      date,
      tokens,
      remaining_tokens: Math.max(0, config.daily_token_budget - tokens),
    },
  };
}

export function checkSafety(agentHome, now = new Date()) {
  const status = getSafetyStatus(agentHome, now);
  if (status.config.kill_switch) {
    return { ok: false, reason: "kill_switch", status };
  }
  if (status.today.tokens >= status.config.daily_token_budget) {
    return { ok: false, reason: "daily_token_budget", status };
  }
  return { ok: true, reason: null, status };
}

export function appendCost(agentHome, { task_id, step, tokens, usd_estimate = 0, cost_source }, now = new Date()) {
  appendJsonl(agentPaths(agentHome).cost, {
    date: dayKey(now),
    task_id,
    step,
    tokens,
    usd_estimate,
    ...(cost_source ? { cost_source } : {}),
    created_at: now.toISOString(),
  });
}

function readCostEntries(agentHome) {
  return readJsonl(agentPaths(agentHome).cost);
}

const DEFAULT_TELEGRAM_CODEX_POLICY = {
  enabled: false,
  require_approval: true,
  global_interval_seconds: 300,
  per_chat_interval_seconds: 300,
  max_model_calls_per_run: 1,
  default_repo: null,
  history_messages: 8,
  context_max_chars: 6000,
  memory_enabled: false,
  direct_send_enabled: false,
  direct_send_user_allowlist: [],
  direct_send_max_chars: 280,
  direct_send_daily_max: 20,
  direct_send_memory: false,
  direct_send_allow_action_claims: false,
  direct_send_min_remaining_tokens: 2000,
  direct_send_classes: ["ack", "greeting", "smalltalk"],
  direct_send_trusted_qa_enabled: false,
  direct_send_trusted_qa_max_chars: 1200,
  owner_mode_enabled: false,
  owner_low_risk_auto_plan_enabled: true,
  exchange_notify_enabled: false,
  exchange_notify_chat_id: null,
  exchange_notify_max_per_cycle: 3,
  exchange_runner_enabled: false,
  exchange_runner_model: "sonnet",
  codex_runner_model: "",
  exchange_runner_max_attempts: 2,
  exchange_runner_timeout_seconds: 600,
  exchange_runner_daily_max: 20,
  // v2: opt-in routing flag + workspace root for the repo resolver. v2 is off by
  // default so v1 behavior is unchanged until the owner enables it.
  v2_enabled: false,
  workspace_root: null,
};

const DIRECT_SEND_CLASSES = ["ack", "greeting", "smalltalk"];

export function getTelegramCodexPolicy(agentHome) {
  return readAgentConfig(agentHome).telegram_codex_policy;
}

export function setTelegramCodexPolicy(agentHome, patch = {}) {
  const config = readAgentConfig(agentHome);
  const next = { ...config.telegram_codex_policy };
  if (patch.enabled !== undefined) {
    next.enabled = parseBool(patch.enabled, "enabled");
  }
  if (patch.require_approval !== undefined) {
    next.require_approval = parseBool(patch.require_approval, "require-approval");
  }
  if (patch.global_interval_seconds !== undefined) {
    next.global_interval_seconds = requirePositiveNumber(patch.global_interval_seconds, "global-interval-seconds");
  }
  if (patch.per_chat_interval_seconds !== undefined) {
    next.per_chat_interval_seconds = requirePositiveNumber(patch.per_chat_interval_seconds, "per-chat-interval-seconds");
  }
  if (patch.max_model_calls_per_run !== undefined) {
    next.max_model_calls_per_run = requirePositiveInteger(patch.max_model_calls_per_run, "max-model-calls-per-run");
  }
  if (patch.default_repo !== undefined) {
    next.default_repo = patch.default_repo === null ? null : requireNonEmptyString(patch.default_repo, "default-repo");
  }
  if (patch.history_messages !== undefined) {
    next.history_messages = requirePositiveInteger(patch.history_messages, "history-messages");
  }
  if (patch.context_max_chars !== undefined) {
    next.context_max_chars = requirePositiveInteger(patch.context_max_chars, "context-max-chars");
  }
  if (patch.memory_enabled !== undefined) {
    next.memory_enabled = parseBool(patch.memory_enabled, "memory-enabled");
  }
  if (patch.direct_send_enabled !== undefined) {
    next.direct_send_enabled = parseBool(patch.direct_send_enabled, "direct-send-enabled");
  }
  if (patch.direct_send_max_chars !== undefined) {
    next.direct_send_max_chars = requirePositiveInteger(patch.direct_send_max_chars, "direct-send-max-chars");
  }
  if (patch.direct_send_daily_max !== undefined) {
    next.direct_send_daily_max = requireNonNegativeInteger(patch.direct_send_daily_max, "direct-send-daily-max");
  }
  if (patch.direct_send_min_remaining_tokens !== undefined) {
    next.direct_send_min_remaining_tokens = requireNonNegativeInteger(patch.direct_send_min_remaining_tokens, "direct-send-min-remaining-tokens");
  }
  if (patch.direct_send_trusted_qa_enabled !== undefined) {
    next.direct_send_trusted_qa_enabled = parseBool(patch.direct_send_trusted_qa_enabled, "direct-send-trusted-qa-enabled");
  }
  if (patch.direct_send_trusted_qa_max_chars !== undefined) {
    next.direct_send_trusted_qa_max_chars = requirePositiveInteger(patch.direct_send_trusted_qa_max_chars, "direct-send-trusted-qa-max-chars");
  }
  if (patch.owner_mode_enabled !== undefined) {
    next.owner_mode_enabled = parseBool(patch.owner_mode_enabled, "owner-mode-enabled");
  }
  if (patch.owner_low_risk_auto_plan_enabled !== undefined) {
    next.owner_low_risk_auto_plan_enabled = parseBool(patch.owner_low_risk_auto_plan_enabled, "owner-low-risk-auto-plan-enabled");
  }
  if (patch.exchange_notify_enabled !== undefined) {
    next.exchange_notify_enabled = parseBool(patch.exchange_notify_enabled, "exchange-notify-enabled");
  }
  if (patch.exchange_notify_chat_id !== undefined) {
    next.exchange_notify_chat_id = patch.exchange_notify_chat_id === null
      ? null
      : requireNonEmptyString(patch.exchange_notify_chat_id, "exchange-notify-chat-id");
  }
  if (patch.exchange_notify_max_per_cycle !== undefined) {
    next.exchange_notify_max_per_cycle = requirePositiveInteger(patch.exchange_notify_max_per_cycle, "exchange-notify-max-per-cycle");
  }
  if (patch.exchange_runner_enabled !== undefined) {
    next.exchange_runner_enabled = parseBool(patch.exchange_runner_enabled, "exchange-runner-enabled");
  }
  if (patch.exchange_runner_model !== undefined) {
    next.exchange_runner_model = requireClaudeModel(patch.exchange_runner_model, "exchange-runner-model");
  }
  if (patch.codex_runner_model !== undefined) {
    next.codex_runner_model = requireModelId(patch.codex_runner_model, "codex-runner-model");
  }
  if (patch.exchange_runner_max_attempts !== undefined) {
    next.exchange_runner_max_attempts = requirePositiveInteger(patch.exchange_runner_max_attempts, "exchange-runner-max-attempts");
  }
  if (patch.exchange_runner_timeout_seconds !== undefined) {
    next.exchange_runner_timeout_seconds = requirePositiveInteger(patch.exchange_runner_timeout_seconds, "exchange-runner-timeout-seconds");
  }
  if (patch.exchange_runner_daily_max !== undefined) {
    next.exchange_runner_daily_max = requireNonNegativeInteger(patch.exchange_runner_daily_max, "exchange-runner-daily-max");
  }
  if (patch.direct_send_memory !== undefined && parseBool(patch.direct_send_memory, "direct-send-memory")) {
    throw new Error("Refusing: direct-send memory context is not allowed in DS1");
  }
  if (patch.direct_send_allow_action_claims !== undefined && parseBool(patch.direct_send_allow_action_claims, "direct-send-allow-action-claims")) {
    throw new Error("Refusing: direct-send action claims are not allowed");
  }
  if (patch.direct_send_user_add !== undefined) {
    const id = requireNonEmptyString(patch.direct_send_user_add, "direct-send-user");
    next.direct_send_user_allowlist = Array.from(new Set([...(next.direct_send_user_allowlist || []), id]));
  }
  if (patch.v2_enabled !== undefined) {
    next.v2_enabled = parseBool(patch.v2_enabled, "v2-enabled");
  }
  if (patch.workspace_root !== undefined) {
    next.workspace_root = patch.workspace_root === null ? null : requireNonEmptyString(patch.workspace_root, "workspace-root");
  }
  if (patch.direct_send_user_remove !== undefined) {
    const id = requireNonEmptyString(patch.direct_send_user_remove, "direct-send-user-remove");
    next.direct_send_user_allowlist = (next.direct_send_user_allowlist || []).filter((u) => u !== id);
  }
  if (next.enabled && !next.require_approval) {
    throw new Error("Refusing to enable the loop without approval mode; set --require-approval true first");
  }
  if (next.memory_enabled && !next.default_repo) {
    throw new Error("Refusing to enable memory without a default repo; set --default-repo /path first");
  }
  return writeAgentConfig(agentHome, { ...config, telegram_codex_policy: normalizeTelegramCodexPolicy(next) });
}

function normalizeTelegramCodexPolicy(value) {
  const v = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    enabled: Boolean(v.enabled),
    require_approval: v.require_approval === undefined ? true : Boolean(v.require_approval),
    global_interval_seconds: positiveNumberOr(v.global_interval_seconds, DEFAULT_TELEGRAM_CODEX_POLICY.global_interval_seconds),
    per_chat_interval_seconds: positiveNumberOr(v.per_chat_interval_seconds, DEFAULT_TELEGRAM_CODEX_POLICY.per_chat_interval_seconds),
    max_model_calls_per_run: positiveIntegerOr(v.max_model_calls_per_run, DEFAULT_TELEGRAM_CODEX_POLICY.max_model_calls_per_run),
    default_repo: typeof v.default_repo === "string" && v.default_repo.trim() ? v.default_repo.trim() : null,
    history_messages: positiveIntegerOr(v.history_messages, DEFAULT_TELEGRAM_CODEX_POLICY.history_messages),
    context_max_chars: positiveIntegerOr(v.context_max_chars, DEFAULT_TELEGRAM_CODEX_POLICY.context_max_chars),
    memory_enabled: Boolean(v.memory_enabled),
    direct_send_enabled: Boolean(v.direct_send_enabled),
    direct_send_user_allowlist: Array.isArray(v.direct_send_user_allowlist)
      ? v.direct_send_user_allowlist.map(String).filter(Boolean).sort()
      : [],
    direct_send_max_chars: positiveIntegerOr(v.direct_send_max_chars, DEFAULT_TELEGRAM_CODEX_POLICY.direct_send_max_chars),
    direct_send_daily_max: nonNegativeIntegerOr(v.direct_send_daily_max, DEFAULT_TELEGRAM_CODEX_POLICY.direct_send_daily_max),
    direct_send_min_remaining_tokens: nonNegativeIntegerOr(v.direct_send_min_remaining_tokens, DEFAULT_TELEGRAM_CODEX_POLICY.direct_send_min_remaining_tokens),
    direct_send_trusted_qa_enabled: Boolean(v.direct_send_trusted_qa_enabled),
    direct_send_trusted_qa_max_chars: positiveIntegerOr(v.direct_send_trusted_qa_max_chars, DEFAULT_TELEGRAM_CODEX_POLICY.direct_send_trusted_qa_max_chars),
    owner_mode_enabled: Boolean(v.owner_mode_enabled),
    owner_low_risk_auto_plan_enabled: v.owner_low_risk_auto_plan_enabled === undefined
      ? DEFAULT_TELEGRAM_CODEX_POLICY.owner_low_risk_auto_plan_enabled
      : Boolean(v.owner_low_risk_auto_plan_enabled),
    exchange_notify_enabled: Boolean(v.exchange_notify_enabled),
    exchange_notify_chat_id: typeof v.exchange_notify_chat_id === "string" && v.exchange_notify_chat_id.trim() ? v.exchange_notify_chat_id.trim() : null,
    exchange_notify_max_per_cycle: positiveIntegerOr(v.exchange_notify_max_per_cycle, DEFAULT_TELEGRAM_CODEX_POLICY.exchange_notify_max_per_cycle),
    exchange_runner_enabled: Boolean(v.exchange_runner_enabled),
    exchange_runner_model: normalizeClaudeModel(v),
    codex_runner_model: typeof v.codex_runner_model === "string" && v.codex_runner_model.trim() && isModelId(v.codex_runner_model)
      ? v.codex_runner_model.trim()
      : DEFAULT_TELEGRAM_CODEX_POLICY.codex_runner_model,
    exchange_runner_max_attempts: positiveIntegerOr(v.exchange_runner_max_attempts, DEFAULT_TELEGRAM_CODEX_POLICY.exchange_runner_max_attempts),
    exchange_runner_timeout_seconds: positiveIntegerOr(v.exchange_runner_timeout_seconds, DEFAULT_TELEGRAM_CODEX_POLICY.exchange_runner_timeout_seconds),
    exchange_runner_daily_max: nonNegativeIntegerOr(v.exchange_runner_daily_max, DEFAULT_TELEGRAM_CODEX_POLICY.exchange_runner_daily_max),
    v2_enabled: Boolean(v.v2_enabled),
    workspace_root: typeof v.workspace_root === "string" && v.workspace_root.trim() ? v.workspace_root.trim() : null,
    // DS1: these are hard-forced off regardless of stored value.
    direct_send_memory: false,
    direct_send_allow_action_claims: false,
    direct_send_classes: normalizeDirectSendClasses(v.direct_send_classes),
  };
}

function normalizeDirectSendClasses(value) {
  if (!Array.isArray(value)) {
    return [...DEFAULT_TELEGRAM_CODEX_POLICY.direct_send_classes];
  }
  const kept = value.map(String).filter((c) => DIRECT_SEND_CLASSES.includes(c));
  return Array.from(new Set(kept));
}

function nonNegativeIntegerOr(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

function requireNonNegativeInteger(value, name) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`--${name} must be a non-negative integer`);
  }
  return n;
}

function requireNonEmptyString(value, name) {
  const s = String(value ?? "").trim();
  if (!s) {
    throw new Error(`--${name} must be a non-empty value`);
  }
  return s;
}

function requireModelId(value, name) {
  const s = String(value ?? "").trim();
  if (!s) {
    return "";
  }
  if (!isModelId(s)) {
    throw new Error(`--${name} contains invalid characters`);
  }
  return s;
}

function isModelId(value) {
  return /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(String(value || "").trim());
}

function requireClaudeModel(value, name) {
  const s = String(value ?? "").trim();
  if (!s || s === "sonnet" || s === "opus") {
    return s;
  }
  throw new Error(`--${name} must be default, sonnet, or opus`);
}

function normalizeClaudeModel(value) {
  if (!Object.hasOwn(value, "exchange_runner_model")) {
    return DEFAULT_TELEGRAM_CODEX_POLICY.exchange_runner_model;
  }
  const raw = value.exchange_runner_model;
  if (typeof raw !== "string") {
    return DEFAULT_TELEGRAM_CODEX_POLICY.exchange_runner_model;
  }
  const model = raw.trim();
  return model === "sonnet" || model === "opus" || model === ""
    ? model
    : DEFAULT_TELEGRAM_CODEX_POLICY.exchange_runner_model;
}

function parseBool(value, name) {
  if (typeof value === "boolean") {
    return value;
  }
  const normalized = String(value).trim().toLowerCase();
  if (normalized === "true") {
    return true;
  }
  if (normalized === "false") {
    return false;
  }
  throw new Error(`--${name} must be true or false`);
}

function requirePositiveNumber(value, name) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`--${name} must be a positive number`);
  }
  return n;
}

function requirePositiveInteger(value, name) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`--${name} must be a positive integer`);
  }
  return n;
}

function positiveNumberOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function positiveIntegerOr(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function defaultConfig() {
  return {
    kill_switch: false,
    daily_token_budget: DEFAULT_DAILY_TOKEN_BUDGET,
    primary_agent_id: DEFAULT_PRIMARY_AGENT_ID,
    gateway_allowlist: [],
    exchange_agents: [],
    telegram_codex_policy: { ...DEFAULT_TELEGRAM_CODEX_POLICY },
  };
}

export function getPrimaryAgentId(agentHome) {
  return readAgentConfig(agentHome).primary_agent_id || DEFAULT_PRIMARY_AGENT_ID;
}

function normalizeConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return closedConfig("invalid_config");
  }
  const dailyTokenBudget = Number(config?.daily_token_budget);
  if (config && Object.hasOwn(config, "daily_token_budget") && (!Number.isFinite(dailyTokenBudget) || dailyTokenBudget < 0)) {
    return closedConfig("invalid_daily_token_budget");
  }
  return {
    kill_switch: Boolean(config?.kill_switch),
    daily_token_budget: Number.isFinite(dailyTokenBudget) && dailyTokenBudget >= 0
      ? Math.floor(dailyTokenBudget)
      : DEFAULT_DAILY_TOKEN_BUDGET,
    primary_agent_id: VALID_AGENT_ID.test(String(config?.primary_agent_id || ""))
      ? String(config.primary_agent_id)
      : DEFAULT_PRIMARY_AGENT_ID,
    gateway_allowlist: Array.isArray(config.gateway_allowlist)
      ? config.gateway_allowlist.map(String).filter(Boolean).sort()
      : [],
    exchange_agents: normalizeExchangeAgents(config.exchange_agents),
    telegram_codex_policy: normalizeTelegramCodexPolicy(config.telegram_codex_policy),
  };
}

function isDisabledBudget(value) {
  return /^(?:disabled|off|none|unlimited)$/i.test(String(value ?? "").trim());
}

function closedConfig(configError) {
  return {
    kill_switch: true,
    daily_token_budget: 0,
    primary_agent_id: DEFAULT_PRIMARY_AGENT_ID,
    gateway_allowlist: [],
    exchange_agents: [],
    telegram_codex_policy: { ...DEFAULT_TELEGRAM_CODEX_POLICY },
    config_error: configError,
  };
}

function normalizeUserId(userId) {
  const normalized = String(userId || "").trim();
  if (!normalized) {
    throw new Error("Missing gateway user id");
  }
  return normalized;
}

function normalizeExchangeAgents(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  const agents = new Map();
  for (const entry of value) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    try {
      const agent_id = normalizeAgentId(entry.agent_id);
      agents.set(agent_id, {
        agent_id,
        kind: normalizeAgentKind(entry.kind || "manual"),
        enabled: Boolean(entry.enabled),
      });
    } catch {
      continue;
    }
  }
  return Array.from(agents.values()).sort((a, b) => a.agent_id.localeCompare(b.agent_id));
}

function normalizeAgentId(agentId) {
  const normalized = String(agentId || "").trim();
  if (!VALID_AGENT_ID.test(normalized)) {
    throw new Error("Invalid exchange agent id");
  }
  return normalized;
}

function normalizeAgentKind(kind) {
  const normalized = String(kind || "manual").trim();
  if (!VALID_AGENT_ID.test(normalized)) {
    throw new Error("Invalid exchange agent kind");
  }
  return normalized;
}

function dayKey(now) {
  return now.toISOString().slice(0, 10);
}
