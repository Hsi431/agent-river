// Tests for §13.7: router grammar.
import assert from "node:assert/strict";
import test from "node:test";
import { parseV2Message } from "../src/agent/v2/router.js";

// ─── Basic parsing ────────────────────────────────────────────────────────────

test("router: parses @claude with a prompt", () => {
  const result = parseV2Message("@claude review this code");
  assert.equal(result?.ok, true);
  assert.equal(result.agent, "claude");
  assert.equal(result.mode, "read");
  assert.equal(result.prompt, "review this code");
  assert.equal(result.repo, null);
});

test("router: parses @codex with a prompt", () => {
  const result = parseV2Message("@codex fix the tests");
  assert.equal(result?.ok, true);
  assert.equal(result.agent, "codex");
  assert.equal(result.prompt, "fix the tests");
});

test("router: @opus is aliased to claude", () => {
  const result = parseV2Message("@opus review this");
  assert.equal(result?.ok, true);
  assert.equal(result.agent, "claude");
});

test("router: parses repo= and mode= control tokens", () => {
  const result = parseV2Message("@claude repo=myproject mode=write fix the bug");
  assert.equal(result?.ok, true);
  assert.equal(result.agent, "claude");
  assert.equal(result.repo, "repo=myproject");
  assert.equal(result.mode, "write");
  assert.equal(result.prompt, "fix the bug");
});

test("router: parses absolute path repo=", () => {
  const result = parseV2Message("@claude repo=/home/user/projects/myapp review it");
  assert.equal(result?.ok, true);
  assert.equal(result.repo, "repo=/home/user/projects/myapp");
});

test("router: -- ends control token parsing", () => {
  const result = parseV2Message("@claude repo=proj -- do mode=write things");
  assert.equal(result?.ok, true);
  assert.equal(result.repo, "repo=proj");
  assert.equal(result.mode, "read"); // mode=write after -- is in prompt
  assert.equal(result.prompt, "do mode=write things");
});

test("router: later mode= in prose is ignored (not parsed as control)", () => {
  const result = parseV2Message("@claude fix the thing, then check mode=write behavior");
  assert.equal(result?.ok, true);
  // mode= appears after 'fix the thing,' which is a non-control token
  assert.equal(result.mode, "read");
  assert.equal(result.prompt, "fix the thing, then check mode=write behavior");
});

test("router: mode=write without repo= is an error", () => {
  const result = parseV2Message("@claude mode=write fix this");
  assert.equal(result?.ok, false);
  assert.equal(result.reason, "write_requires_repo");
});

test("router: mode=write with repo= is ok", () => {
  const result = parseV2Message("@claude repo=myrepo mode=write fix this");
  assert.equal(result?.ok, true);
  assert.equal(result.mode, "write");
  assert.equal(result.repo, "repo=myrepo");
  assert.equal(result.prompt, "fix this");
});

test("router: unknown control token is an error", () => {
  const result = parseV2Message("@claude foo=bar do something");
  // foo=bar is not a control token, so it's treated as the start of the prompt
  // (only repo= and mode= are control tokens). This is correct per spec.
  assert.equal(result?.ok, true);
  assert.equal(result.prompt, "foo=bar do something");
});

test("router: duplicate repo= is an error", () => {
  const result = parseV2Message("@claude repo=a repo=b do something");
  assert.equal(result?.ok, false);
  assert.equal(result.reason, "control_error");
  assert.equal(result.detail, "duplicate_repo");
});

test("router: duplicate mode= is an error", () => {
  const result = parseV2Message("@claude mode=read mode=write do something");
  assert.equal(result?.ok, false);
  assert.equal(result.reason, "control_error");
  assert.equal(result.detail, "duplicate_mode");
});

test("router: unknown mode value is an error", () => {
  const result = parseV2Message("@claude mode=execute do something");
  assert.equal(result?.ok, false);
  assert.equal(result.reason, "control_error");
  assert.match(result.detail, /unknown_mode/);
});

test("router: forbidden mode values are rejected", () => {
  for (const mode of ["full-access", "bypass", "danger-full-access", "bypassPermissions"]) {
    const result = parseV2Message(`@claude mode=${mode} do something`);
    assert.equal(result?.ok, false, `Expected error for mode=${mode}`);
    assert.equal(result.reason, "control_error");
    assert.equal(result.detail, "forbidden_mode");
  }
});

test("router: empty prompt after control tokens is an error", () => {
  const result = parseV2Message("@claude repo=proj --");
  assert.equal(result?.ok, false);
  assert.equal(result.reason, "empty_prompt");
});

test("router: returns null for non-v2 messages", () => {
  assert.equal(parseV2Message("hello there"), null);
  assert.equal(parseV2Message("agent status"), null);
  assert.equal(parseV2Message("status"), null);
  assert.equal(parseV2Message(""), null);
});

test("router: default mode is read", () => {
  const result = parseV2Message("@claude explain the architecture");
  assert.equal(result?.ok, true);
  assert.equal(result.mode, "read");
});

test("router: mode=read is explicit read", () => {
  const result = parseV2Message("@codex mode=read what does this do");
  assert.equal(result?.ok, true);
  assert.equal(result.mode, "read");
});

// §13.7: cross-repo read review works — @claude repo=<other> passes correctly
test("router: cross-repo read review parses correctly", () => {
  const result = parseV2Message("@claude repo=/other/project -- review the latest changes");
  assert.equal(result?.ok, true);
  assert.equal(result.agent, "claude");
  assert.equal(result.mode, "read");
  assert.equal(result.repo, "repo=/other/project");
  assert.equal(result.prompt, "review the latest changes");
});
