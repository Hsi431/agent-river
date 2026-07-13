import { approveDispatch, rejectDispatch } from "../agent/dispatch.js";
import { runCodexExchangeRunnerOnce } from "../agent/codex-exchange-runner.js";
import { runExchangeRunnerOnce } from "../agent/exchange-runner.js";
import { runExecRunnerOnce } from "../agent/exec-runner.js";
import { broadcastOwnerSessionMessage, kickoffSession } from "../agent/exchange.js";
import { submitOwnerMailboxMessage } from "../agent/owner-mailbox.js";
import { getRegisteredAgent } from "../agent/registry.js";
import { getPrimaryAgentId, getTelegramCodexPolicy, disableExchangeAgent, enableExchangeAgent, readAgentConfig, setKillSwitch } from "../agent/safety.js";
import { killSession, openSession } from "../agent/sessions.js";
import { stopAllTurns } from "../agent/v2/kill.js";
import { resolveRepo } from "../agent/v2/repo-resolver.js";

const REQUEST_FIELDS = new Set(["target", "subject", "request", "repo"]);
const SESSION_FIELDS = new Set(["participants", "topic", "repo", "budgetMessages", "budgetMinutes"]);
const SESSION_MESSAGE_FIELDS = new Set(["message"]);

export async function handleWebAction({ agentHome, pathname, body, repoDir = process.cwd(), runnerNudge = requestManagedRunnerNudge }) {
  const route = actionRoute(pathname);
  if (!route) return { status: 404, value: { error: "not_found" } };
  if (route.confirm && body.confirm !== route.confirm) return { status: 400, value: { error: "confirmation_required" } };
  try {
    if (route.kind === "request") {
      return submitWebRequest({ agentHome, body, repoDir, runnerNudge });
    }
    if (route.kind === "session-create") {
      return createWebSession({ agentHome, body });
    }
    if (route.kind === "session-message") {
      return addWebSessionMessage({ agentHome, sessionId: route.id, body });
    }
    if (route.kind === "dispatch-approve") {
      const defaultRepo = getTelegramCodexPolicy(agentHome).default_repo;
      const result = approveDispatch({ agentHome, id: route.id, approvedBy: "owner", defaultRepo });
      return { status: 200, value: { ok: true, ...result } };
    }
    if (route.kind === "dispatch-reject") {
      const result = rejectDispatch({ agentHome, id: route.id, rejectedBy: "owner" });
      return { status: 200, value: { ok: true, ...result } };
    }
    if (route.kind === "session-kill") {
      return { status: 200, value: { ok: true, session: killSession({ agentHome, id: route.id }) } };
    }
    if (route.kind === "agent-enable" || route.kind === "agent-disable") {
      if (route.id === getPrimaryAgentId(agentHome)) {
        return { status: 409, value: { error: "primary_agent_routing_is_fixed" } };
      }
      const registered = getRegisteredAgent(agentHome, route.id);
      const configured = (readAgentConfig(agentHome).exchange_agents || []).find((agent) => agent.agent_id === route.id) || null;
      if (route.kind === "agent-enable") {
        const eligible = registered?.status === "active" || (!registered && configured?.kind === "manual");
        if (!eligible) return { status: 409, value: { error: "agent_routing_not_eligible" } };
        enableExchangeAgent(agentHome, { agentId: route.id, kind: configured?.kind || "manual" });
      } else {
        if (!configured) return { status: 409, value: { error: "dispatch_route_not_configured" } };
        disableExchangeAgent(agentHome, route.id);
      }
      return { status: 200, value: { ok: true, agent: route.id, dispatchRouteEnabled: route.kind === "agent-enable" } };
    }
    if (route.kind === "stop") {
      setKillSwitch(agentHome, true);
      const stopped = await stopAllTurns();
      return {
        status: 200,
        value: {
          ok: true,
          killSwitch: true,
          processLocalStoppedTurnIds: stopped,
          crossProcessTermination: false,
          limitation: "The persistent kill switch blocks new work, but this process cannot synchronously terminate turns owned by other processes.",
        },
      };
    }
    return { status: 501, value: { error: "not_implemented", reason: "No archive metadata ledger exists." } };
  } catch (error) {
    return { status: 409, value: { error: "action_failed", message: String(error?.message || "Action failed") } };
  }
}

export function isWebActionPath(pathname) {
  return Boolean(actionRoute(pathname));
}

function actionRoute(pathname) {
  if (pathname === "/api/requests") return { kind: "request", confirm: null };
  if (pathname === "/api/sessions") return { kind: "session-create", confirm: null };
  if (pathname === "/api/stop") return { kind: "stop", confirm: "stop_all" };
  const archive = matchId(pathname, /^\/api\/inbox\/([^/]+)\/archive$/);
  if (archive !== null) return { kind: "archive", id: archive, confirm: "archive" };
  for (const [pattern, kind, confirm] of [
    [/^\/api\/dispatch\/([^/]+)\/approve$/, "dispatch-approve", "approve"],
    [/^\/api\/dispatch\/([^/]+)\/reject$/, "dispatch-reject", "reject"],
    [/^\/api\/sessions\/([^/]+)\/messages$/, "session-message", null],
    [/^\/api\/sessions\/([^/]+)\/kill$/, "session-kill", "kill"],
    [/^\/api\/agents\/([^/]+)\/enable$/, "agent-enable", "enable"],
    [/^\/api\/agents\/([^/]+)\/disable$/, "agent-disable", "disable"],
  ]) {
    const id = matchId(pathname, pattern);
    if (id !== null) return { kind, id, confirm };
  }
  return null;
}

async function createWebSession({ agentHome, body }) {
  const invalid = invalidSessionBody(body);
  if (invalid) return invalid;
  try {
    const session = await openSession({
      agentHome,
      initiator: "owner",
      participants: [...new Set(body.participants.map((participant) => participant.trim()))],
      topic: body.topic.trim(),
      repo: body.repo?.trim() || null,
      budgetMessages: optionalPositiveInteger(body.budgetMessages),
      budgetMinutes: optionalPositiveInteger(body.budgetMinutes),
    });
    const kickoff = kickoffSession({ agentHome, session });
    return {
      status: 201,
      value: {
        ok: true,
        sessionId: session.session_id,
        session: kickoff.session || session,
        kickoff: { sent: kickoff.sent, messageIds: kickoff.messages.map((message) => message.id) },
      },
    };
  } catch (error) {
    return { status: 400, value: { error: error?.code || "invalid_session", message: String(error?.message || "Invalid session") } };
  }
}

function addWebSessionMessage({ agentHome, sessionId, body }) {
  const unknownField = Object.keys(body).find((field) => !SESSION_MESSAGE_FIELDS.has(field));
  if (unknownField) return { status: 400, value: { error: "invalid_field", field: unknownField } };
  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message) return { status: 400, value: { error: "message_required" } };
  try {
    const broadcast = broadcastOwnerSessionMessage({ agentHome, sessionId, text: message });
    return {
      status: 201,
      value: {
        ok: true,
        sessionId: broadcast.session.session_id,
        sent: broadcast.sent,
        messageIds: broadcast.messages.map((entry) => entry.id),
      },
    };
  } catch (error) {
    const status = error?.code === "session_not_found" ? 404 : error?.code === "session_not_active" ? 409 : 400;
    return { status, value: { error: error?.code || "invalid_session_message", message: String(error?.message || "Invalid session message") } };
  }
}

function invalidSessionBody(body) {
  const unknownField = Object.keys(body).find((field) => !SESSION_FIELDS.has(field));
  if (unknownField) return { status: 400, value: { error: "invalid_field", field: unknownField } };
  if (!Array.isArray(body.participants) || body.participants.some((participant) => typeof participant !== "string")) {
    return { status: 400, value: { error: "invalid_participants" } };
  }
  const participants = new Set(body.participants.map((participant) => participant.trim()).filter(Boolean));
  if (participants.size < 2) return { status: 400, value: { error: "invalid_participants" } };
  if (typeof body.topic !== "string" || !body.topic.trim()) return { status: 400, value: { error: "topic_required" } };
  if (body.repo != null && typeof body.repo !== "string") return { status: 400, value: { error: "invalid_repo" } };
  for (const field of ["budgetMessages", "budgetMinutes"]) {
    if (body[field] !== undefined && body[field] !== "" && optionalPositiveInteger(body[field]) === null) {
      return { status: 400, value: { error: "invalid_budget", field } };
    }
  }
  return null;
}

function optionalPositiveInteger(value) {
  if (value === undefined || value === "") return undefined;
  if (typeof value === "number") return Number.isSafeInteger(value) && value > 0 ? value : null;
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

async function submitWebRequest({ agentHome, body, repoDir, runnerNudge }) {
  const unknownField = Object.keys(body).find((field) => !REQUEST_FIELDS.has(field));
  if (unknownField) return { status: 400, value: { error: "invalid_field", field: unknownField } };

  const target = typeof body.target === "string" ? body.target.trim() : "";
  const request = typeof body.request === "string" ? body.request.trim() : "";
  const subject = body.subject == null ? "" : typeof body.subject === "string" ? body.subject.trim() : null;
  const requestedRepo = body.repo == null ? "" : typeof body.repo === "string" ? body.repo.trim() : null;
  if (!/^[a-z][a-z0-9_-]*$/.test(target)) return { status: 400, value: { error: "invalid_target" } };
  if (!request) return { status: 400, value: { error: "request_required" } };
  if (subject === null || subject.length > 120) return { status: 400, value: { error: "invalid_subject" } };
  if (requestedRepo === null) return { status: 400, value: { error: "invalid_repo" } };

  let resolvedRepo = null;
  if (requestedRepo) {
    const policy = getTelegramCodexPolicy(agentHome);
    const resolved = await resolveRepo({
      workspaceRoot: policy.workspace_root,
      defaultRepo: policy.default_repo,
      input: `repo=${requestedRepo}`,
    });
    if (!resolved.ok) return { status: 400, value: { error: "invalid_repo", reason: resolved.reason } };
    resolvedRepo = resolved.toplevel;
  }

  const result = submitOwnerMailboxMessage({
    agentHome,
    to: target,
    text: request,
    subject: subject || null,
    repo: resolvedRepo,
    channel: "web",
    allowPrimary: true,
    requireActiveTarget: true,
  });
  if (!result.ok) return { status: 409, value: { error: "target_not_eligible" } };

  const nudge = runnerNudge({ agentHome, target, repoDir });
  return {
    status: 201,
    value: { ok: true, queued: true, messageId: result.message.id, target, nudge },
  };
}

function requestManagedRunnerNudge({ agentHome, target, repoDir }) {
  let promise = null;
  if (target === "opus") promise = runExchangeRunnerOnce({ agentHome, repoDir });
  else if (target === "codex") promise = runCodexExchangeRunnerOnce({ agentHome, repoDir });
  else if (getRegisteredAgent(agentHome, target)?.style === "exec") promise = runExecRunnerOnce({ agentHome, repoDir });
  if (!promise) return { status: "not_managed", managed: false };
  void Promise.resolve(promise).catch(() => {});
  return { status: "requested", managed: true };
}

function matchId(pathname, pattern) {
  const match = pathname.match(pattern);
  if (!match) return null;
  try { return decodeURIComponent(match[1]); } catch { return null; }
}
