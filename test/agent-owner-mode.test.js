import test from "node:test";
import assert from "node:assert/strict";
import { isDangerousActionRequest, hasEnglishActionWord, escapeRegex } from "../src/agent/hard-gate.js";

test("hard gate identifies dangerous action requests", () => {
  assert.equal(isDangerousActionRequest("commit this"), true);
  assert.equal(isDangerousActionRequest("push to main"), true);
  assert.equal(isDangerousActionRequest("deploy to prod"), true);
  assert.equal(isDangerousActionRequest("install packages"), true);
  assert.equal(isDangerousActionRequest("delete the branch"), true);
  assert.equal(isDangerousActionRequest("rm -rf tmp"), true);
  assert.equal(isDangerousActionRequest("幫我提交"), true);
  assert.equal(isDangerousActionRequest("請部署到 production"), true);
  assert.equal(isDangerousActionRequest("review the latest commit"), true);
  assert.equal(isDangerousActionRequest("summarize the status"), false);
});

test("hard gate matches English action words on token boundaries", () => {
  assert.equal(hasEnglishActionWord("please push this", ["push"]), true);
  assert.equal(hasEnglishActionWord("pre commit smoke", ["commit"]), true);
  assert.equal(hasEnglishActionWord("pushdown automata notes", ["push"]), false);
  assert.equal(hasEnglishActionWord("reinstall docs", ["install"]), false);
});

test("hard gate regex escaping handles literal action words", () => {
  assert.equal(escapeRegex("rm -rf ./*"), "rm -rf \\./\\*");
  assert.equal(hasEnglishActionWord("run c++", ["c++"]), true);
});
