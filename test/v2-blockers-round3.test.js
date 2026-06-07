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
import { telegramCodexBridge } from "../src/agent/telegram-codex-bridge.js";
import { agentPaths } from "../src/agent/paths.js";
import { setTelegramCodexPolicy } from "../src/agent/safety.js";

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

test("§15.H: telegramCodexBridge refuses to start when a live poller lock exists", async () => {
  const agentHome = makeAgentHome("v2-bridge-lock-");
  setTelegramCodexPolicy(agentHome, { enabled: true, require_approval: true });

  // Pre-write a live lock (our own pid → the holder is alive).
  const lockPath = agentPaths(agentHome).v2PollerLock;
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(
    lockPath,
    JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }),
  );

  let onceCalled = false;
  await assert.rejects(
    () =>
      telegramCodexBridge({
        agentHome,
        allowRealCodex: true,
        maxCycles: 1,
        token: "x",
        onceImpl: async () => {
          onceCalled = true;
          return {};
        },
        sleepImpl: async () => {},
      }),
    /poller already running/i,
  );
  assert.equal(onceCalled, false, "must refuse before running any poll cycle");
  fs.unlinkSync(lockPath);
});

test("§15.H: telegramCodexBridge holds the lock while running and releases on exit", async () => {
  const agentHome = makeAgentHome("v2-bridge-lock2-");
  setTelegramCodexPolicy(agentHome, { enabled: true, require_approval: true });
  const lockPath = agentPaths(agentHome).v2PollerLock;

  await telegramCodexBridge({
    agentHome,
    allowRealCodex: true,
    maxCycles: 1,
    token: "x",
    onceImpl: async () => {
      assert.equal(fs.existsSync(lockPath), true, "lock must be held during the poll loop");
      return {};
    },
    sleepImpl: async () => {},
  });

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
