import { approveDispatch, rejectDispatch } from "../agent/dispatch.js";
import { getRegisteredAgent } from "../agent/registry.js";
import { getPrimaryAgentId, getTelegramCodexPolicy, disableExchangeAgent, enableExchangeAgent, readAgentConfig, setKillSwitch } from "../agent/safety.js";
import { killSession } from "../agent/sessions.js";
import { stopAllTurns } from "../agent/v2/kill.js";

export async function handleWebAction({ agentHome, pathname, body }) {
  const route = actionRoute(pathname);
  if (!route) return { status: 404, value: { error: "not_found" } };
  if (body.confirm !== route.confirm) return { status: 400, value: { error: "confirmation_required" } };
  try {
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

function matchId(pathname, pattern) {
  const match = pathname.match(pattern);
  if (!match) return null;
  try { return decodeURIComponent(match[1]); } catch { return null; }
}
