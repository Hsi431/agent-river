import { createTranslator, normalizeLocale } from "./i18n.js";

const NAV = [
  ["/", "nav.dashboard"], ["/compose", "nav.compose"], ["/inbox", "nav.inbox"], ["/dispatch", "nav.dispatch"],
  ["/sessions", "nav.sessions"], ["/agents", "nav.agents"], ["/safety", "nav.safety"], ["/archive", "nav.archive"],
];

const PAGE_TITLES = {
  dashboard: "page.dashboard", compose: "page.compose", inbox: "page.inbox", dispatch: "page.dispatch",
  sessions: "page.sessions", agents: "page.agents", safety: "page.safety", archive: "page.archive",
};

const KNOWN_STATUSES = new Set([
  "unknown", "current", "available", "open", "unread", "working", "ready_to_review", "needs_approval",
  "pending", "active", "approved", "rejected", "archived", "failed", "done", "completed", "cancelled",
  "closed_ok", "exhausted", "killed", "stopped", "enabled", "disabled", "unregistered",
]);

const KNOWN_VALUES = new Set(["enabled", "disabled", "present", "absent", "missing", "match", "drifted"]);
const CLIENT_MESSAGES = [
  ["confirm", "client.confirm"], ["running", "client.running"], ["completed", "client.completed"],
  ["submitting", "client.submitting"], ["action-failed", "client.actionFailed"], ["request-failed", "client.requestFailed"],
];

export function renderPage({ view, title, data, csrfToken, currentPath = "/", locale = "en", t = createTranslator(locale) }) {
  const displayTitle = PAGE_TITLES[view] ? t(PAGE_TITLES[view]) : view === "inbox-detail" ? displayItemTitle(data, t) : title;
  const main = renderView(view, data, t);
  const context = renderContext(view, data, t);
  const selectedLocale = normalizeLocale(locale);
  const next = encodeURIComponent(currentPath.startsWith("/") ? currentPath : "/");
  const autoRefresh = view === "inbox-detail" || view === "session-detail" ? " data-auto-refresh=\"5000\"" : "";
  const clientMessages = CLIENT_MESSAGES.map(([name, key]) => `<meta name="client-i18n-${name}" content="${escapeHtml(t(key))}">`).join("");
  return `<!doctype html>
<html lang="${escapeHtml(selectedLocale)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="csrf-token" content="${escapeHtml(csrfToken || "")}">${clientMessages}<title>${escapeHtml(displayTitle)} · Agent River</title><link rel="stylesheet" href="/assets/styles.css"><script src="/assets/app.js" defer></script></head>
<body${autoRefresh}><div class="shell"><aside class="sidebar"><a class="brand" href="/"><span>AR</span><b>Agent River</b></a>
<a class="compose" href="/compose">＋ ${escapeHtml(t("nav.compose"))}</a><nav>${NAV.map(([href, key]) => `<a href="${href}"${activeNav(view, href) ? " class=\"active\"" : ""}>${escapeHtml(t(key))}</a>`).join("")}</nav>
<footer>${escapeHtml(t("shell.localControlPlane"))}<br><span>${escapeHtml(t("shell.localOnly"))}</span></footer></aside>
<main><header><div><p class="eyebrow">${escapeHtml(t("shell.postOffice"))}</p><h1>${escapeHtml(displayTitle)}</h1></div><div class="header-actions"><nav class="locale-switcher" aria-label="${escapeHtml(t("language.switch"))}"><a href="/language?locale=en&amp;next=${next}"${selectedLocale === "en" ? " aria-current=\"true\"" : ""}>${escapeHtml(t("language.en"))}</a><a href="/language?locale=zh-Hant&amp;next=${next}"${selectedLocale === "zh-Hant" ? " aria-current=\"true\"" : ""}>${escapeHtml(t("language.zh-Hant"))}</a></nav><span class="local-badge">${escapeHtml(t("shell.local"))}</span></div></header><div class="action-message" role="status" hidden></div>${main}</main>
<aside class="rail"><h2>${escapeHtml(t("shell.context"))}</h2>${context}<div class="safety-note"><b>${escapeHtml(t("shell.safetyActions"))}</b><p>${escapeHtml(t("shell.safetyNote"))}</p></div></aside></div></body></html>`;
}

function renderView(view, data, t) {
  if (view === "dashboard") return dashboard(data, t);
  if (view === "compose") return compose(data, t);
  if (view === "inbox") return itemList(data, t("empty.inbox"), (item) => inboxCard(item, t));
  if (view === "dispatch") return itemList(data, t("empty.dispatch"), (item) => dispatchCard(item, t));
  if (view === "sessions") return itemList(data, t("empty.sessions"), (item) => sessionCard(item, t));
  if (view === "agents") return itemList(data, t("empty.agents"), (item) => agentCard(item, t));
  if (view === "archive") return itemList(data, t("empty.archive"), (item) => archiveCard(item, t));
  if (view === "safety") return safety(data, t);
  if (view === "inbox-detail") return inboxDetail(data, t);
  if (view === "session-detail") return sessionDetail(data, t);
  return empty(t("empty.unknownView"));
}

function compose(data, t) {
  const targets = Array.isArray(data.targets) ? data.targets : [];
  const sessionParticipants = Array.isArray(data.sessionParticipants) ? data.sessionParticipants : [];
  const options = targets.map((target) => `<option value="${escapeHtml(target.name)}">${escapeHtml(joinMeta(target.name, target.style, target.primary ? t("common.primary") : target.kind))}</option>`).join("");
  const participants = sessionParticipants.map((target) => `<label class="participant"><input type="checkbox" name="participants" value="${escapeHtml(target.name)}"><span>${escapeHtml(joinMeta(target.name, target.style, target.primary ? t("common.primary") : target.kind))}</span></label>`).join("");
  const direct = targets.length ? `<form class="request-form" action="/api/requests" method="post" data-success="inbox">
    <label>${escapeHtml(t("compose.target"))}<select name="target" required>${options}</select></label>
    <label>${escapeHtml(t("compose.subject"))} <span>${escapeHtml(t("common.optional120"))}</span><input name="subject" maxlength="120" autocomplete="off"></label>
    <label>${escapeHtml(t("compose.request"))}<textarea name="request" rows="10" required></textarea></label>
    <label>${escapeHtml(t("compose.repository"))} <span>${escapeHtml(t("common.repoDirectHint"))}</span><input name="repo" autocomplete="off" spellcheck="false"></label>
    <button type="submit">${escapeHtml(t("compose.send"))}</button>
  </form>` : empty(t("empty.directRoutes"));
  const session = sessionParticipants.length >= 2 ? `<form class="request-form" action="/api/sessions" method="post" data-success="session">
    <fieldset><legend>${escapeHtml(t("compose.participants"))} <span>${escapeHtml(t("compose.participantsHint"))}</span></legend><div class="participant-grid">${participants}</div></fieldset>
    <label>${escapeHtml(t("compose.topic"))} <span>${escapeHtml(t("compose.topicHint"))}</span><textarea name="topic" minlength="5" maxlength="500" rows="6" required></textarea></label>
    <label>${escapeHtml(t("compose.repository"))} <span>${escapeHtml(t("common.repoSessionHint"))}</span><input name="repo" autocomplete="off" spellcheck="false"></label>
    <div class="budget-fields"><label>${escapeHtml(t("compose.messageBudget"))} <span>${escapeHtml(t("compose.default10"))}</span><input name="budgetMessages" type="number" min="1" step="1" inputmode="numeric"></label><label>${escapeHtml(t("compose.minuteBudget"))} <span>${escapeHtml(t("compose.default30"))}</span><input name="budgetMinutes" type="number" min="1" step="1" inputmode="numeric"></label></div>
    <button type="submit">${escapeHtml(t("compose.openSession"))}</button>
  </form>` : empty(t("empty.sessionParticipants"));
  return `<div class="compose-modes"><section class="panel compose-panel"><div class="compose-heading"><p class="eyebrow">${escapeHtml(t("compose.direct"))}</p><h2>${escapeHtml(t("compose.directDescription"))}</h2></div>${direct}</section><section class="panel compose-panel"><div class="compose-heading"><p class="eyebrow">${escapeHtml(t("compose.session"))}</p><h2>${escapeHtml(t("compose.sessionDescription"))}</h2></div>${session}</section></div>`;
}

function dashboard(data, t) {
  const metrics = [
    [t("dashboard.system"), displayStatus(data.system, t)], [t("dashboard.activeAgents"), data.activeAgents], [t("dashboard.activeSessions"), data.activeSessions],
    [t("dashboard.pendingApprovals"), data.pendingApprovals], [t("dashboard.openInbox"), data.openInboxItems],
  ];
  return `<section class="metrics">${metrics.map(([label, value]) => `<article><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></article>`).join("")}</section>
  ${data.warnings?.length ? `<section class="panel warning"><h2>${escapeHtml(t("dashboard.safetyWarnings"))}</h2>${data.warnings.map((item) => `<p>${escapeHtml(displayWarning(item, t))}</p>`).join("")}</section>` : ""}
  <section class="panel"><div class="section-head"><h2>${escapeHtml(t("dashboard.recentCompletions"))}</h2><a href="/archive">${escapeHtml(t("dashboard.viewArchive"))}</a></div>${data.recentCompletions?.length ? data.recentCompletions.map((item) => archiveCard(item, t)).join("") : empty(t("empty.recent"))}</section>`;
}

function itemList(items, message, renderer) {
  return `<section class="panel list">${items.length ? items.map(renderer).join("") : empty(message)}</section>`;
}

function inboxCard(item, t) {
  return `<a class="row" href="/inbox/${encodeURIComponent(item.id)}"><div class="avatar">${initials(item.sender)}</div><div class="grow"><div class="row-title"><b>${escapeHtml(displayItemTitle(item, t))}</b>${status(item.status, t)}</div><p>${escapeHtml(item.summary || t("common.noSummary"))}</p><small>${escapeHtml(joinMeta(item.sender, item.recipient, item.repo))}</small></div>${formatTime(item.updatedAt || item.createdAt)}</a>`;
}

function dispatchCard(item, t) {
  return `<article class="row"><div class="avatar gate">↗</div><div class="grow"><div class="row-title"><b>${escapeHtml(`${item.sender || t("common.unknown")} → ${item.recipient || t("common.unknown")}`)}</b>${status(item.status, t)}</div><p>${escapeHtml(item.summary || item.task || t("common.noTask"))}</p><small>${escapeHtml(joinMeta(item.requestedMode, item.repo, item.reason))}</small></div><div class="actions"><a href="/inbox/${encodeURIComponent(item.id)}">${escapeHtml(t("action.inspect"))}</a>${item.status === "pending" ? `${actionButton(t("action.approve"), `/api/dispatch/${encodeURIComponent(item.id)}/approve`, "approve")}${actionButton(t("action.reject"), `/api/dispatch/${encodeURIComponent(item.id)}/reject`, "reject", true)}` : ""}</div></article>`;
}

function sessionCard(item, t) {
  return `<a class="row" href="/sessions/${encodeURIComponent(item.id)}"><div class="avatar session">#</div><div class="grow"><div class="row-title"><b>${escapeHtml(item.topic || item.id)}</b>${status(item.status, t)}</div><p>${escapeHtml((item.agents || []).join(" · ") || t("common.noParticipants"))}</p><small>${escapeHtml(joinMeta(item.repo, t("common.messages", { count: item.messageCount ?? 0 })))}</small></div>${formatTime(item.lastActivity)}</a>`;
}

function agentCard(item, t) {
  const routing = item.routingEnabled === true ? "enabled" : (item.routingConfigured ? "disabled" : "unconfigured");
  const routeEligible = !item.primary && (item.status === "active" || (!item.status && item.routingConfigured));
  const control = !routeEligible ? "" : item.routingEnabled === true
    ? actionButton(t("action.disableRouting"), `/api/agents/${encodeURIComponent(item.name)}/disable`, "disable", true)
    : actionButton(t("action.enableRouting"), `/api/agents/${encodeURIComponent(item.name)}/enable`, "enable");
  const routingLabel = routing === "enabled" ? t("agent.routeEnabled") : routing === "disabled" ? t("agent.routeDisabled") : t("agent.routeUnconfigured");
  const work = t("common.eligibleWork", { count: item.eligibleWorkCount || 0 });
  const claim = item.lastClaimAt ? t("common.lastClaim", { time: item.lastClaimAt }) : null;
  return `<article class="row"><div class="avatar">${initials(item.name)}</div><div class="grow"><div class="row-title"><b>${escapeHtml(item.name)}</b><span class="badges">${status(item.status || "unregistered", t)}${status(`dispatch-route-${routing}`, t, routingLabel)}</span></div><p>${escapeHtml(joinMeta(item.kind, item.style, item.primary ? t("common.primary") : null))}</p><small>${escapeHtml(joinMeta(work, claim))}</small></div>${control ? `<div class="actions">${control}</div>` : ""}</article>`;
}

function archiveCard(item, t) {
  if (item.type === "session") return sessionCard(item, t);
  return inboxCard(item, t);
}

function safety(data, t) {
  const facts = [
    [t("safety.killSwitch"), displayValue(data.killSwitch ? "enabled" : "disabled", t)], [t("safety.telegramOwners"), data.ownerAllowlist?.telegramCount],
    [t("safety.gatewayUsers"), data.ownerAllowlist?.gatewayCount], [t("safety.v2Routing"), displayValue(onOff(data.v2RoutingEnabled), t)],
    [t("safety.workspaceRoot"), data.workspaceRoot], [t("safety.defaultRepo"), data.defaultRepo], [t("safety.dailyBudget"), data.dailyBudget],
    [t("safety.tokensToday"), data.today?.tokens], [t("safety.dashboardLock"), displayValue(data.dashboardLockPresent ? "present" : "absent", t)],
    [t("safety.opusLock"), displayValue(data.runnerLocks?.opus ? "present" : "absent", t)],
    [t("safety.codexLock"), displayValue(data.runnerLocks?.codex ? "present" : "absent", t)],
    [t("safety.execLock"), displayValue(data.runnerLocks?.exec ? "present" : "absent", t)],
    [t("safety.dashboardUnit"), displayValue(data.serviceUnitFiles?.dashboard?.drift || "not reported", t)],
    [t("safety.opusUnit"), displayValue(data.serviceUnitFiles?.opus?.drift || "not reported", t)],
    [t("safety.codexUnit"), displayValue(data.serviceUnitFiles?.codex?.drift || "not reported", t)],
    [t("safety.execUnit"), displayValue(data.serviceUnitFiles?.exec?.drift || "not reported", t)],
    [t("safety.webUnit"), displayValue(data.serviceUnitFiles?.web?.drift || "not reported", t)],
    [t("safety.exchangeRunner"), displayValue(onOff(data.exchangeRunnerEnabled), t)], [t("safety.secretScan"), displayValue(data.secretScanStatus || "not reported", t)],
  ];
  return `<section class="panel"><div class="facts">${facts.map(([label, value]) => fact(label, value)).join("")}</div></section>
  ${data.warnings?.length ? `<section class="panel warning"><h2>${escapeHtml(t("safety.warnings"))}</h2>${data.warnings.map((item) => `<p>${escapeHtml(displayWarning(item, t))}</p>`).join("")}</section>` : ""}
  <section class="panel danger"><h2>${escapeHtml(t("safety.dangerZone"))}</h2><p>${escapeHtml(t("safety.stopLimitation"))}</p>${data.killSwitch ? status("enabled", t) : actionButton(t("action.stopAll"), "/api/stop", "stop_all", true)}</section>`;
}

function inboxDetail(item, t) {
  const controls = item.type === "dispatch_request" && item.status === "pending"
    ? `<div class="detail-actions">${actionButton(t("action.approve"), `/api/dispatch/${encodeURIComponent(item.id)}/approve`, "approve")}${actionButton(t("action.reject"), `/api/dispatch/${encodeURIComponent(item.id)}/reject`, "reject", true)}</div>`
    : "";
  return `<section class="panel detail"><div class="row-title"><h2>${escapeHtml(displayItemTitle(item, t))}</h2>${status(item.status, t)}</div><p class="summary">${escapeHtml(item.summary || t("common.noSummary"))}</p><div class="facts">${[
    [t("detail.sender"), item.sender], [t("detail.recipient"), item.recipient], [t("detail.repo"), item.repo], [t("detail.session"), item.sessionId],
    [t("detail.dispatch"), item.dispatchId], [t("detail.created"), item.createdAt], [t("detail.updated"), item.updatedAt], [t("detail.ledger"), item.rawPath],
  ].map(([label, value]) => fact(label, value)).join("")}</div>${controls}${rawDetails(item.raw, t)}</section>`;
}

function sessionDetail(item, t) {
  return `<section class="panel detail"><div class="row-title"><h2>${escapeHtml(item.topic || item.id)}</h2>${status(item.status, t)}</div><div class="facts">${[
    [t("detail.session"), item.id], [t("detail.agents"), item.agents?.join(", ")], [t("detail.repo"), item.repo], [t("detail.messages"), item.messageCount],
    [t("detail.started"), item.startedAt], [t("detail.lastActivity"), item.lastActivity], [t("detail.transcript"), item.transcriptPath],
  ].map(([label, value]) => fact(label, value)).join("")}</div>${item.status === "active" ? `<form class="request-form session-message-form" action="/api/sessions/${encodeURIComponent(item.id)}/messages" method="post" data-success="reload"><label>${escapeHtml(t("detail.ownerInstruction"))} <span>${escapeHtml(t("detail.broadcastHint"))}</span><textarea name="message" rows="4" required></textarea></label><button type="submit">${escapeHtml(t("action.sendInstruction"))}</button></form><div class="detail-actions">${actionButton(t("action.killSession"), `/api/sessions/${encodeURIComponent(item.id)}/kill`, "kill", true)}</div>` : ""}</section><section class="panel timeline"><h2>${escapeHtml(t("detail.auditTimeline"))}</h2>${item.timeline?.length ? item.timeline.map(timelineRow).join("") : empty(t("empty.timeline"))}</section>${rawDetails(item.raw, t)}`;
}

function timelineRow(row) {
  return `<article><div><b>${escapeHtml(row.from || row.type)}</b><span> → ${escapeHtml(Array.isArray(row.to) ? row.to.join(", ") : row.to || "")}</span></div><p>${escapeHtml(row.text || row.type)}</p>${formatTime(row.createdAt)}</article>`;
}

function renderContext(view, data, t) {
  if (Array.isArray(data)) return `${fact(t("context.visibleRecords"), data.length)}${fact(t("context.view"), displayView(view, t))}`;
  if (view === "dashboard") return `${fact(t("context.system"), displayStatus(data.system, t))}${fact(t("context.warnings"), data.warnings?.length || 0)}`;
  if (view === "compose") return `${fact(t("context.directTargets"), data.targets?.length || 0)}${fact(t("context.sessionParticipants"), data.sessionParticipants?.length || 0)}${fact(t("context.channel"), "web")}`;
  return `${fact(t("context.record"), data.id || data.sessionId || view)}${fact(t("context.status"), displayStatus(data.status || "current", t))}${data.rawPath ? fact(t("context.source"), data.rawPath) : ""}`;
}

function rawDetails(raw, t) {
  return `<details class="raw"><summary>${escapeHtml(t("detail.rawJson"))}</summary><pre>${escapeHtml(JSON.stringify(raw ?? null, null, 2))}</pre></details>`;
}

function fact(label, value) {
  return `<div class="fact"><span>${escapeHtml(label)}</span><b>${escapeHtml(value ?? "—")}</b></div>`;
}

function status(value, t, display = null) {
  const text = String(value || "unknown");
  return `<span class="status ${escapeHtml(text.toLowerCase().replace(/[^a-z0-9_-]/g, "-"))}">${escapeHtml(display || displayStatus(text, t))}</span>`;
}

function actionButton(label, endpoint, confirm, danger = false) {
  return `<button type="button" class="action-button${danger ? " destructive" : ""}" data-endpoint="${escapeHtml(endpoint)}" data-confirm="${escapeHtml(confirm)}">${escapeHtml(label)}</button>`;
}

function empty(message) { return `<div class="empty">${escapeHtml(message)}</div>`; }
function onOff(value) { return value ? "enabled" : "disabled"; }
function initials(value) { return escapeHtml(String(value || "?").slice(0, 2).toUpperCase()); }
function joinMeta(...values) { return values.filter(Boolean).join(" · "); }
function formatTime(value) { return value ? `<time datetime="${escapeHtml(value)}">${escapeHtml(value)}</time>` : ""; }
function activeNav(view, href) { return href === "/" ? view === "dashboard" : view.startsWith(href.slice(1)); }

function displayStatus(value, t) {
  const text = String(value || "unknown");
  return KNOWN_STATUSES.has(text) ? t(`status.${text}`) : text.replaceAll("_", " ");
}

function displayValue(value, t) {
  const text = String(value ?? "");
  if (text === "not reported") return t("value.notReported");
  return KNOWN_VALUES.has(text) ? t(`value.${text}`) : text;
}

function displayView(view, t) {
  return PAGE_TITLES[view] ? t(PAGE_TITLES[view]) : String(view || "");
}

function displayItemTitle(item, t) {
  if (item?.type === "exchange_message" && !item.raw?.message?.subject) {
    return t("common.messageFrom", { sender: item.sender || t("common.unknown") });
  }
  if (item?.type === "exchange_reply") {
    return t("common.replyFrom", { sender: item.sender || t("common.unknown") });
  }
  if (item?.type === "dispatch_request") {
    return t("common.dispatchTo", {
      sender: item.sender || t("common.unknown"),
      recipient: item.recipient || t("common.unknown"),
    });
  }
  if (item?.type === "system_alert") {
    return t("common.runnerFailure", { agent: item.sender || t("common.unknown") });
  }
  return item?.title || t("common.unknown");
}

function displayWarning(value, t) {
  const text = String(value || "");
  if (text === "Kill switch is enabled") return t("warning.killSwitch");
  if (text === "Daily token budget is exhausted") return t("warning.dailyBudget");
  const prefix = "Configuration is fail-closed: ";
  if (text.startsWith(prefix)) return t("warning.configClosed", { error: text.slice(prefix.length) });
  return text;
}

export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
}
