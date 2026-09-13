import { matchMailBlock } from "../agent/mail-block.js";

const COPY = {
  en: { title: "Central post office", new: "New letter", search: "Search correspondence", all: "All", queued: "Queued", working: "Working", completed: "Completed", failed: "Needs attention", stopped: "Stopped", reassigned: "Reassigned", request: "Request", result: "Result delivery", reply: "Reply", processed: "Processed", delivery_failed: "Delivery failed", empty: "No correspondence yet", start: "Send a letter to an agent, or choose automatic routing. Replies and follow-ups stay together here.", recipient: "Recipient", auto: "Automatic assignment", capability: "Type of help", general: "General", coding: "Code / debugging", review: "Review", subject: "Subject", text: "Your letter", repo: "Repository (optional)", send: "Send letter", follow: "Add an instruction or follow-up", stop: "Stop this conversation", stopNote: "Stops queued work and further delivery. A turn already running may finish; its reply remains visible.", reassign: "Reassign queued letter", route: "Delivery route", participants: "Participants", activity: "Latest activity", agent: "Available agents", delivery: "Automatic delivery", live: "Running", offline: "Not reporting", offlineNote: "The Web delivery worker is not reporting. Letters can still be received; check the runner before expecting a reply.", rule: "direct", capabilityRule: "capability", fallback: "fallback", view: "Open conversation", count: "conversations", noSelection: "Select a conversation", paused: "Paused", idle: "Waiting for letters", updated: "Updated", legacy: "Earlier mailbox records", legacyNote: "Earlier requests and session records are retained in the original inbox.", unknown: "Unknown" },
  "zh-Hant": { title: "中央郵局", new: "撰寫信件", search: "搜尋信件與對話", all: "全部", queued: "待投遞", working: "處理中", completed: "已完成", failed: "需要處理", stopped: "已停止", reassigned: "已改派", request: "請求", result: "結果送達", reply: "回覆", processed: "已處理", delivery_failed: "投遞失敗", empty: "目前還沒有往返信件", start: "寄信給指定 agent，或交給郵局自動分派。回覆與追問會串在同一件事裡。", recipient: "收件者", auto: "自動分派", capability: "需要哪類協助", general: "一般協助", coding: "程式／除錯", review: "審查", subject: "主旨", text: "信件內容", repo: "專案路徑（選填）", send: "寄出信件", follow: "插話或追問", stop: "停止這件事", stopNote: "停止待處理信件與後續投遞。已在執行的一輪可能繼續完成，回覆仍會保留。", reassign: "改派待處理信件", route: "投遞路徑", participants: "參與者", activity: "最近活動", agent: "可收信的 agents", delivery: "自動投遞", live: "運作中", offline: "尚未回報", offlineNote: "Web 投遞程序尚未回報。郵局仍可收信；若沒有收到回覆，請檢查 runner。", rule: "指定收件者", capabilityRule: "依能力分派", fallback: "備援分派", view: "開啟對話", count: "件事", noSelection: "選擇一件事查看往返", paused: "已暫停", idle: "等待信件", updated: "更新時間", legacy: "先前的信件紀錄", legacyNote: "先前的請求與 session 紀錄仍保留在原收件匣。", unknown: "未知" },
};
function letterParts(text) {
  const raw = String(text || "");
  const block = matchMailBlock(raw);
  if (block) {
    try {
      const request = JSON.parse(block[1]);
      if (request && typeof request === "object" && !Array.isArray(request)
        && typeof request.text === "string"
        && ["to", "capability", "model", "effort"].every((key) => request[key] == null || typeof request[key] === "string")) {
        return { text: raw.slice(0, block.index).trim(), request };
      }
    } catch { /* Preserve malformed letters for inspection. */ }
  }
  return { text: raw, request: null };
}
function readableLetter(text, copy) {
  const letter = letterParts(text);
  return [letter.text, letter.request ? `${copy.request} → ${letter.request.to || copy.auto}\n${letter.request.text}` : ""].filter(Boolean).join("\n");
}
function mailTags(values, c, locale) {
  const labels = { to: c.recipient, capability: c.capability,
    model: locale === "zh-Hant" ? "模型" : "Model", effort: locale === "zh-Hant" ? "思考" : "Effort", round: locale === "zh-Hant" ? "輪次" : "Round" };
  const tags = Object.entries(labels).filter(([key]) => values[key]).map(([key, label]) =>
    `<span class="postal-tag"><span>${escape(label)}</span><b>${escape(key === "capability" ? c[values[key]] || values[key] : values[key])}</b></span>`).join("");
  return tags ? `<div class="postal-tags">${tags}</div>` : "";
}
function renderLetter(text, c, locale, compact = false) {
  const letter = letterParts(text);
  const heading = `${c.request} → ${escape(letter.request?.to || c.auto)}`;
  const requestBody = letter.request ? `<pre class="postal-body">${escape(letter.request.text)}</pre>${mailTags({ ...letter.request, to: null }, c, locale)}` : "";
  return `${letter.text ? `<pre class="postal-body">${escape(letter.text)}</pre>` : ""}${letter.request
    ? compact ? `<details class="postal-handoff postal-compact"><summary>${heading}</summary>${requestBody}</details>`
      : `<div class="postal-handoff"><p class="postal-handoff-title">${heading}</p>${requestBody}</div>` : ""}`;
}
// Use ledger relationships, never text similarity, to distinguish speech from transport.
export function conversationEvents(current) {
  const letters = new Map(current.letters.map((m) => [m.id, m]));
  const delegated = new Map(current.letters.filter((m) => m.mail?.delivery_key?.startsWith("request:"))
    .map((m) => [m.mail.delivery_key.slice(8), m]));
  const linked = new Set([...delegated.values()].map((m) => m.id));
  const shownGroups = new Set();
  return current.timeline.flatMap((e) => {
    const source = letters.get(e.type === "reply" ? e.message_id : e.id);
    if (source?.status === "reassigned") return [];
    if (e.type === "result") {
      return e.status === "failed" || e.status === "working" || e.status === "queued"
        ? [{ ...e, text: "", transport: true }] : [];
    }
    if (e.type === "reply") {
      if (source?.status === "failed" && e.text.startsWith("Blocked:")) return [];
      const sent = delegated.get(e.id);
      return [{ ...e, status: sent?.status || (source?.status === "failed" ? "failed" : undefined), error: sent?.error || source?.error, compact: true }];
    }
    if (e.type === "request") {
      if (e.group) {
        if (shownGroups.has(e.group.id)) return [];
        shownGroups.add(e.group.id);
        const batch = current.letters.filter((m) => m.mail?.group?.id === e.group.id && m.status !== "reassigned");
        const status = ["failed", "working", "queued"].find((v) => batch.some((m) => m.status === v)) || "completed";
        return [{ ...e, from: e.group.round > 1 ? "Agent River" : e.from,
          text: e.group.round > 1 ? "" : e.text,
          to: batch.map((m) => m.to).join(" · "), status,
          error: batch.filter((m) => m.error).map((m) => `${m.to}: ${m.error}`).join("; ") || null }];
      }

      if (linked.has(e.id)) return [];
      return [{ ...e, compact: e.from !== "owner" }];
    }
    return [];
  });
}

const escape = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const date = (value, locale) => `<time datetime="${escape(value)}">${escape(new Date(value).toLocaleString(locale === "zh-Hant" ? "zh-TW" : "en-GB", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }))}</time>`;

export function renderMail(data, locale) {
  const c = COPY[locale] || COPY.en;
  const { threads, current, agents, delivery } = data;
  const label = (state) => c[state] || state;
  const badge = (state) => `<span class="status ${escape(state)}">${escape(label(state))}</span>`;
  const options = (auto = true, selected = "any") => `${auto ? `<option value="any">${c.auto}</option>` : ""}${agents.map((a) => `<option value="${escape(a.name)}"${a.name === selected ? " selected" : ""}>${escape(a.name)} · ${escape(c[a.kind] || a.kind)}</option>`).join("")}`;
  const groupRecipients = (follow) => `<fieldset class="postal-group-fields" data-group-fields${follow && current?.groupParticipants?.length ? "" : " hidden disabled"}><legend>${locale === "zh-Hant" ? "群組收件者" : "Group recipients"}</legend><div class="postal-recipient-options">${agents.map((a) => `<label><input type="checkbox" name="targets" value="${escape(a.name)}"${!follow || current?.groupParticipants?.includes(a.name) ? " checked" : ""}><span>${escape(a.name === "opus" ? "Claude · opus" : a.name)}</span></label>`).join("")}</div><label class="postal-round-choice">${locale === "zh-Hant" ? "討論輪數" : "Discussion rounds"}<select name="rounds">${[1, 2, 3].map((n) => `<option value="${n}"${n === 3 ? " selected" : ""}>${locale === "zh-Hant" ? n === 1 ? "1 輪 · 各自回覆" : `${n} 輪 · 自動互相討論` : n === 1 ? "1 round · Individual replies" : `${n} rounds · Automatic discussion`}</option>`).join("")}</select></label><p class="postal-route">${locale === "zh-Hant" ? "每輪等所有收件者回覆，再一起讀取彼此意見。最後一輪整理共識與分歧；途中可停止。各自沿用模型設定。" : "Each round waits for all replies, then everyone reads their peers’ views. The final round summarizes agreement and differences. Stop at any time; agents use their own models."}</p></fieldset>`;
  const form = (follow = false) => `<form class="request-form postal-form" action="${follow ? `/api/mail/${encodeURIComponent(current.id)}/messages` : "/api/mail"}" method="post" data-success="mail">
    ${!current?.groupParticipants?.length ? `<label>${locale === "zh-Hant" ? "寄信方式" : "Delivery mode"}<select data-mail-mode><option value="single">${locale === "zh-Hant" ? "單一收件者" : "Single recipient"}</option><option value="group">${locale === "zh-Hant" ? "群組討論" : "Group discussion"}</option></select></label>` : ""}
    ${groupRecipients(follow)}
    <fieldset class="postal-single-fields" data-single-fields${follow && current?.groupParticipants?.length ? " hidden disabled" : ""}>
    <div class="postal-fields"><label>${c.recipient}<select name="target">${options(true, follow ? current.letters[0].to : "any")}</select></label>${!follow ? `<label>${c.capability}<select name="capability"><option value="auto">${c.auto}</option>${["general", "coding", "review"].map((v) => `<option value="${v}">${c[v]}</option>`).join("")}</select></label>` : ""}</div>
    <div class="postal-fields"><label>${locale === "zh-Hant" ? "模型（選填，留空沿用設定）" : "Model (optional, inherit if blank)"}<input name="model" maxlength="120" autocomplete="off" placeholder="gpt-5.6-luna / opus / deepseek-v4-flash"></label><label>${locale === "zh-Hant" ? "思考等級（依模型支援）" : "Reasoning effort (model dependent)"}<select name="effort"><option value="">${locale === "zh-Hant" ? "沿用設定" : "Inherit configuration"}</option>${["off", "none", "minimal", "low", "medium", "high", "xhigh", "max", "auto"].map((v) => `<option value="${v}">${v}</option>`).join("")}</select></label></div>
    </fieldset>
    ${!follow ? `<label>${c.subject}<input name="subject" maxlength="120" autocomplete="off"></label>` : ""}
    <label>${follow ? c.follow : c.text}<textarea name="request" rows="${follow ? 4 : 9}" maxlength="16000" required></textarea></label>
    ${!follow ? `<label>${c.repo}<input name="repo" autocomplete="off"></label>` : ""}<button type="submit">${c.send}</button></form>`;
  const list = `<section class="postal-list" aria-label="${c.title}"><div class="postal-list-head"><b>${threads.length} ${c.count}</b><a href="/mail/new">＋ ${c.new}</a></div><label class="postal-search"><span class="sr-only">${c.search}</span><input type="search" placeholder="${c.search}" data-mail-search></label><div class="postal-filters" role="group" aria-label="${c.title}">${["all", "queued", "working", "failed", "completed"].map((v) => `<button type="button" data-mail-filter="${v}" aria-pressed="${v === "all"}">${c[v]}</button>`).join("")}</div><div class="postal-letters">${threads.map((thread) => `<a class="postal-letter${thread.id === current?.id ? " selected" : ""}" href="/mail/${encodeURIComponent(thread.id)}" data-mail-status="${escape(thread.status)}" data-mail-search-text="${escape(`${thread.subject} ${thread.participants.join(" ")} ${readableLetter(thread.summary, c)}`.toLowerCase())}"><div class="row-title"><b>${escape(thread.from)}</b>${badge(thread.status)}</div><h3>${escape(thread.subject)}</h3><p>${escape(readableLetter(thread.summary, c).slice(0, 140))}</p><div class="postal-letter-foot"><span>${escape(thread.participants.join(" → "))}</span>${date(thread.updatedAt, locale)}</div></a>`).join("") || `<p class="empty">${c.empty}</p>`}</div><a class="postal-legacy" href="/inbox">${c.legacy} →</a></section>`;
  const renderEvent = (e, full = false) => `<article class="postal-event ${escape(e.type)}"><div class="postal-event-head"><span class="avatar">${escape((e.from || "AR").slice(0, 2).toUpperCase())}</span><div><b>${escape(e.from || "Agent River")}${e.to ? ` → ${escape(e.to)}` : ""}</b><small>${escape(label(e.type))}${e.status ? ` · ${escape(label(e.status))}` : ""}</small></div>${date(e.created_at, locale)}</div>${full && e.reason ? `<p class="postal-route">${c.route}: ${escape(e.reason.replace("direct:", `${c.rule}: `).replace("capability:", `${c.capabilityRule}: `).replace("fallback:", `${c.fallback}: `))}</p>` : ""}${mailTags({ model: e.model, effort: e.effort, round: e.group?.round ? `${e.group.round} / ${e.group.rounds}` : null }, c, locale)}${e.transport ? `<p class="postal-route">${locale === "zh-Hant" ? "結果轉送" : "Result delivery"} → ${escape(e.to)} · ${escape(label(e.status))}</p>` : e.compact && e.type === "request" ? `<details class="postal-handoff postal-compact"><summary>${c.request} → ${escape(e.to)}</summary>${renderLetter(e.text, c, locale)}</details>` : renderLetter(e.text, c, locale, !full && e.compact)}${e.error ? `<p class="postal-error">${escape(e.error)}</p>` : ""}</article>`;
  const events = current ? conversationEvents(current) : [];
  const currentRound = current?.letters.filter((m) => m.mail?.group?.round).at(-1)?.mail.group;
  const earlier = events.slice(0, -1).filter((e) => !["working", "queued", "failed"].includes(e.status));
  const earlierIds = new Set(earlier.map((e) => e.id));
  const history = earlier.length ? `<details class="postal-history"><summary>${locale === "zh-Hant" ? "先前對話" : "Earlier conversation"} · ${earlier.length}</summary>${earlier.map((e) => `<details class="postal-history-item"><summary><b>${escape(e.from || "Agent River")}${e.to ? ` → ${escape(e.to)}` : ""}</b><span>${escape(readableLetter(e.text, c).replace(/\s+/g, " ").slice(0, 72))}</span></summary>${renderEvent(e)}</details>`).join("")}</details>` : "";
  const reader = `<section class="postal-reader">${current ? `<div class="postal-subject"><p class="eyebrow">${c.view}</p><h2>${escape(current.subject)}</h2><div class="postal-meta">${badge(current.status)}<span>${escape(current.participants.join(" · "))}</span>${currentRound ? mailTags({ round: `${currentRound.round} / ${currentRound.rounds}` }, c, locale) : ""}</div></div><div class="postal-timeline">${history}${events.filter((e) => !earlierIds.has(e.id)).map((e) => renderEvent(e)).join("")}<details class="postal-records"><summary>${locale === "zh-Hant" ? "投遞紀錄" : "Delivery records"} · ${current.timeline.length}</summary><div>${current.timeline.map((e) => renderEvent(e, true)).join("")}</div></details></div>${!current.stopped ? `<details class="postal-followup"><summary>${c.follow}</summary>${form(true)}</details>` : `<p class="postal-stop-note">${c.stopNote}</p>`}` : `<div class="postal-subject"><p class="eyebrow">${c.title}</p><h2>${c.new}</h2><p>${c.start}</p></div>${form()}`}</section>`;
  const info = `<aside class="postal-info"><section><h2>${c.delivery}</h2><p class="delivery-state ${delivery.fresh ? "live" : "offline"}"><span></span>${delivery.fresh ? c.live : c.offline}</p>${!delivery.fresh ? `<p>${c.offlineNote}</p>` : Object.entries(delivery.lanes).map(([name, lane]) => `<p><b>${escape(name)}</b> · ${escape(label(lane.status))}${lane.reason ? `<br><small>${escape(lane.reason)}</small>` : ""}${lane.error ? `<br><small>${escape(lane.error)}</small>` : ""}</p>`).join("")}</section><section><h2>${current ? c.participants : c.agent}</h2>${agents.filter((a) => !current || current.participants.includes(a.name)).map((a) => `<div class="postal-agent"><span class="avatar">${escape(a.name.slice(0, 2).toUpperCase())}</span><div><b>${escape(a.name)}</b><small>${escape(c[a.kind] || a.kind)} · ${escape(a.style)}</small></div></div>`).join("")}</section>${current ? `<section><h2>${c.activity}</h2>${date(current.updatedAt, locale)}${current.repo ? `<p class="postal-path">${escape(current.repo)}</p>` : ""}<small class="postal-path postal-id">${escape(current.id)}</small></section>${!current.stopped ? `<section><h2>${c.reassign}</h2>${current.letters.filter((m) => m.canReassign).map((m) => `<form class="request-form" action="/api/mail/letters/${encodeURIComponent(m.id)}/reassign" method="post" data-success="mail"><label>${escape(m.to)} · ${escape(m.text.slice(0, 45))}<select name="target">${options(false)}</select></label><button type="submit">${c.reassign}</button></form>`).join("")}<button type="button" class="action-button destructive" data-endpoint="/api/mail/${encodeURIComponent(current.id)}/stop" data-confirm="stop">${c.stop}</button><p>${c.stopNote}</p></section>` : ""}` : `<section><h2>${c.legacy}</h2><p>${c.legacyNote}</p><a href="/inbox">${c.legacy} →</a></section>`}</aside>`;
  return `<div class="post-office">${list}${reader}${info}</div>`;
}
