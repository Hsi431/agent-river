// Round-3 blocker tests (post Opus + Codex re-review of §15):
//   B1 §15.B/C — process-group termination confirms the WHOLE group is gone
//                (incl. grandchildren), not just SIGTERM-and-hope.
//   B2 §15.H   — the real bridge acquires the poller lock; a 2nd poller refuses.
//   B3 §15.A/5 — one active turn per session key; a 2nd same-key message is busy.

import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  terminateGroup,
  makeTurnController,
  registerActiveTurn,
  stopAllTurns,
  listActiveTurns,
} from "../src/agent/v2/kill.js";
import { handleV2Message } from "../src/agent/v2/poller.js";
import { makeClaudeAdapter } from "../src/agent/v2/agent-adapter.js";
import { acquirePollerLock, releasePollerLock } from "../src/agent/telegram.js";
import { agentPaths } from "../src/agent/paths.js";
import { setTelegramCodexPolicy } from "../src/agent/safety.js";
import { readJsonl } from "../src/lib/jsonl.js";

function makeAgentHome(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function makeGitRepo(parentDir, name) {
  const dir = path.join(parentDir, name);
  fs.mkdirSync(dir, { recursive: true });
  await new Promise((resolve, reject) => {
    execFile("git", ["init", dir], { timeout: 5000 }, (e) => (e ? reject(e) : resolve()));
  });
  return dir;
}

// ESRCH for the whole group → no member (or zombie) left.
function groupGone(pid) {
  try {
    process.kill(-pid, 0);
    return false;
  } catch (err) {
    return err.code === "ESRCH";
  }
}

// ─── B1 §15.B/C: confirm-gone process-group termination ───────────────────────

test("§15.B/C: terminateGroup kills the whole detached group incl. grandchild", async () => {
  // Group leader (detached → own session) that ALSO spawns a grandchild in the
  // same group. The bug was: SIGTERM the direct child and settle, leaving the
  // grandchild alive. terminateGroup must confirm the whole group is gone.
  const code =
    "const cp=require('node:child_process');" +
    "cp.spawn(process.execPath,['-e','setInterval(()=>{},1e9)'],{stdio:'ignore'});" +
    "setInterval(()=>{},1e9);";
  const child = spawn(process.execPath, ["-e", code], { detached: true, stdio: "ignore" });
  child.unref();

  assert.equal(groupGone(child.pid), false, "group should be alive before terminate");

  const res = await terminateGroup(child.pid, { graceMs: 300 });
  assert.equal(res.confirmed, true, "terminateGroup must confirm the group is gone");
  assert.equal(groupGone(child.pid), true, "no group member should remain");
});

test("§15.B/C: abort does not resolve until the group is confirmed gone, even if the exec callback fires mid-termination", async () => {
  // round-4 (Codex finding #1): the exec callback fires the moment the DIRECT
  // child dies from SIGTERM; it must NOT win the settle while a grandchild is
  // still alive. Assert the run resolves only after the whole group is ESRCH.
  const tree = spawn(
    process.execPath,
    [
      "-e",
      "const cp=require('node:child_process');cp.spawn(process.execPath,['-e','setInterval(()=>{},1e9)'],{stdio:'ignore'});setInterval(()=>{},1e9);",
    ],
    { detached: true, stdio: "ignore" },
  );
  tree.unref();
  const realPid = tree.pid;

  let execCb = null;
  const execImpl = (_file, _args, _opts, cb) => {
    execCb = cb;
    return { pid: realPid, stdin: { on() {}, write() {}, end() {} } };
  };

  const { signal, controller } = makeTurnController();
  const adapter = makeClaudeAdapter({ agentHome: makeAgentHome("v2-race-") });
  const runP = adapter.run({
    repoToplevel: "/tmp/x",
    mode: "read",
    prompt: "hi",
    execFileImpl: execImpl,
    signal,
  });

  // Let the adapter register its abort listener, then abort.
  await new Promise((r) => setImmediate(r));
  controller.abort();
  // Simulate the direct child dying from SIGTERM mid-termination.
  setTimeout(
    () => execCb && execCb(Object.assign(new Error("killed"), { killed: true, signal: "SIGTERM" }), "", ""),
    20,
  );

  const res = await runP;
  assert.equal(groupGone(realPid), true, "group must be confirmed gone before run resolves");
  assert.equal(res.ok, false);
  assert.notEqual(res.outcome, "ok");
});

test("§15.B/C: stopAllTurns terminates a registered real child and clears the registry", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1e9)"], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  const { controller } = makeTurnController();
  registerActiveTurn("turn_real_pid", {
    controller,
    pid: child.pid,
    chatId: "c1",
    repoToplevel: "/ws/p",
    keyDims: null,
  });

  const stopped = await stopAllTurns();
  assert.ok(stopped.includes("turn_real_pid"));
  assert.equal(groupGone(child.pid), true, "the child's group should be gone after /stop");
  assert.equal(listActiveTurns().find((t) => t.id === "turn_real_pid"), undefined);
});

// ─── B2 §15.H: bridge wires the cross-process poller lock ──────────────────────

test("§15.H: poller lock refuses to start when a live poller lock exists", () => {
  const agentHome = makeAgentHome("v2-bridge-lock-");

  // Pre-write a live lock (our own pid → the holder is alive).
  const lockPath = agentPaths(agentHome).v2PollerLock;
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(
    lockPath,
    JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }),
  );

  assert.throws(
    () => acquirePollerLock(agentHome),
    /poller already running/i,
  );
  fs.unlinkSync(lockPath);
});

test("§15.H: poller lock can be held and released", () => {
  const agentHome = makeAgentHome("v2-bridge-lock2-");
  const lockPath = agentPaths(agentHome).v2PollerLock;

  acquirePollerLock(agentHome);
  assert.equal(fs.existsSync(lockPath), true, "lock must be held");
  releasePollerLock(agentHome);

  assert.equal(fs.existsSync(lockPath), false, "lock must be released on clean exit");
});

// ─── B3 §15.A/§5: one active turn per session key ─────────────────────────────

test("§15.A/§5: a second same-session-key message is refused as busy", async () => {
  const ws = makeAgentHome("v2-busy-ws-");
  const repo = await makeGitRepo(ws, "proj");
  const agentHome = makeAgentHome("v2-busy-agent-");
  setTelegramCodexPolicy(agentHome, { default_repo: repo });

  // backgroundImpl that never runs fn → the first turn stays registered/active.
  const bg = () => {};
  const adapters = {
    claude: {
      async run() {
        return { ok: true, text: "ok", sessionId: "s1", tokens: 1, outcome: "ok" };
      },
    },
  };
  const args = {
    agentHome,
    ownerUserId: "u1",
    chatId: "c1",
    text: "@claude review this",
    execFileImpl: execFile,
    adapters,
    backgroundImpl: bg,
  };

  const first = await handleV2Message({ ...args });
  assert.equal(first.outcome, "started");

  const second = await handleV2Message({ ...args });
  assert.equal(second.outcome, "busy", "same session key must be rejected, not raced");
  assert.match(second.reply, /already running/i);

  // Exactly one active turn for this key.
  const mine = listActiveTurns().filter((t) => t.keyDims && String(t.keyDims.ownerUserId) === "u1");
  assert.equal(mine.length, 1);
});

// ─── U13: v2 result text is redacted before it reaches the outbox ─────────────

test("U13: v2 outbox redacts secrets in the model result before persisting", async () => {
  const ws = makeAgentHome("v2-redact-ws-");
  const repo = await makeGitRepo(ws, "proj");
  const agentHome = makeAgentHome("v2-redact-agent-");
  setTelegramCodexPolicy(agentHome, { default_repo: repo });

  const secret = "sk-U13SECRETABCDEFGHIJKLMNOP";
  const adapters = {
    claude: {
      async run() {
        return { ok: true, text: `here is the key ${secret} done`, sessionId: "s1", tokens: 1, outcome: "ok" };
      },
    },
  };
  // Capture the turn body's promise so we can await the outbox write.
  let turnDone;
  const bg = (fn) => { turnDone = fn(); };
  await handleV2Message({
    agentHome,
    ownerUserId: "u1",
    chatId: "c1",
    text: "@claude review this",
    execFileImpl: execFile,
    adapters,
    backgroundImpl: bg,
  });
  await turnDone;

  const outbox = readJsonl(agentPaths(agentHome).v2Outbox);
  const entry = outbox.find((row) => String(row.id).startsWith("v2turn_result_"));
  assert.ok(entry, "a v2 result outbox entry must exist");
  assert.doesNotMatch(entry.text, /sk-U13SECRET/);
  assert.match(entry.text, /\[redacted:openai_like_key\]/);
});
