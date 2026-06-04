import { appendJsonl } from "codex-memory-river/src/jsonl.js";
import { shortHash } from "codex-memory-river/src/hash.js";
import { scanSecrets } from "codex-memory-river/src/secret-scan.js";
import { agentPaths } from "./paths.js";

export const OWNER_BLOCKED_NOTICE = "這則訊息含敏感或不安全內容，已拒絕處理。";
export const OWNER_NO_REPO_NOTICE = "無法建立動作：尚未設定 default_repo。";
export const OWNER_QA_FALLBACK_NOTICE = "回覆需人工確認，稍後送出。";
export const OWNER_APPROVE_FAILED_NOTICE = "無法核准這個任務。請確認 task id 仍在 pending 狀態。";
export const OWNER_REJECT_FAILED_NOTICE = "無法拒絕這個任務。請確認 task id 仍在 pending 狀態。";
export const OWNER_TASK_NOT_FOUND_NOTICE = "找不到這個任務。";
export const OWNER_COMMAND_UNRECOGNIZED_NOTICE = "無法辨識這個 task 指令。請使用 approve/status/reject task_...。";
export const OWNER_REPLY_REJECTED_NOTICE = "已拒絕這則回覆。";
export const OWNER_REPLY_APPROVE_FAILED_NOTICE = "無法核准這則回覆。請確認 approval id 仍在 pending 狀態。";
export const OWNER_REPLY_REJECT_FAILED_NOTICE = "無法拒絕這則回覆。請確認 approval id 仍在 pending 狀態。";
export const OWNER_DANGEROUS_ACTION_NOTICE = "這個操作（commit/push/deploy/delete/install 等）需要在本機手動執行，Telegram 不會自動處理。";

export function ownerEditActionNotice(taskId) {
  return `已建立待批准 edit 任務（${taskId}），等待你核准後才會修改檔案。`;
}

export function ownerApproveEditNotice(task) {
  const id = task?.id || "unknown";
  const status = task?.status || "unknown";
  if (status !== "done") {
    return unfinishedOwnerTaskNotice("edit", id, status, task);
  }
  const lines = [`已核准並完成 edit 任務（${id}）。`];
  const diffStat = task.result?.diff_stat;
  if (diffStat) {
    lines.push(`變更：\n${diffStat}`);
  }
  const tests = task.result?.tests;
  if (tests) {
    lines.push(`驗證：${tests.passed ? "pass" : "fail"} (${safeCommand(tests.command)})`);
  }
  const summary = safeSummary(task.result?.summary);
  if (summary) {
    lines.push(`摘要：${summary}`);
  }
  return lines.join("\n");
}

function safeCommand(command) {
  const raw = Array.isArray(command) ? command.join(" ") : String(command || "");
  return safeLine(raw) || "unknown";
}

export function ownerActionNotice(taskId) {
  return `已建立待批准動作（${taskId}），等待你核准後才會執行。`;
}

export function ownerTaskReplyMarkup(taskId) {
  return {
    inline_keyboard: [[
      { text: "Approve", callback_data: `owner:approve:${taskId}` },
      { text: "Reject", callback_data: `owner:reject:${taskId}` },
      { text: "Status", callback_data: `owner:status:${taskId}` },
    ]],
  };
}

export function ownerReplyApprovalMarkup(approvalId) {
  return {
    inline_keyboard: [[
      { text: "Approve", callback_data: `owner_reply:approve:${approvalId}` },
      { text: "Reject", callback_data: `owner_reply:reject:${approvalId}` },
    ]],
  };
}

export function ownerApproveNotice(task) {
  const id = task?.id || "unknown";
  const status = task?.status || "unknown";
  if (status !== "done") {
    return unfinishedOwnerTaskNotice("plan", id, status, task);
  }
  const summary = safeSummary(task.result?.summary);
  return summary
    ? `已核准並完成 plan 任務（${id}）。\n摘要：${summary}`
    : `已核准並完成 plan 任務（${id}）。`;
}

function unfinishedOwnerTaskNotice(mode, id, status, task) {
  const last = safeLine(task?.history?.at(-1)?.note || "");
  const suffix = last && last !== "redacted" ? `；last：${last}` : "";
  return `已核准但 ${mode} 任務未完成（${id}）。狀態：${status}${suffix}`;
}

export function ownerAutoPlanNotice(task) {
  const id = task?.id || "unknown";
  const status = task?.status || "unknown";
  if (status !== "done") {
    return `已自動執行低風險 plan 任務但未完成（${id}）。狀態：${status}`;
  }
  const summary = safeSummary(task.result?.summary);
  return summary
    ? `已自動完成低風險 plan 任務（${id}）。\n摘要：${summary}`
    : `已自動完成低風險 plan 任務（${id}）。`;
}

export function ownerStatusNotice(task) {
  if (!task) {
    return OWNER_TASK_NOT_FOUND_NOTICE;
  }
  const last = task.history?.at(-1);
  return [
    `任務狀態（${task.id}）`,
    `status: ${task.status}`,
    `approval: ${task.approval}`,
    `last: ${safeLine(last?.note || "none")}`,
  ].join("\n");
}

export function ownerRejectNotice(task) {
  return `已拒絕任務（${task.id}）。狀態：${task.status}`;
}

export function parseOwnerReplyApprovalCommand(text) {
  const raw = String(text ?? "").trim();
  const match = raw.match(/^(?:agent\s+)?reply-(approve|reject)\s+(approval_[A-Za-z0-9_-]+)$/i);
  if (!match) {
    return null;
  }
  return { command: match[1].toLowerCase(), approvalId: match[2] };
}

export function parseOwnerTaskCommand(text) {
  const raw = String(text ?? "").trim();
  const match = raw.match(/^(?:agent\s+)?(approve|status|reject)\s+(task_[A-Za-z0-9_-]+)$/i);
  if (!match) {
    return null;
  }
  return { command: match[1].toLowerCase(), taskId: match[2] };
}

export function isMalformedOwnerTaskCommand(text) {
  const raw = String(text ?? "").trim();
  return /\btask_[A-Za-z0-9_-]+\b/.test(raw)
    && /\b(?:approve|status|reject)\b/i.test(raw)
    && !parseOwnerTaskCommand(raw);
}

export function isOwner(inbox, policy = {}) {
  return Boolean(policy.owner_mode_enabled
    && Array.isArray(policy.direct_send_user_allowlist)
    && policy.direct_send_user_allowlist.includes(String(inbox?.user_id)));
}

// Returns "dangerous" | "edit" | "plan" based on the intent of the text.
// Used to route owner action requests to the right handler.
export function classifyOwnerActionMode(text) {
  const raw = String(text ?? "").trim();
  if (isDangerousActionRequest(raw)) return "dangerous";
  if (isEditActionRequest(raw)) return "edit";
  return "plan";
}

// Routes an owner @opus message into a lane:
//   "blocked"      — secret/injection content; refuse.
//   "dangerous"    — commit/push/deploy/delete/install; decline (manual only).
//   "edit_auto"    — small low-risk edit; auto-approve + run (still bounded:
//                    repo allowlist, no commit/push, verify wrapper, diff report).
//   "edit_approve" — edit that needs an explicit owner Approve button first.
//   "conversation" — review/plan/Q&A; no file changes, handled read-only.
export function classifyOpusAsk(text, policy = {}) {
  const raw = String(text ?? "").trim();
  if (!raw) {
    return { lane: "conversation", reasons: ["empty"] };
  }
  if (isBlocked(raw)) {
    return { lane: "blocked", reasons: blockedReasons(raw) };
  }
  if (isDangerousActionRequest(raw)) {
    return { lane: "dangerous", reasons: ["dangerous"] };
  }
  if (hasExplicitReadOnlyBoundary(raw)) {
    return { lane: "conversation", reasons: ["read_only_boundary"] };
  }
  if (isEditActionRequest(raw)) {
    // An edit request that also reads like a read-only ask (e.g. "add a line
    // that EXPLAINS …", "說明") is ambiguous — route it to the approval button,
    // never auto-edit. A pure edit (no read-only words) can auto-run if small.
    if (hasReadOnlyIntent(raw)) {
      return { lane: "edit_approve", reasons: ["edit", "read_only"] };
    }
    return { lane: isLowRiskEdit(raw) ? "edit_auto" : "edit_approve", reasons: ["edit"] };
  }
  // No edit intent: review/plan/Q&A, including requests whose only verb is
  // read-only (e.g. "review the latest patch" — "patch" is an incidental noun).
  return { lane: "conversation", reasons: [] };
}

// Conservative: only short, single-scope edits auto-execute. Anything broad
// (refactor/rewrite/whole-codebase/migration) or long falls back to approval.
function isLowRiskEdit(text) {
  if (text.length > 240) {
    return false;
  }
  return !/\b(refactor|rewrite|migrate|overhaul|redesign|all files|everywhere|every file)\b/i.test(text)
    && !/(重構|重寫|全部|所有檔|整個專案|整包|大改|遷移)/.test(text);
}

export function classifyOwnerInbound(text, policy = {}) {
  const raw = String(text ?? "").trim();
  const maxChars = Number(policy.direct_send_trusted_qa_max_chars) || 1200;

  if (!raw) {
    return { kind: "blocked", reasons: ["empty"] };
  }
  if (isBlocked(raw)) {
    return { kind: "blocked", reasons: blockedReasons(raw) };
  }

  const actionReasons = actionRequestReasons(raw);
  if (raw.length > maxChars) {
    actionReasons.push("too_long");
  }
  if (actionReasons.length > 0) {
    const mode = classifyOwnerActionMode(raw);
    if (mode === "dangerous") {
      return { kind: "dangerous_request", reasons: actionReasons };
    }
    if (mode === "edit") {
      return { kind: "edit_request", reasons: actionReasons };
    }
    if (policy.owner_low_risk_auto_plan_enabled && isLowRiskPlanRequest(raw, actionReasons)) {
      return { kind: "low_risk_action", reasons: actionReasons };
    }
    return { kind: "action_request", reasons: actionReasons };
  }

  return { kind: "qa", reasons: [] };
}

export function recordOwnerDecision({
  agentHome,
  inbox,
  kind,
  decision,
  taskId,
  replyText,
  reasons = [],
  now = Date.now(),
}) {
  const entry = {
    inbox_id: inbox?.id ?? null,
    chat_id: inbox?.chat_id ?? null,
    user_id: inbox?.user_id ?? null,
    text_hash: shortHash(String(inbox?.text ?? "")),
    reply_hash: replyText === undefined ? null : shortHash(String(replyText ?? "")),
    kind,
    decision,
    task_id: taskId ?? null,
    reasons,
    created_at: new Date(now).toISOString(),
  };
  appendJsonl(agentPaths(agentHome).ownerModeAudit, entry);
  return entry;
}

function isDangerousActionRequest(text) {
  return hasEnglishActionWord(text, ["commit", "push", "deploy", "install", "delete", "rm", "drop", "destroy", "rollback", "rebase", "reset"])
    || /(提交|推送|部署|安裝|刪除|還原|重置|移除套件)/.test(text);
}

function isEditActionRequest(text) {
  // Note: "patch" is intentionally excluded — as a noun ("review the patch") it
  // caused read requests to misroute to edit.
  return /\b(fix|implement|add|modify|change|update|refactor|write|edit|create|build|make|generate)\b/i.test(text)
    || /(修正|修復|實作|新增|修改|更改|更新|重構|寫入|建立|產生|編輯|改|加|加入|補|補上)/.test(text);
}

function isBlocked(text) {
  return blockedReasons(text).length > 0;
}

function blockedReasons(text) {
  const reasons = [];
  if (/\b(sk-[A-Za-z0-9_-]{6,}|gh[pousr]_[A-Za-z0-9]+|AKIA[0-9A-Z]{6,}|token|secret|api[_-]?key|password|passwd|credential)\b/i.test(text)
    || /(金鑰|密鑰|密碼|憑證|權杖)/.test(text)
    || scanSecrets(text).length > 0) {
    reasons.push("secret");
  }
  if (/\b(ignore (?:previous|above|all|prior|the)|disregard (?:previous|above|all|prior)|system prompt|reveal|print your|show your|repeat your|prompt injection)\b/i.test(text)
    || /(忽略(?:之前|上面|以上|先前)|系統提示|提示詞|你的指令|揭露|顯示你的)/.test(text)) {
    reasons.push("injection");
  }
  return reasons;
}

function actionRequestReasons(text) {
  const reasons = [];
  if (/\b(do|run|fix|deploy|send|delete|remove|write|make|build|create|update|check|review|push|commit|install|generate|edit|exec|execute|approve)\b/i.test(text)
    || /(請|幫我|幫忙|執行|部署|推送|提交|檢查|安裝|刪除|修正|修復|產生|生成|編輯|批准|核准)/.test(text)) {
    reasons.push("imperative");
  }
  if (/[`]/.test(text) || /```/.test(text)) {
    reasons.push("code");
  }
  if (/https?:\/\//i.test(text) || /[\/\\]/.test(text) || /\b[\w-]+\.(js|ts|md|json|txt|py|sh|go|rs|java|c|cpp|yml|yaml|toml|env)\b/i.test(text)) {
    reasons.push("path_or_url");
  }
  return reasons;
}

function isLowRiskPlanRequest(text, reasons) {
  if (reasons.includes("too_long") || reasons.includes("code") || reasons.includes("path_or_url")) {
    return false;
  }
  if (hasDangerousAction(text)) {
    return false;
  }
  return hasReadOnlyIntent(text);
}

function hasDangerousAction(text) {
  return hasEnglishActionWord(text, ["run", "fix", "deploy", "send", "delete", "remove", "write", "make", "build", "create", "update", "push", "commit", "install", "generate", "edit", "exec", "execute", "approve"])
    || /(執行|部署|推送|提交|安裝|刪除|修正|修復|產生|生成|編輯|批准|核准|改|修改|寫|建立)/.test(text);
}

function hasReadOnlyIntent(text) {
  return /\b(check|review|inspect|status|summarize|summary|explain|analyze|look|read)\b/i.test(text)
    || /(檢查|查看|查詢|看一下|看下|狀態|整理|摘要|說明|解釋|分析|review|對齊進度)/i.test(text);
}

function hasExplicitReadOnlyBoundary(text) {
  return /\b(read-only|readonly|no file changes|do not modify files|don't modify files|do not edit|don't edit|do not change files|don't change files)\b/i.test(text)
    || /(只做唯讀|唯讀\s*review|不要修改檔案|不要改檔|不要改文件|不要建立\s*edit\s*task|不修改檔案|不改檔|不改文件)/i.test(text);
}

function hasEnglishActionWord(text, words) {
  const pattern = words.map(escapeRegex).join("|");
  return new RegExp(`(^|[^A-Za-z0-9_-])(?:${pattern})(?=$|[^A-Za-z0-9_-])`, "i").test(String(text || ""));
}

function escapeRegex(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function safeSummary(text) {
  const raw = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!raw || scanSecrets(raw).length > 0) {
    return "";
  }
  return raw.length > 700 ? `${raw.slice(0, 697)}...` : raw;
}

function safeLine(text) {
  const raw = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!raw || scanSecrets(raw).length > 0) {
    return "redacted";
  }
  return raw.length > 180 ? `${raw.slice(0, 177)}...` : raw;
}
