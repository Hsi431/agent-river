import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { agentPaths } from "./paths.js";
import { getPrimaryAgentId, readAgentConfig } from "./safety.js";

export const VALID_AGENT_NAME = /^[a-z][a-z0-9_-]*$/;
const VALID_STYLES = new Set(["poll", "spawn", "exec"]);
const VALID_STATUSES = new Set(["pending", "active", "rejected"]);
const VALID_CAPABILITIES = new Set(["read", "write"]);
const DEFAULT_EXEC_TIMEOUT_SECONDS = 300;

export function readAgentRegistry(agentHome) {
  const file = agentPaths(agentHome).agentRegistry;
  if (!fs.existsSync(file)) {
    return { agents: {} };
  }
  try {
    return normalizeRegistry(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch {
    return { agents: {} };
  }
}

export function writeAgentRegistry(agentHome, registry) {
  const file = agentPaths(agentHome).agentRegistry;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const normalized = normalizeRegistry(registry);
  fs.writeFileSync(file, `${JSON.stringify(normalized, null, 2)}\n`);
  return normalized;
}

export function listRegisteredAgents(agentHome) {
  return Object.values(readAgentRegistry(agentHome).agents)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function getRegisteredAgent(agentHome, name) {
  return readAgentRegistry(agentHome).agents[String(name || "").trim()] || null;
}

export function isActivePollAgent(agentHome, name) {
  const agent = getRegisteredAgent(agentHome, name);
  return agent?.status === "active" && agent.style === "poll";
}

export function isActiveRegisteredAgent(agentHome, name) {
  const agent = getRegisteredAgent(agentHome, name);
  return agent?.status === "active";
}

export function joinAgentRegistry({ agentHome, name, style, capabilities, execCommand, execTimeoutSeconds, execCwd, now = new Date() }) {
  const agentName = normalizeAgentName(name);
  const normalizedStyle = normalizeStyle(style);
  const registry = readAgentRegistry(agentHome);
  const existing = registry.agents[agentName];
  if (existing && (existing.status === "pending" || existing.status === "active")) {
    throw new Error(`Agent already registered: ${agentName}`);
  }
  if (normalizedStyle !== "exec" && (execCommand || execTimeoutSeconds || execCwd)) {
    throw new Error("--exec, --exec-timeout-seconds, and --exec-cwd are only valid with --style exec");
  }
  const agent = {
    name: agentName,
    style: normalizedStyle,
    capabilities: normalizeCapabilities(capabilities || (normalizedStyle === "exec" ? "read" : "")),
    status: "pending",
    requested_at: now.toISOString(),
    approved_at: null,
  };
  if (normalizedStyle === "exec") {
    agent.exec_command = normalizeExecCommand(execCommand);
    agent.exec_timeout_seconds = normalizeExecTimeoutSeconds(execTimeoutSeconds);
    agent.exec_cwd = normalizeExecCwd(execCwd);
  }
  registry.agents[agentName] = agent;
  return writeAgentRegistry(agentHome, registry).agents[agentName];
}

export function seedSpawnAgents({ agentHome, now = new Date() }) {
  const registry = readAgentRegistry(agentHome);
  const seeded = [];
  const seen = new Set();
  const add = (name) => {
    const agentName = normalizeAgentName(name);
    if (seen.has(agentName)) {
      return;
    }
    seen.add(agentName);
    registry.agents[agentName] = {
      ...(registry.agents[agentName] || {}),
      name: agentName,
      style: "spawn",
      capabilities: normalizeCapabilities(registry.agents[agentName]?.capabilities || "read,write"),
      status: "active",
      requested_at: registry.agents[agentName]?.requested_at || now.toISOString(),
      approved_at: registry.agents[agentName]?.approved_at || now.toISOString(),
    };
    seeded.push(agentName);
  };

  add(getPrimaryAgentId(agentHome));
  for (const agent of readAgentConfig(agentHome).exchange_agents || []) {
    if (agent?.enabled && agent.agent_id && agent.agent_id !== "any") {
      add(agent.agent_id);
    }
  }

  writeAgentRegistry(agentHome, registry);
  return { seeded };
}

export function approveAgentRegistration({ agentHome, name, now = new Date(), randomBytes = crypto.randomBytes }) {
  const agentName = normalizeAgentName(name);
  const registry = readAgentRegistry(agentHome);
  const agent = registry.agents[agentName];
  if (!agent || agent.status !== "pending") {
    throw new Error(`Pending agent registration not found: ${agentName}`);
  }
  let tokenFile = null;
  if (agent.style === "poll") {
    const token = randomBytes(32).toString("hex");
    writeAgentToken(agentHome, agentName, token);
    tokenFile = agentTokenPath(agentHome, agentName);
  }
  registry.agents[agentName] = {
    ...agent,
    status: "active",
    approved_at: now.toISOString(),
  };
  writeAgentRegistry(agentHome, registry);
  return { agent: registry.agents[agentName], token_file: tokenFile };
}

export function rejectAgentRegistration({ agentHome, name, now = new Date() }) {
  const agentName = normalizeAgentName(name);
  const registry = readAgentRegistry(agentHome);
  const agent = registry.agents[agentName];
  if (!agent || agent.status !== "pending") {
    throw new Error(`Pending agent registration not found: ${agentName}`);
  }
  registry.agents[agentName] = {
    ...agent,
    status: "rejected",
    approved_at: now.toISOString(),
  };
  return writeAgentRegistry(agentHome, registry).agents[agentName];
}

export function verifyAgentToken(agentHome, name, token) {
  const agentName = normalizeAgentName(name);
  let expected;
  try {
    expected = fs.readFileSync(agentTokenPath(agentHome, agentName), "utf8").trim();
  } catch {
    return false;
  }
  const provided = String(token || "").trim();
  const expectedBuffer = Buffer.from(expected, "utf8");
  const providedBuffer = Buffer.from(provided, "utf8");
  if (expectedBuffer.length !== providedBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(expectedBuffer, providedBuffer);
}

export function agentTokenPath(agentHome, name) {
  return path.join(agentPaths(agentHome).agentTokensDir, `${normalizeAgentName(name)}.token`);
}

function writeAgentToken(agentHome, name, token) {
  const dir = agentPaths(agentHome).agentTokensDir;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const file = agentTokenPath(agentHome, name);
  fs.writeFileSync(file, `${token}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

function normalizeRegistry(value) {
  const agents = {};
  const rows = value && typeof value === "object" && !Array.isArray(value)
    ? Object.values(value.agents || {})
    : [];
  for (const row of rows) {
    const agent = normalizeAgent(row);
    if (agent) {
      agents[agent.name] = agent;
    }
  }
  return { agents };
}

function normalizeAgent(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const name = String(value.name || "").trim();
  if (!VALID_AGENT_NAME.test(name)) {
    return null;
  }
  const status = String(value.status || "").trim();
  return {
    name,
    style: VALID_STYLES.has(value.style) ? value.style : "poll",
    capabilities: normalizeCapabilities(value.capabilities || "read"),
    status: VALID_STATUSES.has(status) ? status : "pending",
    requested_at: typeof value.requested_at === "string" ? value.requested_at : null,
    approved_at: typeof value.approved_at === "string" ? value.approved_at : null,
    ...(value.style === "exec" ? {
      exec_command: normalizeExecCommand(value.exec_command),
      exec_timeout_seconds: normalizeExecTimeoutSeconds(value.exec_timeout_seconds),
      exec_cwd: normalizeExecCwd(value.exec_cwd),
    } : {}),
  };
}

function normalizeAgentName(value) {
  const name = String(value || "").trim();
  if (!VALID_AGENT_NAME.test(name)) {
    throw new Error("Invalid agent name");
  }
  return name;
}

function normalizeStyle(value) {
  const style = String(value || "").trim();
  if (!VALID_STYLES.has(style)) {
    throw new Error("--style must be poll, spawn, or exec");
  }
  return style;
}

function normalizeCapabilities(value) {
  const raw = Array.isArray(value) ? value : String(value || "").split(",");
  const out = raw.map((item) => String(item || "").trim()).filter(Boolean);
  if (out.length === 0 || out.some((item) => !VALID_CAPABILITIES.has(item)) || !out.includes("read")) {
    throw new Error("--capabilities must be read or read,write");
  }
  return Array.from(new Set(out)).sort();
}

function normalizeExecCommand(value) {
  const command = String(value || "").trim();
  if (!command) {
    throw new Error("--exec is required for --style exec");
  }
  return command;
}

function normalizeExecTimeoutSeconds(value) {
  if (value === undefined || value === null || value === "") {
    return DEFAULT_EXEC_TIMEOUT_SECONDS;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error("--exec-timeout-seconds must be a positive integer");
  }
  return parsed;
}

function normalizeExecCwd(value) {
  const cwd = String(value || "").trim();
  return cwd || null;
}
