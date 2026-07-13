import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createTranslator, detectLocale, listTranslationKeys, normalizeLocale } from "../src/web/i18n.js";
import { renderPage } from "../src/web/render.js";
import { startWebServer } from "../src/web/server.js";

test("locale detection prefers a supported cookie, then Accept-Language, then English", () => {
  assert.equal(detectLocale({
    cookieHeader: "other=x; agent_river_locale=zh-Hant",
    acceptLanguage: "en-US,en;q=0.9",
  }), "zh-Hant");
  assert.equal(detectLocale({
    cookieHeader: "agent_river_locale=unsupported",
    acceptLanguage: "en;q=0.4, zh-TW;q=0.9",
  }), "zh-Hant");
  assert.equal(detectLocale({ acceptLanguage: "fr-CA, de;q=0.8" }), "en");
  assert.equal(detectLocale({ acceptLanguage: "zh-CN" }), "en");
  assert.equal(normalizeLocale("EN_us"), "en");
  assert.equal(normalizeLocale("zh_Hant"), "zh-Hant");
  assert.equal(normalizeLocale("not-supported"), "en");
});

test("translator has a stable English fallback and rendered switch labels are escaped", () => {
  const fallback = createTranslator("unsupported");
  assert.equal(fallback("language.switch"), "Language");
  assert.equal(fallback("missing.key"), "missing.key");

  const html = renderPage({
    view: "unknown",
    title: "Locale plumbing",
    data: {},
    locale: "<script>",
    currentPath: "/inbox?next=\"><script>alert(1)</script>",
    t: () => "<img src=x onerror=alert(1)>",
  });
  assert.match(html, /<html lang="en">/);
  assert.doesNotMatch(html, /<img src=x|<script>alert/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test("translation catalogs have parity and placeholders preserve safe fallbacks", () => {
  assert.deepEqual(listTranslationKeys("zh-Hant"), listTranslationKeys("en"));
  const en = createTranslator("en");
  const zh = createTranslator("zh-Hant");
  assert.equal(en("common.messages", { count: 3 }), "3 messages");
  assert.equal(zh("common.messages", { count: 3 }), "3 則訊息");
  assert.equal(en("client.confirm", { label: "Approve" }), "Confirm Approve?");
  assert.equal(zh("client.confirm", { label: "核准" }), "確認「核准」？");
  assert.equal(en("client.completed", { label: "Approve" }), "Approve completed.");
  assert.equal(zh("client.completed", { label: "核准" }), "「核准」已完成。");
  assert.equal(zh("common.lastClaim"), "上次領取於 {time}");
  assert.equal(zh("missing.key", { count: 3 }), "missing.key");
});

test("English and Traditional Chinese renders localize chrome without changing operational contracts", () => {
  const item = {
    id: "dispatch_contract_01",
    type: "dispatch_request",
    title: "Dispatch codex to opus",
    sender: "codex",
    recipient: "opus",
    repo: "/workspace/agent-river",
    sessionId: "sess_contract_01",
    dispatchId: "dispatch_contract_01",
    status: "pending",
    summary: "Review the operational payload.",
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T00:01:00.000Z",
    rawPath: "/state/dispatch-approvals.jsonl",
    raw: { id: "dispatch_contract_01", status: "pending", command: "CANONICAL_PAYLOAD" },
  };
  const options = { view: "inbox-detail", title: item.title, data: item, csrfToken: "csrf_contract", currentPath: "/inbox/dispatch_contract_01" };
  const en = renderPage({ ...options, locale: "en" });
  const zh = renderPage({ ...options, locale: "zh-Hant" });

  assert.match(en, /Dispatch codex to opus/);
  assert.match(en, />Sender</);
  assert.match(en, />Approve</);
  assert.match(zh, /從 codex 派送至 opus/);
  assert.match(zh, />寄件者</);
  assert.match(zh, />核准</);
  assert.match(zh, /待處理/);
  assert.match(en, /name="client-i18n-confirm" content="Confirm \{label\}\?"/);
  assert.match(zh, /name="client-i18n-confirm" content="確認「\{label\}」？"/);
  assert.match(en, /name="client-i18n-request-failed" content="Request failed\."/);
  assert.match(zh, /name="client-i18n-request-failed" content="請求失敗。"/);
  for (const html of [en, zh]) {
    assert.match(html, /meta name="csrf-token" content="csrf_contract"/);
    assert.match(html, /class="status pending"/);
    assert.match(html, /data-endpoint="\/api\/dispatch\/dispatch_contract_01\/approve"/);
    assert.match(html, /data-confirm="approve"/);
    assert.match(html, /\/workspace\/agent-river/);
    assert.match(html, /sess_contract_01/);
    assert.match(html, /2026-07-13T00:00:00.000Z/);
    assert.match(html, /CANONICAL_PAYLOAD/);
    assert.match(html, /\/language\?locale=(?:en|zh-Hant)&amp;next=%2Finbox%2Fdispatch_contract_01/);
  }
});

test("representative zh-Hant pages translate dashboard, compose, cards, safety, and session chrome", () => {
  const zh = createTranslator("zh-Hant");
  const dashboard = renderPage({
    view: "dashboard",
    title: "Dashboard",
    locale: "zh-Hant",
    t: zh,
    data: { system: "available", activeAgents: 2, activeSessions: 1, pendingApprovals: 1, openInboxItems: 3, warnings: [], recentCompletions: [] },
  });
  assert.match(dashboard, /<title>總覽 · Agent River<\/title>/);
  assert.match(dashboard, /運作中的代理程式/);
  assert.match(dashboard, /最近完成/);

  const compose = renderPage({
    view: "compose",
    title: "New request",
    locale: "zh-Hant",
    t: zh,
    data: {
      targets: [{ name: "codex", style: "poll", primary: true }],
      sessionParticipants: [{ name: "codex", style: "poll", primary: true }, { name: "opus", style: "poll" }],
    },
  });
  assert.match(compose, /直接請求/);
  assert.match(compose, /多代理工作階段/);
  assert.match(compose, /送出請求/);
  assert.match(compose, /開啟工作階段/);
  assert.match(compose, /主要代理程式/);

  const agents = renderPage({
    view: "agents",
    title: "Agents",
    locale: "zh-Hant",
    t: zh,
    data: [{ name: "opus", status: "active", routingConfigured: true, routingEnabled: false, eligibleWorkCount: 2, lastClaimAt: "2026-07-13T01:00:00.000Z" }],
  });
  assert.match(agents, /派送路由已停用/);
  assert.match(agents, /2 個合資格工作項目/);
  assert.match(agents, /啟用路由/);

  const safety = renderPage({
    view: "safety",
    title: "Safety",
    locale: "zh-Hant",
    t: zh,
    data: { ownerAllowlist: {}, today: {}, runnerLocks: {}, serviceUnitFiles: {}, warnings: ["Kill switch is enabled"], killSwitch: false },
  });
  assert.match(safety, /緊急停止開關/);
  assert.match(safety, /危險區域/);
  assert.match(safety, /全部停止/);
  assert.match(safety, /緊急停止開關已啟用/);
});

test("Web locale switch persists a SameSite cookie and redirects only to a local path", async (t) => {
  const server = await startTestServer(t);

  const detected = await request(server, "/inbox", { headers: { "accept-language": "zh-TW,zh;q=0.9,en;q=0.8" } });
  assert.equal(detected.status, 200);
  assert.equal(detected.headers["content-language"], "zh-Hant");
  assert.match(detected.body, /<html lang="zh-Hant">/);
  assert.match(detected.body, /aria-label="語言"/);
  assert.match(detected.body, /<title>收件匣 · Agent River<\/title>/);
  assert.match(detected.body, /<h1>收件匣<\/h1>/);

  const switched = await request(server, "/language?locale=zh-Hant&next=%2Finbox%3Fstatus%3Dopen");
  assert.equal(switched.status, 302);
  assert.equal(switched.headers.location, "/inbox?status=open");
  assert.equal(switched.headers["set-cookie"].length, 1);
  assert.match(switched.headers["set-cookie"][0], /^agent_river_locale=zh-Hant;/);
  assert.match(switched.headers["set-cookie"][0], /HttpOnly/);
  assert.match(switched.headers["set-cookie"][0], /SameSite=Strict/);
  assert.doesNotMatch(switched.headers["set-cookie"][0], /agent_river_web/);

  const localeCookie = switched.headers["set-cookie"][0].split(";", 1)[0];
  const remembered = await request(server, "/inbox", {
    headers: { cookie: localeCookie, "accept-language": "en-US" },
  });
  assert.equal(remembered.headers["content-language"], "zh-Hant");
  assert.match(remembered.body, /<html lang="zh-Hant">/);

  for (const next of ["https%3A%2F%2Fevil.example%2F", "%2F%2Fevil.example%2F", "%5C%5Cevil.example"]) {
    const unsafe = await request(server, `/language?locale=en&next=${next}`);
    assert.equal(unsafe.status, 302);
    assert.equal(unsafe.headers.location, "/");
  }

  const unsupported = await request(server, "/language?locale=fr&next=%2Fagents");
  assert.equal(unsupported.headers.location, "/agents");
  assert.match(unsupported.headers["set-cookie"][0], /^agent_river_locale=en;/);

  const wrongHost = await request(server, "/language?locale=zh-Hant", { headers: { host: "attacker.example" } });
  assert.equal(wrongHost.status, 421);
  assert.equal(wrongHost.headers.location, undefined);
  assert.equal(wrongHost.headers["set-cookie"], undefined);
});

async function startTestServer(t) {
  const agentHome = fs.mkdtempSync(path.join(os.tmpdir(), "agent-web-i18n-"));
  const server = await startWebServer({ agentHome, port: 0 });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return server;
}

function request(server, requestPath, { headers = {} } = {}) {
  const port = server.address().port;
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: "127.0.0.1",
      port,
      path: requestPath,
      headers: { host: `127.0.0.1:${port}`, ...headers },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    req.on("error", reject);
    req.end();
  });
}
