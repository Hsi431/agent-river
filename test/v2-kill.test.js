// Tests for §13.9: kill switch / /stop cancels in-flight child, marks run cancelled.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  appendV2Run,
  listActiveTurns,
  makeTurnController,
  readV2Runs,
  registerActiveTurn,
  stopAllTurns,
  stopTurn,
  unregisterActiveTurn,
} from "../src/agent/v2/kill.js";
import { makeClaudeAdapter } from "../src/agent/v2/agent-adapter.js";

function makeAgentHome(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// ─── Turn registry ────────────────────────────────────────────────────────────

test("kill: registerActiveTurn / listActiveTurns / unregisterActiveTurn", () => {
  const { controller } = makeTurnController();
  registerActiveTurn("turn_x", { controller, pid: null, chatId: "c1", repoToplevel: "/ws/p" });

  const turns = listActiveTurns();
  const found = turns.find((t) => t.id === "turn_x");
  assert.ok(found, "turn should be listed");
  assert.equal(found.chatId, "c1");

  unregisterActiveTurn("turn_x");
  const after = listActiveTurns().find((t) => t.id === "turn_x");
  assert.equal(after, undefined, "turn should be removed");
});

test("kill: stopTurn aborts the controller signal", () => {
  const { signal, controller } = makeTurnController();
  registerActiveTurn("turn_ab", { controller, pid: null, chatId: "c1", repoToplevel: "/ws/p" });

  assert.equal(signal.aborted, false);
  stopTurn("turn_ab");
  assert.equal(signal.aborted, true);

  // After stop, the turn should no longer be in the registry.
  const found = listActiveTurns().find((t) => t.id === "turn_ab");
  assert.equal(found, undefined);
});

test("kill: stopTurn returns turn_not_found for unknown id", () => {
  const result = stopTurn("nonexistent_turn");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "turn_not_found");
});

test("kill: stopAllTurns cancels all active turns", () => {
  const { signal: s1, controller: c1 } = makeTurnController();
  const { signal: s2, controller: c2 } = makeTurnController();
  registerActiveTurn("turn_all_1", { controller: c1, pid: null, chatId: "c1", repoToplevel: "/ws/p1" });
  registerActiveTurn("turn_all_2", { controller: c2, pid: null, chatId: "c2", repoToplevel: "/ws/p2" });

  const stopped = stopAllTurns();
  assert.ok(stopped.includes("turn_all_1"));
  assert.ok(stopped.includes("turn_all_2"));
  assert.equal(s1.aborted, true);
  assert.equal(s2.aborted, true);
  assert.equal(listActiveTurns().filter((t) => t.id === "turn_all_1" || t.id === "turn_all_2").length, 0);
});

// ─── Run record ───────────────────────────────────────────────────────────────

test("kill: appendV2Run / readV2Runs", () => {
  const agentHome = makeAgentHome("v2-kill-runs-");

  appendV2Run(agentHome, { turn_id: "t1", agent: "claude", status: "started" });
  appendV2Run(agentHome, { turn_id: "t1", agent: "claude", status: "done" });

  const runs = readV2Runs(agentHome);
  assert.equal(runs.length, 2);
  assert.equal(runs[0].schema_version, 2);
  assert.equal(runs[0].turn_id, "t1");
  assert.equal(runs[1].status, "done");
});

// ─── §13.9: Cancel in-flight mocked long-running child ───────────────────────

test("kill: signal-based cancellation stops a mocked long-running adapter", async () => {
  const agentHome = makeAgentHome("v2-kill-cancel-");

  // Create a controller that we abort after a short delay.
  const { signal, controller } = makeTurnController();

  let calledWithSignal = null;
  let abortedDuringRun = false;

  const adapter = {
    async run({ signal: sig }) {
      calledWithSignal = sig;
      // Simulate a long-running operation that respects the abort signal.
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          resolve({ ok: true, text: "would not complete", sessionId: null, tokens: 0, outcome: "ok" });
        }, 30000);

        sig.addEventListener("abort", () => {
          clearTimeout(timer);
          abortedDuringRun = true;
          resolve({ ok: false, text: "", sessionId: null, tokens: 0, outcome: "outcome_unknown", errorDetail: "cancelled" });
        }, { once: true });
      });
    },
  };

  // Start the turn and cancel it after 50ms.
  const runPromise = adapter.run({ signal });
  setTimeout(() => controller.abort(), 50);

  const result = await runPromise;

  assert.equal(abortedDuringRun, true);
  assert.equal(result.ok, false);
  assert.equal(result.outcome, "outcome_unknown");
});

test("kill: v2 turn records cancelled status when stopped", async () => {
  const agentHome = makeAgentHome("v2-kill-record-");

  const { signal, controller } = makeTurnController();

  const adapter = {
    async run({ signal: sig }) {
      return new Promise((resolve) => {
        sig.addEventListener("abort", () => {
          resolve({ ok: false, text: "", sessionId: null, tokens: 0, outcome: "outcome_unknown", errorDetail: "cancelled" });
        }, { once: true });
        // Keep the promise pending until aborted.
      });
    },
  };

  registerActiveTurn("turn_record_1", { controller, pid: null, chatId: "c1", repoToplevel: "/ws/p" });
  appendV2Run(agentHome, { turn_id: "turn_record_1", status: "started", schema_version: 2 });

  // Run the adapter and abort it.
  const runPromise = adapter.run({ signal });
  stopTurn("turn_record_1");
  const result = await runPromise;

  // Record the cancellation.
  appendV2Run(agentHome, { turn_id: "turn_record_1", status: "cancelled", outcome: result.outcome, schema_version: 2 });

  const runs = readV2Runs(agentHome);
  const cancelledRun = runs.find((r) => r.status === "cancelled");
  assert.ok(cancelledRun, "should have a cancelled run record");
  assert.equal(cancelledRun.turn_id, "turn_record_1");
});
