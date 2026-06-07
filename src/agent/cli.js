import fs from "node:fs";
import { parseArgs, requireArg, validateValueOptions } from "../lib/args.js";
import { resolveStateHome } from "../lib/paths.js";
import {
  chatStatus,
  completeChatHandoff,
  completeLatestChatHandoff,
  createChatDraft,
  createChatHandoff,
  createLatestChatDraft,
  createLatestChatHandoff,
  handoffStatus,
  inboxSummary,
  pruneChatState,
  queueChatReply,
  queueLatestChatReply,
} from "./chat.js";
import { runBridgeOnce } from "./bridge.js";
import { codexReplyOnce } from "./codex-reply.js";
import { telegramCodexLoop, telegramCodexLoopDryRun, telegramCodexOnce } from "./telegram-codex.js";
import { telegramCodexBridge, telegramCodexBridgeStatus } from "./telegram-codex-bridge.js";
import { approveAndSendReply, approveReply, listPendingReplyApprovals, rejectReply } from "./reply-approval.js";
import { buildTelegramCodexService, telegramCodexServiceStatus, writeTelegramCodexService, buildOpusRunnerService, writeOpusRunnerService, opusRunnerServiceStatus, buildOpusRunnerSettings, writeOpusRunnerSettings, buildOpusEditSettings, writeOpusEditSettings } from "./service.js";
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
import { handleGatewayMessage } from "./gateway.js";
import { approveAgentTask, getAgentStatus, rejectAgentTask, runAgentOnce, submitAgentTask } from "./orchestrator.js";
import { resolveAgentHome } from "./paths.js";
import { allowGatewayUser, denyGatewayUser, disableExchangeAgent, enableExchangeAgent, getSafetyStatus, getTelegramCodexPolicy, setDailyTokenBudget, setKillSwitch, setTelegramCodexPolicy } from "./safety.js";
import { handleTelegramUpdate, parseTelegramUpdateJson, pollTelegramOnce } from "./telegram.js";
import { getDispatchApproval, listDispatchApprovals } from "./dispatch.js";

export async function runAgentCli(argv) {
  if (argv[0] === "--help" || argv[0] === "-h") {
    return printHelp();
  }

  const [command, ...rest] = argv;
  const args = parseArgs(rest);
  validateValueOptions(args, ["agent", "channel", "chat-id", "context-max-chars", "days", "default-repo", "dir", "direct-send-allow-action-claims", "direct-send-daily-max", "direct-send-enabled", "direct-send-max-chars", "direct-send-memory", "direct-send-min-remaining-tokens", "direct-send-trusted-qa-enabled", "direct-send-trusted-qa-max-chars", "direct-send-user", "direct-send-user-remove", "enabled", "exchange-notify-chat-id", "exchange-notify-enabled", "exchange-notify-max-per-cycle", "exchange-runner-daily-max", "exchange-runner-enabled", "exchange-runner-max-attempts", "exchange-runner-model", "exchange-runner-timeout-seconds", "from", "from-file", "global-interval-seconds", "history-messages", "id", "interval-seconds", "iterations", "kind", "lease-seconds", "long-poll-seconds", "max-cycles", "max-model-calls-per-run", "max-runtime-seconds", "memory-enabled", "memory-state", "mode", "owner-low-risk-auto-plan-enabled", "owner-mode-enabled", "per-chat-interval-seconds", "repo", "request", "require-approval", "settings", "sleep-seconds", "state", "text", "thread", "to", "tokens", "transport", "update-json", "user", "v2-enabled", "workspace-root"]);
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
    case "inbox":
      return printResult(inboxSummary(agentHome));
    case "chat-status":
      return printResult(chatStatus(agentHome));
    case "chat-prune":
      return printResult(pruneChatState({ agentHome, days: requireArg(args, "days") }));
    case "exchange-submit":
      return printResult({
        message: submitExchangeMessage({
          agentHome,
          from: requireArg(args, "from"),
          to: args.to || "any",
          channel: args.channel || "cli",
          threadId: args.thread,
          text: resolveReplyText(args),
        }),
      });
    case "exchange-inbox":
      return printResult({ messages: listExchangeInbox(agentHome, { agent: args.agent }) });
    case "exchange-replies":
      return printResult({ replies: listExchangeReplies(agentHome, { agent: requireArg(args, "agent"), threadId: args.thread }) });
    case "exchange-thread":
      return printResult(getExchangeThread(agentHome, requireArg(args, "id")));
    case "exchange-claim":
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
      if (runnerAgent !== "opus") {
        throw new Error("exchange-runner v1 only supports --agent opus");
      }
      return printResult(await runExchangeRunnerOnce({
        agentHome,
        repoDir: args.repo || process.cwd(),
        settingsPath: args.settings || defaultRunnerSettingsPath(),
      }));
    }
    case "exchange-runner-session-status":
      return printResult({ sessions: runnerSessionStatus(agentHome, { chatId: args["chat-id"] }) });
    case "draft":
      return printResult({ draft: createChatDraft({ agentHome, inboxId: requireArg(args, "id") }) });
    case "draft-latest":
      return printResult({ draft: createLatestChatDraft(agentHome) });
    case "handoff":
      return printResult({ handoff: createChatHandoff({ agentHome, inboxId: requireArg(args, "id") }) });
    case "handoff-latest":
      return printResult({ handoff: createLatestChatHandoff(agentHome) });
    case "handoff-status":
      return printResult(handoffStatus(agentHome));
    case "handoff-complete":
      return printResult(completeChatHandoff({
        agentHome,
        id: requireArg(args, "id"),
        text: resolveReplyText(args),
      }));
    case "handoff-complete-latest":
      return printResult(completeLatestChatHandoff({
        agentHome,
        text: resolveReplyText(args),
      }));
    case "reply":
      return printResult({
        reply: queueChatReply({
          agentHome,
          inboxId: requireArg(args, "id"),
          text: resolveReplyText(args),
        }),
      });
    case "reply-latest":
      return printResult({
        reply: queueLatestChatReply({
          agentHome,
          text: resolveReplyText(args),
        }),
      });
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
    case "bridge-once":
      return printResult(await runBridgeOnce({
        agentHome,
        transport: args.transport || "fetch",
        memoryStateHome: args["memory-state"]
          ? await resolveStateHome(args["memory-state"], { create: false })
          : undefined,
      }));
    case "codex-reply-once":
      return printResult(await codexReplyOnce({ agentHome, inboxId: args.id }));
    case "telegram-codex-once":
      return printResult(await telegramCodexOnce({
        agentHome,
        transport: args.transport || "fetch",
        allowRealCodex: Boolean(args["allow-real-codex"]),
        requireReplyApproval: Boolean(args["require-reply-approval"]),
        inboxId: args.id,
        memoryStateHome: args["memory-state"]
          ? await resolveStateHome(args["memory-state"], { create: false })
          : undefined,
      }));
    case "reply-approval-list":
      return printResult({ approvals: listPendingReplyApprovals(agentHome) });
    case "reply-approval-approve":
      return printResult(approveReply({ agentHome, id: requireArg(args, "id") }));
    case "reply-approval-reject":
      return printResult(rejectReply({ agentHome, id: requireArg(args, "id") }));
    case "telegram-codex-policy":
      return printResult({ policy: getTelegramCodexPolicy(agentHome), safety: getSafetyStatus(agentHome) });
    case "telegram-codex-policy-set":
      return printResult({
        policy: setTelegramCodexPolicy(agentHome, {
          enabled: args.enabled,
          require_approval: args["require-approval"],
          global_interval_seconds: args["global-interval-seconds"],
          per_chat_interval_seconds: args["per-chat-interval-seconds"],
          max_model_calls_per_run: args["max-model-calls-per-run"],
          default_repo: args["default-repo"],
          history_messages: args["history-messages"],
          context_max_chars: args["context-max-chars"],
          memory_enabled: args["memory-enabled"],
          direct_send_enabled: args["direct-send-enabled"],
          direct_send_max_chars: args["direct-send-max-chars"],
          direct_send_daily_max: args["direct-send-daily-max"],
          direct_send_min_remaining_tokens: args["direct-send-min-remaining-tokens"],
          direct_send_trusted_qa_enabled: args["direct-send-trusted-qa-enabled"],
          direct_send_trusted_qa_max_chars: args["direct-send-trusted-qa-max-chars"],
          owner_mode_enabled: args["owner-mode-enabled"],
          owner_low_risk_auto_plan_enabled: args["owner-low-risk-auto-plan-enabled"],
          exchange_notify_enabled: args["exchange-notify-enabled"],
          exchange_notify_chat_id: args["exchange-notify-chat-id"],
          exchange_notify_max_per_cycle: args["exchange-notify-max-per-cycle"],
          exchange_runner_enabled: args["exchange-runner-enabled"],
          exchange_runner_model: args["exchange-runner-model"],
          exchange_runner_max_attempts: args["exchange-runner-max-attempts"],
          exchange_runner_timeout_seconds: args["exchange-runner-timeout-seconds"],
          exchange_runner_daily_max: args["exchange-runner-daily-max"],
          direct_send_memory: args["direct-send-memory"],
          direct_send_allow_action_claims: args["direct-send-allow-action-claims"],
          direct_send_user_add: args["direct-send-user"],
          direct_send_user_remove: args["direct-send-user-remove"],
          v2_enabled: args["v2-enabled"],
          workspace_root: args["workspace-root"],
        }).telegram_codex_policy,
      });
    case "telegram-codex-loop-dry-run":
      return printResult(telegramCodexLoopDryRun({ agentHome }));
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
    case "exchange-runner-settings-print":
      return printResult(buildOpusRunnerSettings());
    case "exchange-runner-settings-write":
      return printResult(writeOpusRunnerSettings({ settingsPath: args.settings }));
    case "opus-edit-settings-print":
      return printResult(buildOpusEditSettings({ repoDir: args.repo }));
    case "opus-edit-settings-write":
      return printResult(writeOpusEditSettings({ settingsPath: args.settings, repoDir: args.repo }));
    case "telegram-codex-service-print":
      return printResult(buildTelegramCodexService({ agentHome, mode: args.mode || "timer", longPollSeconds: args["long-poll-seconds"] }));
    case "telegram-codex-service-write":
      return printResult(writeTelegramCodexService({ agentHome, dir: requireArg(args, "dir"), mode: args.mode || "timer", longPollSeconds: args["long-poll-seconds"] }));
    case "telegram-codex-service-status":
      return printResult(telegramCodexServiceStatus({ dir: args.dir, mode: args.mode || "timer" }));
    case "telegram-codex-approval-send":
      return printResult(await approveAndSendReply({
        agentHome,
        id: requireArg(args, "id"),
        transport: args.transport || "fetch",
        memoryStateHome: args["memory-state"]
          ? await resolveStateHome(args["memory-state"], { create: false })
          : undefined,
      }));
    case "telegram-codex-loop":
      return printResult(await telegramCodexLoop({
        agentHome,
        transport: args.transport || "fetch",
        allowRealCodex: Boolean(args["allow-real-codex"]),
        iterations: args.iterations,
        sleepSeconds: args["sleep-seconds"],
        memoryStateHome: args["memory-state"]
          ? await resolveStateHome(args["memory-state"], { create: false })
          : undefined,
      }));
    case "telegram-codex-bridge": {
      // Foreground long-running process. SIGINT/SIGTERM abort cleanly AFTER the
      // current cycle finishes (the in-flight long-poll is not interrupted).
      const controller = new AbortController();
      const onSignal = () => controller.abort();
      process.on("SIGINT", onSignal);
      process.on("SIGTERM", onSignal);
      try {
        return printResult(await telegramCodexBridge({
          agentHome,
          transport: args.transport || "fetch",
          allowRealCodex: Boolean(args["allow-real-codex"]),
          longPollSeconds: args["long-poll-seconds"],
          maxCycles: args["max-cycles"],
          maxRuntimeSeconds: args["max-runtime-seconds"],
          abortSignal: controller.signal,
          memoryStateHome: args["memory-state"]
            ? await resolveStateHome(args["memory-state"], { create: false })
            : undefined,
        }));
      } finally {
        process.off("SIGINT", onSignal);
        process.off("SIGTERM", onSignal);
      }
    }
    case "telegram-codex-bridge-status":
      return printResult(telegramCodexBridgeStatus(agentHome));
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
  inbox
  chat-status
  chat-prune --days 30
  exchange-submit --from human --to codex --text "..."
  exchange-inbox [--agent codex]
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
  exchange-runner-session-status [--chat-id telegram_chat_id]
  exchange-runner-service-print [--repo /path] [--interval-seconds N]
  exchange-runner-service-write --dir ~/.config/systemd/user [--repo /path] [--interval-seconds N]
  exchange-runner-service-status [--dir DIR] [--repo /path] [--interval-seconds N] [--settings /path/opus-runner-settings.json]
  exchange-runner-settings-print
  exchange-runner-settings-write [--settings /path/opus-runner-settings.json]
  opus-edit-settings-print [--repo /path]
  opus-edit-settings-write [--settings /path/opus-edit-settings.json] [--repo /path]
  draft --id inbox_id
  draft-latest
  handoff --id inbox_id
  handoff-latest
  handoff-status
  handoff-complete --id handoff_id --from-file reply.txt
  handoff-complete-latest --from-file reply.txt
  reply --id inbox_id --text "..."
  reply-latest --text "..."
  pause
  resume
  budget --tokens 20000|disabled
  allow-user --user user123
  deny-user --user user123
  agent-enable --agent codex --kind coding
  agent-disable --agent codex
  gateway --from user123 --text "agent status"
  telegram-update --update-json '{"message":{"from":{"id":123},"chat":{"id":456},"text":"agent status"}}'
  telegram-poll [--transport fetch|curl]
  bridge-once [--transport fetch|curl]
  codex-reply-once [--id chat_id]
  telegram-codex-once --allow-real-codex [--transport fetch|curl] [--id chat_id] [--require-reply-approval]
  reply-approval-list
  reply-approval-approve --id approval_id
  reply-approval-reject --id approval_id
  telegram-codex-policy
  telegram-codex-policy-set [--enabled true|false] [--require-approval true|false] [--global-interval-seconds N] [--per-chat-interval-seconds N] [--max-model-calls-per-run N] [--default-repo /path] [--history-messages N] [--context-max-chars N] [--memory-enabled true|false] [--direct-send-enabled true|false] [--direct-send-user ID] [--direct-send-user-remove ID] [--direct-send-max-chars N] [--direct-send-daily-max N] [--direct-send-min-remaining-tokens N] [--direct-send-trusted-qa-enabled true|false] [--direct-send-trusted-qa-max-chars N] [--owner-mode-enabled true|false] [--owner-low-risk-auto-plan-enabled true|false] [--exchange-notify-enabled true|false] [--exchange-notify-chat-id ID] [--exchange-notify-max-per-cycle N] [--exchange-runner-enabled true|false] [--exchange-runner-model sonnet|opus] [--exchange-runner-max-attempts N] [--exchange-runner-timeout-seconds N] [--exchange-runner-daily-max N]
  telegram-codex-loop-dry-run
  telegram-codex-loop --allow-real-codex --iterations N [--sleep-seconds N] [--transport fetch|curl]
  telegram-codex-bridge --allow-real-codex [--transport fetch|curl] [--long-poll-seconds N] [--max-cycles N] [--max-runtime-seconds N]
  telegram-codex-bridge-status
  telegram-codex-service-print [--mode timer|bridge] [--long-poll-seconds N]
  telegram-codex-service-write --dir ~/.config/systemd/user [--mode timer|bridge] [--long-poll-seconds N]
  telegram-codex-service-status [--dir DIR] [--mode timer|bridge]
  telegram-codex-approval-send --id approval_id [--transport fetch|curl]

Default state: ~/.codex/agent. Use --state .local-agent-state for development smoke tests.
Phase D supports local gateway text commands (status, submit, run, approve, reject) and single-shot Telegram polling via TELEGRAM_BOT_TOKEN.`);
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

function filterDispatchApprovals(dispatches, status) {
  if (!status) {
    return dispatches;
  }
  if (!["pending", "approved", "rejected"].includes(status)) {
    throw new Error("Invalid dispatch status");
  }
  return dispatches.filter((dispatch) => dispatch.status === status);
}
