import { appendJsonl, readJsonl } from "codex-memory-river/src/jsonl.js";
import { scanSecrets } from "codex-memory-river/src/secret-scan.js";
import { shortHash } from "codex-memory-river/src/hash.js";
import { agentPaths } from "./paths.js";

// DS1: deterministic direct-send classifier + output guard + decision audit.
// No model classifier; Memory River context is not assembled for auto-send
// candidates. Failing any gate routes the reply to the approval queue.

const GREETINGS = new Set([
  "hi", "hello", "hey", "good morning", "good afternoon", "good evening", "good night",
  "早", "早安", "午安", "晚安", "哈囉", "嗨", "你好", "您好",
]);
const ACKS = new Set([
  "ok", "okay", "k", "thanks", "thank you", "thx", "got it", "noted", "sounds good",
  "收到", "好", "好喔", "好的", "謝謝", "感謝", "了解", "知道了", "沒問題",
]);
const SMALLTALK = new Set([
  "nice", "cool", "great", "awesome", "haha", "lol", "good",
  "哈哈", "不錯", "讚", "太好了",
]);

// --- inbound classifier ---

export function classifyInboundForDirectSend(text, policy = {}) {
  const raw = String(text ?? "").trim();
  const maxChars = Number(policy.direct_send_max_chars) || 280;
  const reasons = [];

  if (!raw) {
    return approval(["empty"]);
  }
  if (raw.length > maxChars) {
    reasons.push("too_long");
  }
  if (/[?？]/.test(raw)) {
    reasons.push("question");
  }
  if (/\b(what|why|how|when|where|who|which|whose|can you|could you|would you|do you|is it|are you)\b/i.test(raw)
    || /(嗎|呢|什麼|為什麼|怎麼|如何|哪|誰|多少)/.test(raw)) {
    reasons.push("question");
  }
  if (/\b(do|run|fix|deploy|send|delete|remove|write|make|build|summari[sz]e|explain|create|update|check|review|push|commit|install|show|tell|give|help|generate|translate)\b/i.test(raw)
    || /(請|幫我|幫忙|執行|部署|推送|提交|總結|解釋|檢查|安裝|刪除|修正|修復|翻譯|產生|生成|告訴我)/.test(raw)) {
    reasons.push("imperative");
  }
  if (/[`]/.test(raw) || /```/.test(raw)) {
    reasons.push("code");
  }
  if (/https?:\/\//i.test(raw) || /[\/\\]/.test(raw) || /\b[\w-]+\.(js|ts|md|json|txt|py|sh|go|rs|java|c|cpp|yml|yaml|toml|env)\b/i.test(raw)) {
    reasons.push("path_or_url");
  }
  if (/\b(sk-[A-Za-z0-9_-]{6,}|gh[pousr]_[A-Za-z0-9]+|AKIA[0-9A-Z]{6,}|token|secret|api[_-]?key|password|passwd|credential)\b/i.test(raw)
    || /(金鑰|密鑰|密碼|憑證|權杖)/.test(raw)
    || scanSecrets(raw).length > 0) {
    reasons.push("secret");
  }
  if (/\b(ignore (?:previous|above|all|prior|the)|disregard (?:previous|above|all|prior)|system prompt|reveal|print your|show your|repeat your|prompt injection)\b/i.test(raw)
    || /(忽略(?:之前|上面|以上|先前)|系統提示|提示詞|你的指令|揭露|顯示你的)/.test(raw)) {
    reasons.push("injection");
  }
  if ((raw.match(/[.!?。！？]/g) || []).length > 1) {
    reasons.push("multi_sentence");
  }
  if (hasUnsupportedScript(raw)) {
    reasons.push("unsupported_language");
  }

  if (reasons.length > 0) {
    return approval(reasons);
  }

  const key = normalizeKey(raw);
  const classes = Array.isArray(policy.direct_send_classes) ? policy.direct_send_classes : [];
  const matched = lexiconClass(key);
  if (!matched) {
    return approval(["unclassified"]);
  }
  if (!classes.includes(matched)) {
    return approval(["class_disabled"]);
  }
  return { class: matched, eligible: true, reasons: [] };
}

export function classifyInboundForTrustedQa(text, policy = {}) {
  const raw = String(text ?? "").trim();
  const maxChars = Number(policy.direct_send_trusted_qa_max_chars) || 1200;
  const reasons = [];

  if (!raw) {
    return approval(["empty"]);
  }
  if (raw.length > maxChars) {
    reasons.push("too_long");
  }
  if (!(/[?？]/.test(raw)
    || /\b(what|why|how|when|where|who|which|whose|can you|could you|would you|do you|is it|are you)\b/i.test(raw)
    || /(嗎|呢|什麼|為什麼|怎麼|如何|哪|誰|多少)/.test(raw))) {
    reasons.push("not_question");
  }
  if (/\b(run|fix|deploy|send|delete|remove|write|make|build|create|update|push|commit|install|generate)\b/i.test(raw)
    || /(請|幫我|幫忙|執行|部署|推送|提交|安裝|刪除|修正|修復|產生|生成)/.test(raw)) {
    reasons.push("imperative");
  }
  if (/[`]/.test(raw) || /```/.test(raw)) {
    reasons.push("code");
  }
  if (/https?:\/\//i.test(raw) || /[\/\\]/.test(raw) || /\b[\w-]+\.(js|ts|md|json|txt|py|sh|go|rs|java|c|cpp|yml|yaml|toml|env)\b/i.test(raw)) {
    reasons.push("path_or_url");
  }
  if (/\b(sk-[A-Za-z0-9_-]{6,}|gh[pousr]_[A-Za-z0-9]+|AKIA[0-9A-Z]{6,}|token|secret|api[_-]?key|password|passwd|credential)\b/i.test(raw)
    || /(金鑰|密鑰|密碼|憑證|權杖)/.test(raw)
    || scanSecrets(raw).length > 0) {
    reasons.push("secret");
  }
  if (/\b(ignore (?:previous|above|all|prior|the)|disregard (?:previous|above|all|prior)|system prompt|reveal|print your|show your|repeat your|prompt injection)\b/i.test(raw)
    || /(忽略(?:之前|上面|以上|先前)|系統提示|提示詞|你的指令|揭露|顯示你的)/.test(raw)) {
    reasons.push("injection");
  }
  if (hasUnsupportedScript(raw)) {
    reasons.push("unsupported_language");
  }

  if (reasons.length > 0) {
    return approval(reasons);
  }
  return { class: "trusted_qa", eligible: true, reasons: [] };
}

function approval(reasons) {
  return { class: "approval_required", eligible: false, reasons };
}

function lexiconClass(key) {
  if (GREETINGS.has(key)) return "greeting";
  if (ACKS.has(key)) return "ack";
  if (SMALLTALK.has(key)) return "smalltalk";
  return null;
}

function normalizeKey(text) {
  return text
    .toLowerCase()
    .replace(/^[\p{P}\p{S}\s]+|[\p{P}\p{S}\s]+$/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

function hasUnsupportedScript(text) {
  const leftover = text
    .replace(/[A-Za-z0-9\s]/g, "")
    .replace(/[　-〿一-鿿＀-￯]/g, "")
    .replace(/[\p{P}\p{S}]/gu, "");
  return leftover.length > 0;
}

// --- output guard ---

export function guardDirectSendOutput(replyText, inboundText, policy = {}, options = {}) {
  const reply = String(replyText ?? "");
  const maxChars = Number(options.maxChars ?? policy.direct_send_max_chars) || 280;
  const reasons = [];

  if (!reply.trim()) {
    reasons.push("empty");
  }
  if (reply.length > maxChars) {
    reasons.push("too_long");
  }
  if (scanSecrets(reply).length > 0) {
    reasons.push("secret");
  }
  if (containsActionClaim(reply)) {
    reasons.push("action_claim");
  }
  if (/[`]/.test(reply) || /```/.test(reply)
    || /^\s*\$\s/m.test(reply)
    || /^\s*(sudo|npm|git|node|rm|cd|ls|cat|curl|chmod)\b/m.test(reply)
    || /[\/\\][\w.-]+[\/\\]/.test(reply)
    || /\b[\w-]+\.(js|ts|md|json|txt|py|sh|go|rs|yml|yaml)\b/i.test(reply)) {
    reasons.push("tool_reference");
  }
  if (languageMismatch(inboundText, reply)) {
    reasons.push("language_mismatch");
  }

  return { ok: reasons.length === 0, reasons };
}

export function guardOwnerQaOutput(replyText, inboundText, policy = {}) {
  const reply = String(replyText ?? "");
  const maxChars = Number(policy.direct_send_trusted_qa_max_chars) || 1200;
  const reasons = [];

  if (!reply.trim()) {
    reasons.push("empty");
  }
  if (reply.length > maxChars) {
    reasons.push("too_long");
  }
  if (scanSecrets(reply).length > 0) {
    reasons.push("secret");
  }
  if (languageMismatch(inboundText, reply)) {
    reasons.push("language_mismatch");
  }

  return { ok: reasons.length === 0, reasons };
}

function containsActionClaim(text) {
  const patterns = [
    /\b(done|fixed|deployed|ran|executed|edited|committed|pushed|created|installed|deleted|merged|published)\b/ig,
    /(已完成|已修正|已修復|已執行|已提交|已推送|已建立|已刪除|已安裝|已部署)/g,
  ];
  return patterns.some((pattern) => {
    for (const match of text.matchAll(pattern)) {
      const prefix = text.slice(Math.max(0, match.index - 12), match.index);
      if (!/(不能|不要|不可|不應|不得|避免|不能聲稱|沒有|尚未|未|not|never|cannot|can't|should not|must not)\s*$/i.test(prefix)) {
        return true;
      }
    }
    return false;
  });
}

function languageMismatch(inboundText, replyText) {
  const inbound = String(inboundText ?? "");
  const reply = String(replyText ?? "");
  const inboundCjk = /[一-鿿]/.test(inbound);
  const replyCjk = /[一-鿿]/.test(reply);
  const inboundLatin = /[A-Za-z]/.test(inbound);
  const replyLatin = /[A-Za-z]/.test(reply);
  // Only flag a clear mismatch; otherwise stay quiet (conservative paths route
  // to approval for other reasons, never auto-send).
  if (inboundCjk && !inboundLatin && replyLatin && !replyCjk) return true;
  if (inboundLatin && !inboundCjk && replyCjk && !replyLatin) return true;
  return false;
}

// --- decision audit ---

export function evaluateDirectSend({ agentHome, inbox, replyText, policy, safety, now = Date.now(), ownerQa = false }) {
  let cls = ownerQa
    ? { class: "owner_qa", eligible: true, reasons: [] }
    : classifyInboundForDirectSend(inbox.text, policy);
  let guard = ownerQa
    ? guardOwnerQaOutput(replyText, inbox.text, policy)
    : guardDirectSendOutput(replyText, inbox.text, policy);
  if (!ownerQa && !cls.eligible && policy.direct_send_trusted_qa_enabled) {
    const trustedQa = classifyInboundForTrustedQa(inbox.text, policy);
    if (trustedQa.eligible) {
      cls = trustedQa;
      guard = guardDirectSendOutput(replyText, inbox.text, policy, {
        maxChars: policy.direct_send_trusted_qa_max_chars,
      });
    }
  }
  const gateReasons = directSendGateReasons({ inbox, policy, safety, agentHome, now });
  const autoSend = cls.eligible && guard.ok && gateReasons.length === 0;
  return {
    class: cls.class,
    auto_send: autoSend,
    inbound_reasons: cls.reasons,
    output_reasons: guard.reasons,
    gate_reasons: gateReasons,
    decision: autoSend ? "auto_sent" : "approval_required",
  };
}

export function canBuildDirectSendPrompt({ inbox, policy }) {
  if (!policy.direct_send_enabled) {
    return false;
  }
  if (!Array.isArray(policy.direct_send_user_allowlist)
    || !policy.direct_send_user_allowlist.includes(String(inbox.user_id))) {
    return false;
  }
  return classifyInboundForDirectSend(inbox.text, policy).eligible;
}

export function recordDirectSendAttempt({ agentHome, inbox, replyText, policy, decision, tokens, now = Date.now() }) {
  const entry = {
    inbox_id: inbox.id ?? null,
    chat_id: inbox.chat_id ?? null,
    user_id: inbox.user_id ?? null,
    text_hash: shortHash(String(inbox.text ?? "")),
    reply_hash: shortHash(String(replyText ?? "")),
    class: decision.class,
    decision: decision.decision,
    inbound_reasons: decision.inbound_reasons,
    output_reasons: decision.output_reasons,
    gate_reasons: decision.gate_reasons,
    direct_send_enabled: Boolean(policy.direct_send_enabled),
    tokens: Number.isFinite(tokens) ? tokens : null,
    created_at: new Date(now).toISOString(),
  };
  appendJsonl(agentPaths(agentHome).directSendAudit, entry);
  return entry;
}

function directSendGateReasons({ inbox, policy, safety, agentHome, now }) {
  const reasons = [];
  if (!policy.direct_send_enabled) {
    reasons.push("disabled");
  }
  if (!Array.isArray(policy.direct_send_user_allowlist)
    || !policy.direct_send_user_allowlist.includes(String(inbox.user_id))) {
    reasons.push("user_not_allowlisted");
  }
  if (policy.direct_send_memory) {
    reasons.push("memory_not_allowed");
  }
  if (policy.direct_send_allow_action_claims) {
    reasons.push("action_claims_not_allowed");
  }
  if (safety?.config?.kill_switch) {
    reasons.push("kill_switch");
  }
  if ((safety?.today?.remaining_tokens ?? 0) < Number(policy.direct_send_min_remaining_tokens || 0)) {
    reasons.push("insufficient_token_headroom");
  }
  if (directSendCountToday(agentHome, now) >= Number(policy.direct_send_daily_max || 0)) {
    reasons.push("daily_max");
  }
  return reasons;
}

function directSendCountToday(agentHome, now) {
  const day = new Date(now).toISOString().slice(0, 10);
  return readJsonl(agentPaths(agentHome).directSendAudit)
    .filter((entry) => entry.decision === "auto_sent" && String(entry.created_at || "").slice(0, 10) === day)
    .length;
}
