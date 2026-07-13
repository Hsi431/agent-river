import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const APP_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/web/assets/app.js");

test("client interaction templates interpolate without a browser-side translation dictionary", () => {
  const source = fs.readFileSync(APP_FILE, "utf8");
  const templates = new Map([
    ["confirm", "確認「{label}」？"],
    ["running", "正在執行「{label}」…"],
    ["completed", "「{label}」已完成。"],
    ["submitting", "正在送出…"],
    ["action-failed", "操作失敗。"],
    ["request-failed", "請求失敗。"],
  ]);
  const sandbox = browserSandbox(templates);
  vm.runInNewContext(source, sandbox);

  assert.equal(sandbox.clientMessage("confirm", { label: "核准" }), "確認「核准」？");
  assert.equal(sandbox.clientMessage("completed", { label: "<img src=x onerror=alert(1)>" }), "「<img src=x onerror=alert(1)>」已完成。");
  assert.doesNotMatch(source, /Confirm \$\{|Action failed\.|Request failed\.|Submitting…/);
  assert.match(source, /message\.textContent = text/);
  assert.doesNotMatch(source, /innerHTML/);
});

test("client localization preserves action endpoints, CSRF, confirmations, and relative navigation", () => {
  const source = fs.readFileSync(APP_FILE, "utf8");
  assert.match(source, /button\.dataset\.endpoint/);
  assert.match(source, /button\.dataset\.confirm/);
  assert.match(source, /"x-csrf-token": token/);
  assert.match(source, /fetch\(form\.action/);
  assert.match(source, /window\.location\.assign\("\/inbox"\)/);
  assert.match(source, /window\.location\.assign\(`\/sessions\/\$\{encodeURIComponent\(result\.sessionId\)\}`\)/);
  assert.doesNotMatch(source, /agent_river_locale|[?&]locale=/);
  assert.match(source, /result\.message \|\| result\.error \|\| `HTTP \$\{response\.status\}`/);
  assert.match(source, /result\.limitation \|\| clientMessage/);
});

function browserSandbox(templates) {
  const document = {
    activeElement: null,
    body: { dataset: {} },
    documentElement: { dataset: {} },
    addEventListener() {},
    querySelector(selector) {
      if (selector === 'meta[name="csrf-token"]') return { content: "csrf_contract" };
      const name = selector.match(/^meta\[name="client-i18n-([^"]+)"\]$/)?.[1];
      return name && templates.has(name) ? { content: templates.get(name) } : null;
    },
  };
  return {
    document,
    FormData: class {},
    window: { confirm() {}, location: { assign() {}, reload() {} }, setInterval() {}, setTimeout() {} },
  };
}
