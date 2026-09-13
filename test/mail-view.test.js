import assert from "node:assert/strict";
import test from "node:test";
import { renderMail, conversationEvents } from "../src/web/mail-view.js";

function render(text, locale = "zh-Hant") {
  const thread = { id: "test", from: "owner", subject: "自我介紹", status: "completed",
    participants: ["owner", "otter"], updatedAt: "2026-09-11T16:34:37Z", summary: text,
    letters: [], stopped: true, timeline: [{ type: "reply", from: "otter", text, created_at: "2026-09-11T16:34:37Z" }] };
  return renderMail({ threads: [thread], current: thread, agents: [], delivery: { fresh: false } }, locale);
}

test("mail blocks render readable text and escaped metadata pills in both locales", () => {
  for (const locale of ["zh-Hant", "en"]) {
    for (const ending of ["", "\n", "\r\n \t\r\n"]) {
      const text = '先請 Codex 介紹。\n```agent-mail\n' + JSON.stringify({ to: "codex", text: "介紹 <script>alert(1)</script>", capability: "general", model: 'gpt-5<img src=x>', effort: "low" }) + '\n```' + ending;
      const html = render(text, locale);
      assert.doesNotMatch(html, /```|agent-mail|<script>|<img/);
      assert.match(html, /先請 Codex 介紹。/);
      assert.match(html, /postal-compact[^]*→ codex/);
      assert.match(html, /介紹 &lt;script&gt;/);
      assert.match(html, /postal-tag[^]*gpt-5&lt;img src=x&gt;/);
      assert.match(html, /<b>low<\/b>/);
      assert.match(html, locale === "zh-Hant" ? /一般協助/ : /General/);
    }
  }
});

test("plain replies and malformed mail remain readable", () => {
  assert.match(render("一般回覆"), /<pre class="postal-body">一般回覆<\/pre>/);
  for (const json of ["{bad}", "null", '{"text":{}}']) {
    assert.match(render('```agent-mail\n' + json + '\n```\n'), /```agent-mail/);
  }
});

test("conversation shows delegation once, real replies, and hides result retries", () => {
  const letters = [
    { id: 'owner', from: 'owner', status: 'completed', mail: {} },
    { id: 'request', status: 'completed', mail: { delivery_key: 'request:delegate' } },
    { id: 'result1', status: 'reassigned', mail: {} },
    { id: 'result2', status: 'completed', mail: { replaces: 'result1' } },
  ];
  const timeline = [
    { id: 'owner', type: 'request', from: 'owner', text: '介紹' },
    { id: 'delegate', message_id: 'owner', type: 'reply', text: '請求' },
    { id: 'request', type: 'request', from: 'otter', text: '請求' },
    { id: 'opus', message_id: 'request', type: 'reply', text: '我是 Opus' },
    { id: 'result1', type: 'result', status: 'reassigned', text: '重複轉送' },
    { id: 'blocked', message_id: 'result1', type: 'reply', text: 'Blocked: usage' },
    { id: 'result2', type: 'result', status: 'completed', text: '重複轉送' },
    { id: 'otter', message_id: 'result2', type: 'reply', text: '我是 Otter' },
  ];
  assert.deepEqual(conversationEvents({ letters, timeline }).map(e => e.id), ['owner', 'delegate', 'opus', 'otter']);
  assert.equal(timeline.length, 8);
});

test("pending transfers and unresolved failures remain visible without repeated bodies", () => {
  for (const status of ['queued', 'working', 'failed']) {
    const events = conversationEvents({ letters: [{id: 'result', status}], timeline: [
      { id: 'result', type: 'result', status, text: 'Original request: duplicate', error: 'limit' },
      { id: 'blocked', message_id: 'result', type: 'reply', text: 'Blocked: limit' },
    ] });
    assert.equal(events[0].text, '');
    assert.equal(events[0].status, status);
    assert.equal(events[0].error, 'limit');
    if (status === 'failed') assert.equal(events.length, 1);
  }
});

test("equal text in unrelated letters is not deduplicated", () => {
  assert.equal(conversationEvents({ letters: [], timeline: [
    { id: 'one', type: 'reply', text: '你好' }, { id: 'two', type: 'reply', text: '你好' },
  ] }).length, 2);
});

test("group fan-out is one owner message with all recipients and outstanding status", () => {
  const group = { id: 'batch', recipients: ['codex', 'opus', 'otter'] };
  const letters = group.recipients.map((to, i) => ({id: `m${i}`, to, status: i === 1 ? 'failed' : 'completed', error: i === 1 ? 'provider error' : null, mail: {group}}));
  const timeline = letters.map(m => ({id: m.id, type: 'request', from: 'owner', to: m.to, text: '討論', group}));
  const visible = conversationEvents({letters, timeline});
  assert.equal(visible.length, 1);
  assert.equal(visible[0].to, 'codex · opus · otter');
  assert.equal(visible[0].status, 'failed');
  assert.equal(visible[0].error, 'opus: provider error');
});
