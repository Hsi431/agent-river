import { approveDispatch, rejectDispatch } from "../agent/dispatch.js";
import { runCodexExchangeRunnerOnce } from "../agent/codex-exchange-runner.js";
import { runExchangeRunnerOnce } from "../agent/exchange-runner.js";
import { runExecRunnerOnce } from "../agent/exec-runner.js";
import { submitOwnerMailboxMessage } from "../agent/owner-mailbox.js";
import { getRegisteredAgent } from "../agent/registry.js";
import { getPrimaryAgentId, getTelegramCodexPolicy, disableExchangeAgent, enableExchangeAgent, readAgentConfig, setKillSwitch } from "../agent/safety.js";
import { killSession } from "../agent/sessions.js";
import { stopAllTurns } from "../agent/v2/kill.js";
import { resolveRepo } from "../agent/v2/repo-resolver.js";

const REQUEST_FIELDS = new Set(["target", "subject", "request", "repo"]);

export async function handleWebAction({ agentHome, pathname, body, repoDir = process.cwd(), runnerNudge = requestManagedRunnerNudge }) {
  const route = actionRoute(pathname);
  if (!route) return { status: 404, value: { error: "not_found" } };
  if (route.confirm && body.confirm !== route.confirm) return { status: 400, value: { error: "confirmation_required" } };
  try {
    if (route.kind === "request") {
      return submitWebRequest({ agentHome, body, repoDir, runnerNudge });
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
  if (pathname === "/api/stop") return { kind: "stop", confirm: "stop_all" };
  const archive = matchId(pathname, /^\/api\/inbox\/([^/]+)\/archive$/);
  if (archive !== null) return { kind: "archive", id: archive, confirm: "archive" };
  for (const [pattern, kind, confirm] of [
    [/^\/api\/dispatch\/([^/]+)\/approve$/, "dispatch-approve", "approve"],
    [/^\/api\/dispatch\/([^/]+)\/reject$/, "dispatch-reject", "reject"],
    [/^\/api\/sessions\/([^/]+)\/kill$/, "session-kill", "kill"],
    [/^\/api\/agents\/([^/]+)\/enable$/, "agent-enable", "enable"],
    [/^\/api\/agents\/([^/]+)\/disable$/, "agent-disable", "disable"],
  ]) {
    const id = matchId(pathname, pattern);
    if (id !== null) return { kind, id, confirm };
  }
  return null;
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
