const NAV = [
  ["/", "Dashboard"], ["/inbox", "Inbox"], ["/dispatch", "Dispatch Gate"],
  ["/sessions", "Sessions"], ["/agents", "Agents"], ["/safety", "Safety"], ["/archive", "Archive"],
];

export function renderPage({ view, title, data }) {
  const main = renderView(view, data);
  const context = renderContext(view, data);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} · Agent River</title><link rel="stylesheet" href="/assets/styles.css"><script src="/assets/app.js" defer></script></head>
<body><div class="shell"><aside class="sidebar"><a class="brand" href="/"><span>AR</span><b>Agent River</b></a>
<button class="compose" disabled title="Write actions are not enabled">＋ New request</button><nav>${NAV.map(([href, label]) => `<a href="${href}"${activeNav(view, href) ? " class=\"active\"" : ""}>${label}</a>`).join("")}</nav>
<footer>Local control plane<br><span>127.0.0.1 only</span></footer></aside>
<main><header><div><p class="eyebrow">Agent post office</p><h1>${escapeHtml(title)}</h1></div><span class="local-badge">LOCAL</span></header>${main}</main>
<aside class="rail"><h2>Context</h2>${context}<div class="safety-note"><b>Read-only surface</b><p>Actions remain disabled until they can reuse the existing safety gates.</p></div></aside></div></body></html>`;
}

function renderView(view, data) {
  if (view === "dashboard") return dashboard(data);
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
  return `<article class="row"><div class="avatar gate">↗</div><div class="grow"><div class="row-title"><b>${escapeHtml(`${item.sender || "unknown"} → ${item.recipient || "unknown"}`)}</b>${status(item.status)}</div><p>${escapeHtml(item.summary || item.task || "No task")}</p><small>${escapeHtml(joinMeta(item.requestedMode, item.repo, item.reason))}</small></div><div class="actions"><a href="/inbox/${encodeURIComponent(item.id)}">Inspect</a><button disabled>Approve</button><button disabled>Reject</button></div></article>`;
}

function sessionCard(item) {
  return `<a class="row" href="/sessions/${encodeURIComponent(item.id)}"><div class="avatar session">#</div><div class="grow"><div class="row-title"><b>${escapeHtml(item.topic || item.id)}</b>${status(item.status)}</div><p>${escapeHtml((item.agents || []).join(" · ") || "No participants")}</p><small>${escapeHtml(joinMeta(item.repo, `${item.messageCount ?? 0} messages`))}</small></div>${formatTime(item.lastActivity)}</a>`;
}

function agentCard(item) {
  const routing = item.routingEnabled === true ? "routing enabled" : (item.routingEnabled === false ? "routing disabled" : "routing unknown");
  return `<article class="row"><div class="avatar">${initials(item.name)}</div><div class="grow"><div class="row-title"><b>${escapeHtml(item.name)}</b><span class="badges">${status(item.status || "unregistered")}${status(routing)}</span></div><p>${escapeHtml(joinMeta(item.kind, item.style, item.primary ? "primary" : null))}</p><small>${escapeHtml(`${item.eligibleWorkCount || 0} eligible work items${item.lastClaimAt ? ` · last claim ${item.lastClaimAt}` : ""}`)}</small></div></article>`;
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
    ["Exchange runner", onOff(data.exchangeRunnerEnabled)], ["Secret scan", data.secretScanStatus || "not reported"],
  ];
  return `<section class="panel"><div class="facts">${facts.map(([label, value]) => fact(label, value)).join("")}</div></section>
  ${data.warnings?.length ? `<section class="panel warning"><h2>Warnings</h2>${data.warnings.map((item) => `<p>${escapeHtml(item)}</p>`).join("")}</section>` : ""}
  <section class="panel danger"><h2>Danger zone</h2><p>Stopping all work requires the existing persistent kill switch and process termination path.</p><button disabled>Stop all</button></section>`;
}

function inboxDetail(item) {
  return `<section class="panel detail"><div class="row-title"><h2>${escapeHtml(item.title)}</h2>${status(item.status)}</div><p class="summary">${escapeHtml(item.summary || "No summary")}</p><div class="facts">${[
    ["Sender", item.sender], ["Recipient", item.recipient], ["Repo", item.repo], ["Session", item.sessionId],
    ["Dispatch", item.dispatchId], ["Created", item.createdAt], ["Updated", item.updatedAt], ["Ledger", item.rawPath],
  ].map(([label, value]) => fact(label, value)).join("")}</div><div class="detail-actions"><button disabled>Approve</button><button disabled>Reject</button><button disabled>Archive</button></div>${rawDetails(item.raw)}</section>`;
}

function sessionDetail(item) {
  return `<section class="panel detail"><div class="row-title"><h2>${escapeHtml(item.topic || item.id)}</h2>${status(item.status)}</div><div class="facts">${[
    ["Session", item.id], ["Agents", item.agents?.join(", ")], ["Repo", item.repo], ["Messages", item.messageCount],
    ["Started", item.startedAt], ["Last activity", item.lastActivity], ["Transcript", item.transcriptPath],
  ].map(([label, value]) => fact(label, value)).join("")}</div><div class="detail-actions"><button disabled>Kill session</button><button disabled>Archive</button></div></section><section class="panel timeline"><h2>Audit timeline</h2>${item.timeline?.length ? item.timeline.map(timelineRow).join("") : empty("No transcript events.")}</section>${rawDetails(item.raw)}`;
}

function timelineRow(row) {
  return `<article><div><b>${escapeHtml(row.from || row.type)}</b><span> → ${escapeHtml(Array.isArray(row.to) ? row.to.join(", ") : row.to || "")}</span></div><p>${escapeHtml(row.text || row.type)}</p>${formatTime(row.createdAt)}</article>`;
}

function renderContext(view, data) {
  if (Array.isArray(data)) return `${fact("Visible records", data.length)}${fact("View", view)}`;
  if (view === "dashboard") return `${fact("System", data.system)}${fact("Warnings", data.warnings?.length || 0)}`;
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

function empty(message) { return `<div class="empty">${escapeHtml(message)}</div>`; }
function onOff(value) { return value ? "enabled" : "disabled"; }
function initials(value) { return escapeHtml(String(value || "?").slice(0, 2).toUpperCase()); }
function joinMeta(...values) { return values.filter(Boolean).join(" · "); }
function formatTime(value) { return value ? `<time datetime="${escapeHtml(value)}">${escapeHtml(value)}</time>` : ""; }
function activeNav(view, href) { return href === "/" ? view === "dashboard" : view.startsWith(href.slice(1)); }

export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
}
