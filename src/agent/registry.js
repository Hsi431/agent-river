import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { agentPaths } from "./paths.js";
import { getPrimaryAgentId, readAgentConfig } from "./safety.js";

export const VALID_AGENT_NAME = /^[a-z][a-z0-9_-]*$/;
const VALID_STYLES = new Set(["poll", "spawn"]);
const VALID_STATUSES = new Set(["pending", "active", "rejected"]);
const VALID_CAPABILITIES = new Set(["read", "write"]);

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

export function joinAgentRegistry({ agentHome, name, style, capabilities, now = new Date() }) {
  const agentName = normalizeAgentName(name);
  const registry = readAgentRegistry(agentHome);
  const existing = registry.agents[agentName];
  if (existing && (existing.status === "pending" || existing.status === "active")) {
    throw new Error(`Agent already registered: ${agentName}`);
  }
  registry.agents[agentName] = {
    name: agentName,
    style: normalizeStyle(style),
    capabilities: normalizeCapabilities(capabilities),
    status: "pending",
    requested_at: now.toISOString(),
    approved_at: null,
  };
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
  const token = randomBytes(32).toString("hex");
  writeAgentToken(agentHome, agentName, token);
  registry.agents[agentName] = {
    ...agent,
    status: "active",
    approved_at: now.toISOString(),
  };
  writeAgentRegistry(agentHome, registry);
  return { agent: registry.agents[agentName], token_file: agentTokenPath(agentHome, agentName) };
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
    throw new Error("--style must be poll or spawn");
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
