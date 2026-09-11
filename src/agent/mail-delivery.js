import fs from "node:fs";
import path from "node:path";
import { reconcileMail } from "./mail.js";
import { pickEligibleCodexMessage, runCodexExchangeRunnerOnce } from "./codex-exchange-runner.js";
import { pickEligibleMessage, runExchangeRunnerOnce } from "./exchange-runner.js";
import { runExecRunnerOnce, pickEligibleExecMessage } from "./exec-runner.js";
import { mailAgents } from "./mail.js";
import { checkSafety, getTelegramCodexPolicy } from "./safety.js";
import { redactSecrets } from "../lib/secret-scan.js";

export function startMailDelivery({ agentHome, repoDir, intervalMs = 2000 }) {
  const lanes = {};
  const active = new Set();
  let stopped = false;
  const file = path.join(agentHome, "mail-delivery.json");
  function save() {
    fs.mkdirSync(agentHome, { recursive: true });
    fs.writeFileSync(`${file}.${process.pid}.tmp`, JSON.stringify({ pid: process.pid,
      updated_at: new Date().toISOString(), stopped, lanes }));
    fs.renameSync(`${file}.${process.pid}.tmp`, file);
  }
  function tick() {
    try {
      reconcileMail(agentHome);
      const gate = checkSafety(agentHome);
      const enabled = getTelegramCodexPolicy(agentHome).exchange_runner_enabled;
      const candidates = [
        ["codex", () => pickEligibleCodexMessage(agentHome, { mailOnly: true }), runCodexExchangeRunnerOnce],
        ["opus", () => pickEligibleMessage(agentHome, { mailOnly: true }), runExchangeRunnerOnce],
        ["exec", () => mailAgents(agentHome).filter((a) => a.style === "exec")
          .map((a) => pickEligibleExecMessage(agentHome, a.name, { mailOnly: true })).find(Boolean), runExecRunnerOnce],
      ];
      for (const [name, pick, run] of candidates) {
        if (active.has(name)) continue;
        if (!gate.ok || !enabled) {
          lanes[name] = { status: "paused", reason: gate.reason || "runner_disabled" };
          continue;
        }
        const message = pick();
        if (!message?.mail) {
          lanes[name] = { status: "idle" };
          continue;
        }
        active.add(name);
        lanes[name] = { status: "working", message_id: message.id };
        void run({ agentHome, repoDir, mailOnly: true }).then((result) => {
          const blocked = !result.ran && !["no_eligible_message", "locked"].includes(result.reason);
          lanes[name] = { status: blocked ? "paused" : "idle", reason: blocked ? result.reason : null,
            last_result: result.reason, completed_at: new Date().toISOString() };
        }, (error) => {
          lanes[name] = { status: "failed", error: redactSecrets(String(error.message)) };
        }).finally(() => { active.delete(name); save(); });
      }
    } catch (error) {
      lanes.delivery = { status: "failed", error: redactSecrets(String(error.message)) };
    }
    save();
  }
  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  return () => { stopped = true; clearInterval(timer); save(); };
}

export function readMailDelivery(agentHome) {
  try {
    const state = JSON.parse(fs.readFileSync(path.join(agentHome, "mail-delivery.json"), "utf8"));
    return { ...state, fresh: !state.stopped && Date.now() - Date.parse(state.updated_at) < 15000 };
  } catch { return { fresh: false, lanes: {} }; }
}
