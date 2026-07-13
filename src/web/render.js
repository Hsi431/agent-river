import { createTranslator, normalizeLocale } from "./i18n.js";

const NAV = [
  ["/", "Dashboard"], ["/compose", "New request"], ["/inbox", "Inbox"], ["/dispatch", "Dispatch Gate"],
  ["/sessions", "Sessions"], ["/agents", "Agents"], ["/safety", "Safety"], ["/archive", "Archive"],
];

export function renderPage({ view, title, data, csrfToken, currentPath = "/", locale = "en", t = createTranslator(locale) }) {
  const main = renderView(view, data);
  const context = renderContext(view, data);
  const selectedLocale = normalizeLocale(locale);
  const next = encodeURIComponent(currentPath.startsWith("/") ? currentPath : "/");
  const autoRefresh = view === "inbox-detail" || view === "session-detail" ? " data-auto-refresh=\"5000\"" : "";
  return `<!doctype html>
<html lang="${escapeHtml(selectedLocale)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="csrf-token" content="${escapeHtml(csrfToken || "")}"><title>${escapeHtml(title)} · Agent River</title><link rel="stylesheet" href="/assets/styles.css"><script src="/assets/app.js" defer></script></head>
<body${autoRefresh}><div class="shell"><aside class="sidebar"><a class="brand" href="/"><span>AR</span><b>Agent River</b></a>
<a class="compose" href="/compose">＋ New request</a><nav>${NAV.map(([href, label]) => `<a href="${href}"${activeNav(view, href) ? " class=\"active\"" : ""}>${label}</a>`).join("")}</nav>
<footer>Local control plane<br><span>127.0.0.1 only</span></footer></aside>
<main><header><div><p class="eyebrow">Agent post office</p><h1>${escapeHtml(title)}</h1></div><div class="header-actions"><nav class="locale-switcher" aria-label="${escapeHtml(t("language.switch"))}"><a href="/language?locale=en&amp;next=${next}"${selectedLocale === "en" ? " aria-current=\"true\"" : ""}>${escapeHtml(t("language.en"))}</a><a href="/language?locale=zh-Hant&amp;next=${next}"${selectedLocale === "zh-Hant" ? " aria-current=\"true\"" : ""}>${escapeHtml(t("language.zh-Hant"))}</a></nav><span class="local-badge">LOCAL</span></div></header><div class="action-message" role="status" hidden></div>${main}</main>
<aside class="rail"><h2>Context</h2>${context}<div class="safety-note"><b>Safety-gated actions</b><p>Mutations reuse Agent River's existing domain checks.</p></div></aside></div></body></html>`;
}

function renderView(view, data) {
  if (view === "dashboard") return dashboard(data);
  if (view === "compose") return compose(data);
  if (view === "inbox") return itemList(data, "No inbox items yet.", inboxCard);
  if (view === "dispatch") return itemList(data, "No dispatch approvals.", dispatchCard);
  if (view === "sessions") return itemList(data, "No sessions recorded.", sessionCard);
  if (view === "agents") return itemList(data, "No agents registered.", agentCard);
  if (view === "archive") return itemList(data, "No completed records.", archiveCard);
  if (view === "safety") return safety(data);
  if (view === "inbox-detail") return inboxDetail(data);
  if (view === "session-detail") return sessionDetail(data);
  return empty("Unknown view");
}

function compose(data) {
  const targets = Array.isArray(data.targets) ? data.targets : [];
  const sessionParticipants = Array.isArray(data.sessionParticipants) ? data.sessionParticipants : [];
  const options = targets.map((target) => `<option value="${escapeHtml(target.name)}">${escapeHtml(joinMeta(target.name, target.style, target.primary ? "primary" : target.kind))}</option>`).join("");
  const participants = sessionParticipants.map((target) => `<label class="participant"><input type="checkbox" name="participants" value="${escapeHtml(target.name)}"><span>${escapeHtml(joinMeta(target.name, target.style, target.primary ? "primary" : target.kind))}</span></label>`).join("");
  const direct = targets.length ? `<form class="request-form" action="/api/requests" method="post" data-success="inbox">
    <label>Target agent<select name="target" required>${options}</select></label>
    <label>Subject <span>optional, 120 characters max</span><input name="subject" maxlength="120" autocomplete="off"></label>
    <label>Request<textarea name="request" rows="10" required></textarea></label>
    <label>Repository <span>optional, name or absolute path inside the configured workspace</span><input name="repo" autocomplete="off" spellcheck="false"></label>
    <button type="submit">Send request</button>
  </form>` : empty("No eligible direct request routes are available.");
  const session = sessionParticipants.length >= 2 ? `<form class="request-form" action="/api/sessions" method="post" data-success="session">
    <fieldset><legend>Participants <span>select at least two eligible agents</span></legend><div class="participant-grid">${participants}</div></fieldset>
    <label>Topic <span>5–500 characters</span><textarea name="topic" minlength="5" maxlength="500" rows="6" required></textarea></label>
    <label>Repository <span>optional, resolved through the configured workspace policy</span><input name="repo" autocomplete="off" spellcheck="false"></label>
    <div class="budget-fields"><label>Message budget <span>default 10</span><input name="budgetMessages" type="number" min="1" step="1" inputmode="numeric"></label><label>Minute budget <span>default 30</span><input name="budgetMinutes" type="number" min="1" step="1" inputmode="numeric"></label></div>
    <button type="submit">Open session</button>
  </form>` : empty("At least two eligible session participants are required.");
  return `<div class="compose-modes"><section class="panel compose-panel"><div class="compose-heading"><p class="eyebrow">Direct request</p><h2>One agent, one mailbox item</h2></div>${direct}</section><section class="panel compose-panel"><div class="compose-heading"><p class="eyebrow">Multi-agent session</p><h2>Open a budgeted working session</h2></div>${session}</section></div>`;
}

function dashboard(data) {
  const metrics = [
    ["System", data.system], ["Active agents", data.activeAgents], ["Active sessions", data.activeSessions],
    ["Pending approvals", data.pendingApprovals], ["Open inbox", data.openInboxItems],
  ];
  return `<section class="metrics">${metrics.map(([label, value]) => `<article><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></article>`).join("")}</section>
  ${data.warnings?.length ? `<section class="panel warning"><h2>Safety warnings</h2>${data.warnings.map((item) => `<p>${escapeHtml(item)}</p>`).join("")}</section>` : ""}
  <section class="panel"><div class="section-head"><h2>Recent completions</h2><a href="/archive">View archive</a></div>${data.recentCompletions?.length ? data.recentCompletions.map(archiveCard).join("") : empty("No recent completions.")}</section>`;
}

function itemList(items, message, renderer) {
  return `<section class="panel list">${items.length ? items.map(renderer).join("") : empty(message)}</section>`;
}

function inboxCard(item) {
  return `<a class="row" href="/inbox/${encodeURIComponent(item.id)}"><div class="avatar">${initials(item.sender)}</div><div class="grow"><div class="row-title"><b>${escapeHtml(item.title)}</b>${status(item.status)}</div><p>${escapeHtml(item.summary || "No summary")}</p><small>${escapeHtml(joinMeta(item.sender, item.recipient, item.repo))}</small></div>${formatTime(item.updatedAt || item.createdAt)}</a>`;
}

function dispatchCard(item) {
  return `<article class="row"><div class="avatar gate">↗</div><div class="grow"><div class="row-title"><b>${escapeHtml(`${item.sender || "unknown"} → ${item.recipient || "unknown"}`)}</b>${status(item.status)}</div><p>${escapeHtml(item.summary || item.task || "No task")}</p><small>${escapeHtml(joinMeta(item.requestedMode, item.repo, item.reason))}</small></div><div class="actions"><a href="/inbox/${encodeURIComponent(item.id)}">Inspect</a>${item.status === "pending" ? `${actionButton("Approve", `/api/dispatch/${encodeURIComponent(item.id)}/approve`, "approve")}${actionButton("Reject", `/api/dispatch/${encodeURIComponent(item.id)}/reject`, "reject", true)}` : ""}</div></article>`;
}

function sessionCard(item) {
  return `<a class="row" href="/sessions/${encodeURIComponent(item.id)}"><div class="avatar session">#</div><div class="grow"><div class="row-title"><b>${escapeHtml(item.topic || item.id)}</b>${status(item.status)}</div><p>${escapeHtml((item.agents || []).join(" · ") || "No participants")}</p><small>${escapeHtml(joinMeta(item.repo, `${item.messageCount ?? 0} messages`))}</small></div>${formatTime(item.lastActivity)}</a>`;
}

function agentCard(item) {
  const routing = item.routingEnabled === true ? "dispatch route enabled" : (item.routingConfigured ? "dispatch route disabled" : "dispatch route unconfigured");
  const routeEligible = !item.primary && (item.status === "active" || (!item.status && item.routingConfigured));
  const control = !routeEligible ? "" : item.routingEnabled === true
    ? actionButton("Disable routing", `/api/agents/${encodeURIComponent(item.name)}/disable`, "disable", true)
    : actionButton("Enable routing", `/api/agents/${encodeURIComponent(item.name)}/enable`, "enable");
  return `<article class="row"><div class="avatar">${initials(item.name)}</div><div class="grow"><div class="row-title"><b>${escapeHtml(item.name)}</b><span class="badges">${status(item.status || "unregistered")}${status(routing)}</span></div><p>${escapeHtml(joinMeta(item.kind, item.style, item.primary ? "primary" : null))}</p><small>${escapeHtml(`${item.eligibleWorkCount || 0} eligible work items${item.lastClaimAt ? ` · last claim ${item.lastClaimAt}` : ""}`)}</small></div>${control ? `<div class="actions">${control}</div>` : ""}</article>`;
}

function archiveCard(item) {
  if (item.type === "session") return sessionCard(item);
  return inboxCard(item);
}

function safety(data) {
  const facts = [
    ["Kill switch", data.killSwitch ? "enabled" : "disabled"], ["Telegram owners", data.ownerAllowlist?.telegramCount],
    ["Gateway users", data.ownerAllowlist?.gatewayCount], ["v2 routing", onOff(data.v2RoutingEnabled)],
    ["Workspace root", data.workspaceRoot], ["Default repo", data.defaultRepo], ["Daily budget", data.dailyBudget],
    ["Tokens today", data.today?.tokens], ["Dashboard lock file", data.dashboardLockPresent ? "present" : "absent"],
    ["Opus runner lock file", data.runnerLocks?.opus ? "present" : "absent"],
    ["Codex runner lock file", data.runnerLocks?.codex ? "present" : "absent"],
    ["Exec runner lock file", data.runnerLocks?.exec ? "present" : "absent"],
    ["Dashboard unit file", data.serviceUnitFiles?.dashboard?.drift || "not reported"],
    ["Opus unit file", data.serviceUnitFiles?.opus?.drift || "not reported"],
    ["Codex unit file", data.serviceUnitFiles?.codex?.drift || "not reported"],
    ["Exec unit file", data.serviceUnitFiles?.exec?.drift || "not reported"],
    ["Web unit file", data.serviceUnitFiles?.web?.drift || "not reported"],
    ["Exchange runner", onOff(data.exchangeRunnerEnabled)], ["Secret scan", data.secretScanStatus || "not reported"],
  ];
  return `<section class="panel"><div class="facts">${facts.map(([label, value]) => fact(label, value)).join("")}</div></section>
  ${data.warnings?.length ? `<section class="panel warning"><h2>Warnings</h2>${data.warnings.map((item) => `<p>${escapeHtml(item)}</p>`).join("")}</section>` : ""}
  <section class="panel danger"><h2>Danger zone</h2><p>Stop persists the kill switch. This Web process cannot synchronously terminate turns owned by other processes.</p>${data.killSwitch ? status("enabled") : actionButton("Stop all", "/api/stop", "stop_all", true)}</section>`;
}

function inboxDetail(item) {
  const controls = item.type === "dispatch_request" && item.status === "pending"
    ? `<div class="detail-actions">${actionButton("Approve", `/api/dispatch/${encodeURIComponent(item.id)}/approve`, "approve")}${actionButton("Reject", `/api/dispatch/${encodeURIComponent(item.id)}/reject`, "reject", true)}</div>`
    : "";
  return `<section class="panel detail"><div class="row-title"><h2>${escapeHtml(item.title)}</h2>${status(item.status)}</div><p class="summary">${escapeHtml(item.summary || "No summary")}</p><div class="facts">${[
    ["Sender", item.sender], ["Recipient", item.recipient], ["Repo", item.repo], ["Session", item.sessionId],
    ["Dispatch", item.dispatchId], ["Created", item.createdAt], ["Updated", item.updatedAt], ["Ledger", item.rawPath],
  ].map(([label, value]) => fact(label, value)).join("")}</div>${controls}${rawDetails(item.raw)}</section>`;
}

function sessionDetail(item) {
  return `<section class="panel detail"><div class="row-title"><h2>${escapeHtml(item.topic || item.id)}</h2>${status(item.status)}</div><div class="facts">${[
    ["Session", item.id], ["Agents", item.agents?.join(", ")], ["Repo", item.repo], ["Messages", item.messageCount],
    ["Started", item.startedAt], ["Last activity", item.lastActivity], ["Transcript", item.transcriptPath],
  ].map(([label, value]) => fact(label, value)).join("")}</div>${item.status === "active" ? `<form class="request-form session-message-form" action="/api/sessions/${encodeURIComponent(item.id)}/messages" method="post" data-success="reload"><label>Owner instruction <span>broadcast once to every participant</span><textarea name="message" rows="4" required></textarea></label><button type="submit">Send instruction</button></form><div class="detail-actions">${actionButton("Kill session", `/api/sessions/${encodeURIComponent(item.id)}/kill`, "kill", true)}</div>` : ""}</section><section class="panel timeline"><h2>Audit timeline</h2>${item.timeline?.length ? item.timeline.map(timelineRow).join("") : empty("No transcript events.")}</section>${rawDetails(item.raw)}`;
}

function timelineRow(row) {
  return `<article><div><b>${escapeHtml(row.from || row.type)}</b><span> → ${escapeHtml(Array.isArray(row.to) ? row.to.join(", ") : row.to || "")}</span></div><p>${escapeHtml(row.text || row.type)}</p>${formatTime(row.createdAt)}</article>`;
}

function renderContext(view, data) {
  if (Array.isArray(data)) return `${fact("Visible records", data.length)}${fact("View", view)}`;
  if (view === "dashboard") return `${fact("System", data.system)}${fact("Warnings", data.warnings?.length || 0)}`;
  if (view === "compose") return `${fact("Direct targets", data.targets?.length || 0)}${fact("Session participants", data.sessionParticipants?.length || 0)}${fact("Channel", "web")}`;
  return `${fact("Record", data.id || data.sessionId || view)}${fact("Status", data.status || "current")}${data.rawPath ? fact("Source", data.rawPath) : ""}`;
}

function rawDetails(raw) {
  return `<details class="raw"><summary>Raw JSON</summary><pre>${escapeHtml(JSON.stringify(raw ?? null, null, 2))}</pre></details>`;
}

function fact(label, value) {
  return `<div class="fact"><span>${escapeHtml(label)}</span><b>${escapeHtml(value ?? "—")}</b></div>`;
}

function status(value) {
  const text = String(value || "unknown");
  return `<span class="status ${escapeHtml(text.toLowerCase().replace(/[^a-z0-9_-]/g, "-"))}">${escapeHtml(text.replaceAll("_", " "))}</span>`;
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

export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
}
