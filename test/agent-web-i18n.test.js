import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createTranslator, detectLocale, normalizeLocale } from "../src/web/i18n.js";
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

test("Web locale switch persists a SameSite cookie and redirects only to a local path", async (t) => {
  const server = await startTestServer(t);

  const detected = await request(server, "/inbox", { headers: { "accept-language": "zh-TW,zh;q=0.9,en;q=0.8" } });
  assert.equal(detected.status, 200);
  assert.equal(detected.headers["content-language"], "zh-Hant");
  assert.match(detected.body, /<html lang="zh-Hant">/);
  assert.match(detected.body, /aria-label="語言"/);

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
