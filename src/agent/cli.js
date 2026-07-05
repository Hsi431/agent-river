import fs from "node:fs";
import { parseArgs, requireArg, validateValueOptions } from "../lib/args.js";
import { resolveStateHome } from "../lib/paths.js";
import { buildOpusRunnerService, writeOpusRunnerService, opusRunnerServiceStatus, buildOpusRunnerSettings, writeOpusRunnerSettings, buildOpusEditSettings, writeOpusEditSettings, buildCodexRunnerService, writeCodexRunnerService, codexRunnerServiceStatus, buildDashboardService, writeDashboardService, dashboardServiceStatus } from "./service.js";
import {
  claimExchangeMessage,
  exchangeStatus,
  getExchangeThread,
  listExchangeReplies,
  listExchangeInbox,
  pruneExchangeState,
  releaseExchangeClaim,
  replyExchangeMessage,
  submitExchangeMessage,
} from "./exchange.js";
import { runExchangeRunnerOnce, defaultRunnerSettingsPath, runnerSessionStatus } from "./exchange-runner.js";
import { runCodexExchangeRunnerOnce } from "./codex-exchange-runner.js";
import { getSession, killSession, listActiveSessions, openSession } from "./sessions.js";
import { getRegisteredAgent, isActivePollAgent, joinAgentRegistry, listRegisteredAgents, seedSpawnAgents, verifyAgentToken } from "./registry.js";
import { handleGatewayMessage } from "./gateway.js";
import { approveAgentTask, getAgentStatus, rejectAgentTask, runAgentOnce, submitAgentTask } from "./orchestrator.js";
import { resolveAgentHome } from "./paths.js";
import { allowGatewayUser, denyGatewayUser, disableExchangeAgent, enableExchangeAgent, getSafetyStatus, getTelegramCodexPolicy, setDailyTokenBudget, setKillSwitch, setTelegramCodexPolicy } from "./safety.js";
import { handleTelegramUpdate, parseTelegramUpdateJson, pollTelegramOnce } from "./telegram.js";
import { getDispatchApproval, listDispatchApprovals } from "./dispatch.js";
import { dashboardBridge, dashboardOnce } from "./dashboard/bot.js";

export async function runAgentCli(argv) {
  if (argv[0] === "--help" || argv[0] === "-h") {
    return printHelp();
  }

  const [command, ...rest] = argv;
  const args = parseArgs(rest);
  validateValueOptions(args, ["agent", "budget-messages", "budget-minutes", "capabilities", "channel", "chat-id", "codex-runner-model", "dashboard-chat-id", "days", "default-repo", "dir", "exchange-notify-chat-id", "exchange-notify-enabled", "exchange-notify-max-per-cycle", "exchange-runner-daily-max", "exchange-runner-enabled", "exchange-runner-max-attempts", "exchange-runner-model", "exchange-runner-timeout-seconds", "from", "from-file", "id", "initiator", "interval-seconds", "kind", "lease-seconds", "long-poll-seconds", "max-cycles", "max-runtime-seconds", "memory-enabled", "memory-state", "name", "participants", "repo", "request", "session", "settings", "sleep-seconds", "state", "style", "text", "thread", "to", "token-file", "tokens", "topic", "transport", "update-json", "user", "v2-enabled", "workspace-root", "write-access"]);
  const agentHome = resolveAgentHome(args.state, { create: command !== "status" });

  switch (command) {
    case "submit":
      return printResult({
        task: submitAgentTask({
          agentHome,
          repo: requireArg(args, "repo"),
          request: requireArg(args, "request"),
          mode: args.mode || "plan",
        }),
      });
    case "status":
      return printResult(getAgentStatus({ agentHome, id: args._[0] }));
    case "run":
      return printResult(await runAgentOnce({
        agentHome,
        memoryStateHome: args["memory-state"]
          ? await resolveStateHome(args["memory-state"], { create: false })
          : undefined,
      }));
    case "approve":
      return printResult({ task: approveAgentTask({ agentHome, id: requireTaskId(args) }) });
    case "reject":
      return printResult({ task: rejectAgentTask({ agentHome, id: requireTaskId(args) }) });
    case "exchange-submit":
      requirePollAgentTokenIfNeeded({ agentHome, name: requireArg(args, "from"), tokenFile: args["token-file"] });
      return printResult({
        message: submitExchangeMessage({
          agentHome,
          from: requireArg(args, "from"),
          to: args.to || "any",
          channel: args.channel || "cli",
          threadId: args.thread,
          sessionId: args.session || null,
          text: resolveReplyText(args),
        }),
      });
    case "session-open":
      requireSessionInitiatorTokenIfNeeded({ agentHome, initiator: requireArg(args, "initiator"), tokenFile: args["token-file"] });
      return printResult({
        session: await openSession({
          agentHome,
          initiator: requireArg(args, "initiator"),
          participants: requireArg(args, "participants"),
          repo: args.repo || null,
          budgetMessages: args["budget-messages"],
          budgetMinutes: args["budget-minutes"],
          writeAccess: args["write-access"],
          topic: requireArg(args, "topic"),
        }),
      });
    case "session-list":
      return printResult({ sessions: listActiveSessions(agentHome) });
    case "session-show":
      return printResult({ session: requireSession(agentHome, requireArg(args, "id")) });
    case "session-kill":
      return printResult({ session: killSession({ agentHome, id: requireArg(args, "id") }) });
    case "exchange-inbox":
      if (args.agent) {
        requirePollAgentTokenIfNeeded({ agentHome, name: args.agent, tokenFile: args["token-file"] });
      }
      return printResult({ messages: listExchangeInbox(agentHome, { agent: args.agent }) });
    case "exchange-replies":
      return printResult({ replies: listExchangeReplies(agentHome, { agent: requireArg(args, "agent"), threadId: args.thread }) });
    case "exchange-thread":
      return printResult(getExchangeThread(agentHome, requireArg(args, "id")));
    case "exchange-claim":
      requirePollAgentTokenIfNeeded({ agentHome, name: requireArg(args, "agent"), tokenFile: args["token-file"] });
      return printResult({
        message: claimExchangeMessage({
          agentHome,
          id: requireArg(args, "id"),
          agent: requireArg(args, "agent"),
          leaseSeconds: args["lease-seconds"] || undefined,
        }),
      });
    case "exchange-release":
      return printResult(releaseExchangeClaim({
        agentHome,
        id: requireArg(args, "id"),
        agent: requireArg(args, "agent"),
      }));
    case "exchange-reply":
      requirePollAgentTokenIfNeeded({ agentHome, name: requireArg(args, "agent"), tokenFile: args["token-file"] });
      return printResult(replyExchangeMessage({
        agentHome,
        id: requireArg(args, "id"),
        agent: requireArg(args, "agent"),
        text: resolveReplyText(args),
      }));
    case "exchange-prune":
      return printResult(pruneExchangeState({ agentHome, days: requireArg(args, "days") }));
    case "exchange-status":
      return printResult(exchangeStatus(agentHome));
    case "dispatch-list":
      return printResult({ dispatches: filterDispatchApprovals(listDispatchApprovals(agentHome), args.status) });
    case "dispatch-show":
      return printResult({ dispatch: getDispatchApproval(agentHome, requireArg(args, "id")) });
    case "exchange-runner": {
      const runnerAgent = args.agent || "opus";
      if (runnerAgent === "codex") {
        return printResult(await runCodexExchangeRunnerOnce({
          agentHome,
          repoDir: args.repo || process.cwd(),
        }));
      }
      if (runnerAgent !== "opus") {
        throw new Error(`exchange-runner: unknown agent "${runnerAgent}". Supported: opus, codex`);
      }
      return printResult(await runExchangeRunnerOnce({
        agentHome,
        repoDir: args.repo || process.cwd(),
        settingsPath: args.settings || defaultRunnerSettingsPath(),
      }));
    }
    case "exchange-runner-session-status":
      return printResult({ sessions: runnerSessionStatus(agentHome, { chatId: args["chat-id"] }) });
    case "pause":
      return printResult({ config: setKillSwitch(agentHome, true) });
    case "resume":
      return printResult({ config: setKillSwitch(agentHome, false) });
    case "budget":
      return printResult({ config: setDailyTokenBudget(agentHome, requireArg(args, "tokens")) });
    case "allow-user":
      return printResult({ config: allowGatewayUser(agentHome, requireArg(args, "user")) });
    case "deny-user":
      return printResult({ config: denyGatewayUser(agentHome, requireArg(args, "user")) });
    case "agent-enable":
      return printResult({ config: enableExchangeAgent(agentHome, { agentId: requireArg(args, "agent"), kind: args.kind || "manual" }) });
    case "agent-disable":
      return printResult({ config: disableExchangeAgent(agentHome, requireArg(args, "agent")) });
    case "agent-join":
      return printResult({
        agent: joinAgentRegistry({
          agentHome,
          name: requireArg(args, "name"),
          style: requireArg(args, "style"),
          capabilities: requireArg(args, "capabilities"),
        }),
      });
    case "agent-registry-list":
      return printResult({ agents: listRegisteredAgents(agentHome) });
    case "registry-seed":
      return printResult(seedSpawnAgents({ agentHome }));
    case "gateway":
      return printResult(await handleGatewayMessage({
        agentHome,
        userId: requireArg(args, "from"),
        text: requireArg(args, "text"),
        memoryStateHome: args["memory-state"]
          ? await resolveStateHome(args["memory-state"], { create: false })
          : undefined,
      }));
    case "telegram-update":
      return printResult(await handleTelegramUpdate({
        agentHome,
        update: parseTelegramUpdateJson(requireArg(args, "update-json")),
        memoryStateHome: args["memory-state"]
          ? await resolveStateHome(args["memory-state"], { create: false })
          : undefined,
      }));
    case "telegram-poll":
      return printResult(await pollTelegramOnce({
        agentHome,
        transport: args.transport || "fetch",
        memoryStateHome: args["memory-state"]
          ? await resolveStateHome(args["memory-state"], { create: false })
          : undefined,
      }));
    case "telegram-codex-policy":
      return printResult({ policy: getTelegramCodexPolicy(agentHome), safety: getSafetyStatus(agentHome) });
    case "telegram-codex-policy-set":
      return printResult({
        policy: setTelegramCodexPolicy(agentHome, {
          default_repo: args["default-repo"],
          memory_enabled: args["memory-enabled"],
          exchange_notify_enabled: args["exchange-notify-enabled"],
          exchange_notify_chat_id: args["exchange-notify-chat-id"],
          exchange_notify_max_per_cycle: args["exchange-notify-max-per-cycle"],
          exchange_runner_enabled: args["exchange-runner-enabled"],
          exchange_runner_model: args["exchange-runner-model"],
          codex_runner_model: args["codex-runner-model"],
          exchange_runner_max_attempts: args["exchange-runner-max-attempts"],
          exchange_runner_timeout_seconds: args["exchange-runner-timeout-seconds"],
          exchange_runner_daily_max: args["exchange-runner-daily-max"],
          v2_enabled: args["v2-enabled"],
          workspace_root: args["workspace-root"],
        }).telegram_codex_policy,
      });
    case "exchange-runner-service-print":
      return printResult(buildOpusRunnerService({ repoDir: args.repo || process.cwd(), intervalSeconds: args["interval-seconds"] }));
    case "exchange-runner-service-write":
      return printResult(writeOpusRunnerService({ dir: requireArg(args, "dir"), repoDir: args.repo || process.cwd(), intervalSeconds: args["interval-seconds"] }));
    case "exchange-runner-service-status":
      return printResult(opusRunnerServiceStatus({
        dir: args.dir,
        repoDir: args.repo || process.cwd(),
        intervalSeconds: args["interval-seconds"],
        settingsPath: args.settings,
      }));
    case "codex-runner-service-print":
      return printResult(buildCodexRunnerService({ repoDir: args.repo || process.cwd(), intervalSeconds: args["interval-seconds"] }));
    case "codex-runner-service-write":
      return printResult(writeCodexRunnerService({ dir: requireArg(args, "dir"), repoDir: args.repo || process.cwd(), intervalSeconds: args["interval-seconds"] }));
    case "codex-runner-service-status":
      return printResult(codexRunnerServiceStatus({ dir: args.dir, repoDir: args.repo || process.cwd(), intervalSeconds: args["interval-seconds"] }));
    case "exchange-runner-settings-print":
      return printResult(buildOpusRunnerSettings());
    case "exchange-runner-settings-write":
      return printResult(writeOpusRunnerSettings({ settingsPath: args.settings }));
    case "opus-edit-settings-print":
      return printResult(buildOpusEditSettings({ repoDir: args.repo }));
    case "opus-edit-settings-write":
      return printResult(writeOpusEditSettings({ settingsPath: args.settings, repoDir: args.repo }));
    case "dashboard-once":
      return printResult(await dashboardOnce({
        agentHome,
        transport: args.transport || "fetch",
        longPollSeconds: args["long-poll-seconds"],
        dashboardChatId: args["dashboard-chat-id"],
      }));
    case "dashboard-bridge": {
      const controller = new AbortController();
      const onSignal = () => controller.abort();
      process.on("SIGINT", onSignal);
      process.on("SIGTERM", onSignal);
      try {
        return printResult(await dashboardBridge({
          agentHome,
          transport: args.transport || "fetch",
          longPollSeconds: args["long-poll-seconds"],
          maxCycles: args["max-cycles"],
          sleepSeconds: args["sleep-seconds"],
          dashboardChatId: args["dashboard-chat-id"],
          abortSignal: controller.signal,
        }));
      } finally {
        process.off("SIGINT", onSignal);
        process.off("SIGTERM", onSignal);
      }
    }
    case "dashboard-service-print":
      return printResult(buildDashboardService({ agentHome, repoDir: args.repo || process.cwd(), longPollSeconds: args["long-poll-seconds"] }));
    case "dashboard-service-write":
      return printResult(writeDashboardService({ agentHome, dir: requireArg(args, "dir"), repoDir: args.repo || process.cwd(), longPollSeconds: args["long-poll-seconds"] }));
    case "dashboard-service-status":
      return printResult(dashboardServiceStatus({ agentHome, dir: args.dir, repoDir: args.repo || process.cwd(), longPollSeconds: args["long-poll-seconds"] }));
    case "help":
    case undefined:
      return printHelp();
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

function printResult(result) {
  console.log(JSON.stringify(result, null, 2));
}

function printHelp() {
  console.log(`codex-agent commands:
  submit --repo /path --request "..." --mode plan
  status [task_id]
  run
  approve task_id
  reject task_id
  exchange-submit --from human --to codex --text "..."
  session-open --initiator owner --participants codex,opus [--repo repo] [--budget-messages N] [--budget-minutes M] [--write-access codex] [--token-file path] --topic "..."
  session-list
  session-show --id session_id
  session-kill --id session_id
  exchange-inbox [--agent codex] [--token-file path]
  exchange-replies --agent codex [--thread thread_id]
  exchange-thread --id msg_id
  exchange-claim --id msg_id --agent codex
  exchange-release --id msg_id --agent codex
  exchange-reply --id msg_id --agent codex --text "..."
  exchange-prune --days 30
  exchange-status
  dispatch-list [--status pending|approved|rejected]
  dispatch-show --id dispatch_id
  exchange-runner --agent opus --once [--repo /path] [--settings /path/opus-runner-settings.json]
  exchange-runner --agent codex --once [--repo /path]
  exchange-runner-session-status [--chat-id telegram_chat_id]
  exchange-runner-service-print [--repo /path] [--interval-seconds N]
  exchange-runner-service-write --dir ~/.config/systemd/user [--repo /path] [--interval-seconds N]
  exchange-runner-service-status [--dir DIR] [--repo /path] [--interval-seconds N] [--settings /path/opus-runner-settings.json]
  codex-runner-service-print [--repo /path] [--interval-seconds N]
  codex-runner-service-write --dir ~/.config/systemd/user [--repo /path] [--interval-seconds N]
  codex-runner-service-status [--dir DIR] [--repo /path] [--interval-seconds N]
  exchange-runner-settings-print
  exchange-runner-settings-write [--settings /path/opus-runner-settings.json]
  opus-edit-settings-print [--repo /path]
  opus-edit-settings-write [--settings /path/opus-edit-settings.json] [--repo /path]
  pause
  resume
  budget --tokens 20000|disabled
  allow-user --user user123
  deny-user --user user123
  agent-enable --agent codex --kind coding
  agent-disable --agent codex
  agent-join --name otter --style poll --capabilities read,write
  agent-registry-list
  registry-seed
  gateway --from user123 --text "agent status"
  telegram-update --update-json '{"message":{"from":{"id":123},"chat":{"id":456},"text":"agent status"}}'
  telegram-poll [--transport fetch|curl]
  telegram-codex-policy
  telegram-codex-policy-set [--default-repo /path] [--memory-enabled true|false] [--exchange-notify-enabled true|false] [--exchange-notify-chat-id ID] [--exchange-notify-max-per-cycle N] [--exchange-runner-enabled true|false] [--exchange-runner-model sonnet|opus] [--codex-runner-model MODEL] [--exchange-runner-max-attempts N] [--exchange-runner-timeout-seconds N] [--exchange-runner-daily-max N] [--v2-enabled true|false] [--workspace-root /path]
  dashboard-once [--transport fetch|curl] [--long-poll-seconds N] [--dashboard-chat-id ID]
  dashboard-bridge [--transport fetch|curl] [--long-poll-seconds N] [--max-cycles N] [--sleep-seconds N] [--dashboard-chat-id ID]
  dashboard-service-print [--repo /path] [--long-poll-seconds N]
  dashboard-service-write --dir ~/.config/systemd/user [--repo /path] [--long-poll-seconds N]
  dashboard-service-status [--dir DIR] [--repo /path] [--long-poll-seconds N]

Default state: ~/.codex/agent. Use --state .local-agent-state for development smoke tests.
Phase D supports local gateway text commands (status, submit, run, approve, reject), v2 Telegram smoke polling, and the v3 dashboard bridge via TELEGRAM_BOT_TOKEN.`);
}

function requirePollAgentTokenIfNeeded({ agentHome, name, tokenFile }) {
  if (!isActivePollAgent(agentHome, name)) {
    return;
  }
  const token = resolveAgentToken(tokenFile);
  if (!token || !verifyAgentToken(agentHome, name, token)) {
    throw codedError("bad_agent_token", `bad_agent_token: invalid token for ${name}`);
  }
}

function requireSessionInitiatorTokenIfNeeded({ agentHome, initiator, tokenFile }) {
  const normalized = String(initiator || "").trim();
  if (!normalized.startsWith("agent:")) {
    return;
  }
  const name = normalized.slice("agent:".length);
  const registered = getRegisteredAgent(agentHome, name);
  if (registered?.status !== "active") {
    throw codedError("agent_not_registered", `agent_not_registered: ${name}`);
  }
  if (registered.style === "poll") {
    requirePollAgentTokenIfNeeded({ agentHome, name, tokenFile });
  }
}

function resolveAgentToken(tokenFile) {
  if (tokenFile) {
    try {
      return fs.readFileSync(tokenFile, "utf8").trim();
    } catch {
      return "";
    }
  }
  return process.env.AGENT_RIVER_TOKEN || "";
}

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function resolveReplyText(args) {
  if (args["from-file"]) {
    return fs.readFileSync(args["from-file"], "utf8").trimEnd();
  }
  return requireArg(args, "text");
}

function requireTaskId(args) {
  if (!args._[0]) {
    throw new Error("Missing task id");
  }
  return args._[0];
}

function requireSession(agentHome, id) {
  const session = getSession(agentHome, id);
  if (!session) {
    throw new Error(`Session not found: ${id}`);
  }
  return session;
}

function filterDispatchApprovals(dispatches, status) {
  if (!status) {
    return dispatches;
  }
  if (!["pending", "approved", "rejected"].includes(status)) {
    throw new Error("Invalid dispatch status");
  }
  return dispatches.filter((dispatch) => dispatch.status === status);
}
