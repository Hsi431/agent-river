// Tests for §13.6: repo resolver error taxonomy.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveRepo, revalidateRepo } from "../src/agent/v2/repo-resolver.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// Make a real git repo in dir (or a subdirectory of dir named name).
async function makeGitRepo(parentDir, name = "myrepo") {
  const dir = path.join(parentDir, name);
  fs.mkdirSync(dir, { recursive: true });
  await execP("git", ["init", dir]);
  // git requires at least one commit for rev-parse to return the toplevel reliably
  // in some cases, but rev-parse --show-toplevel works with just init.
  return dir;
}

// Make a bare git repo.
async function makeBareGitRepo(parentDir, name) {
  const dir = path.join(parentDir, name);
  fs.mkdirSync(dir, { recursive: true });
  await execP("git", ["init", "--bare", dir]);
  return dir;
}

function execP(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 5000 }, (error) => {
      if (error) reject(error); else resolve();
    });
  });
}

// Real execFile (not injectable mock) for tests that need actual git.
const realExecFile = execFile;

// ─── Tests: §13.6 ────────────────────────────────────────────────────────────

test("repo resolver: resolves a valid git repo by name", async () => {
  const ws = makeTmpDir("v2-resolver-name-");
  await makeGitRepo(ws, "proj");

  const result = await resolveRepo({
    workspaceRoot: ws,
    input: "repo=proj",
    execFileImpl: realExecFile,
  });

  assert.equal(result.ok, true);
  assert.ok(result.toplevel.startsWith("/"), "toplevel is absolute");
  assert.ok(result.toplevel.endsWith("proj") || result.toplevel.includes("proj"), "toplevel contains proj");
});

test("repo resolver: resolves a valid git repo by absolute path", async () => {
  const ws = makeTmpDir("v2-resolver-abs-");
  const dir = await makeGitRepo(ws, "absrepo");

  const result = await resolveRepo({
    workspaceRoot: ws,
    input: `repo=${dir}`,
    execFileImpl: realExecFile,
  });

  assert.equal(result.ok, true);
  assert.equal(result.toplevel, dir);
});

test("repo resolver: returns repo_not_found for non-existent path", async () => {
  const ws = makeTmpDir("v2-resolver-notfound-");

  const result = await resolveRepo({
    workspaceRoot: ws,
    input: "repo=doesnotexist",
    execFileImpl: realExecFile,
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "repo_not_found");
});

test("repo resolver: returns repo_not_found for a file (not a dir)", async () => {
  const ws = makeTmpDir("v2-resolver-notdir-");
  const file = path.join(ws, "afile.txt");
  fs.writeFileSync(file, "hello");

  const result = await resolveRepo({
    workspaceRoot: ws,
    input: "repo=afile.txt",
    execFileImpl: realExecFile,
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "repo_not_found");
});

test("repo resolver: returns repo_access_denied for a non-git directory", async () => {
  const ws = makeTmpDir("v2-resolver-nongit-");
  const dir = path.join(ws, "plain");
  fs.mkdirSync(dir);

  const result = await resolveRepo({
    workspaceRoot: ws,
    input: "repo=plain",
    execFileImpl: realExecFile,
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "repo_access_denied");
});

test("repo resolver: returns repo_access_denied for a bare git repo", async () => {
  const ws = makeTmpDir("v2-resolver-bare-");
  await makeBareGitRepo(ws, "barerepo");

  const result = await resolveRepo({
    workspaceRoot: ws,
    input: "repo=barerepo",
    execFileImpl: realExecFile,
  });

  // Bare repos: git rev-parse --show-toplevel fails for bare repos (returns non-zero).
  assert.equal(result.ok, false);
  assert.equal(result.reason, "repo_access_denied");
});

test("repo resolver: returns repo_outside_workspace for a repo outside ws root", async () => {
  const ws = makeTmpDir("v2-resolver-outside-ws-");
  const outside = makeTmpDir("v2-resolver-outside-repo-");
  await execP("git", ["init", outside]);

  const result = await resolveRepo({
    workspaceRoot: ws,
    input: `repo=${outside}`,
    execFileImpl: realExecFile,
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "repo_outside_workspace");
});

test("repo resolver: returns missing_workspace_root when no ws and no default_repo", async () => {
  const result = await resolveRepo({
    workspaceRoot: null,
    input: "repo=proj",
    execFileImpl: realExecFile,
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "missing_workspace_root");
});

test("repo resolver: derives workspace_root from defaultRepo", async () => {
  const parent = makeTmpDir("v2-resolver-derived-ws-");
  const dir = await makeGitRepo(parent, "myproject");

  const result = await resolveRepo({
    defaultRepo: dir,
    execFileImpl: realExecFile,
  });

  assert.equal(result.ok, true);
  assert.equal(result.toplevel, dir);
});

test("repo resolver: invalid input form returns invalid_input", async () => {
  const ws = makeTmpDir("v2-resolver-invalid-input-");

  const result = await resolveRepo({
    workspaceRoot: ws,
    input: "notrepoform",
    execFileImpl: realExecFile,
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "invalid_input");
});

test("repo resolver: resolves subdirectory to git top-level", async () => {
  const ws = makeTmpDir("v2-resolver-subdir-");
  const repoDir = await makeGitRepo(ws, "myrepo");
  // Create a subdirectory inside the repo.
  const sub = path.join(repoDir, "src", "deep");
  fs.mkdirSync(sub, { recursive: true });

  // Pass the absolute path to the subdir.
  const result = await resolveRepo({
    workspaceRoot: ws,
    input: `repo=${sub}`,
    execFileImpl: realExecFile,
  });

  assert.equal(result.ok, true);
  // The toplevel should be the repo root, not the subdir.
  assert.equal(result.toplevel, repoDir);
});

test("revalidateRepo: returns ok false when repo vanishes", async () => {
  const tmpDir = makeTmpDir("v2-revalidate-");
  // Use a path that never existed.
  const gone = path.join(tmpDir, "gone");

  const result = await revalidateRepo(gone, realExecFile);

  assert.equal(result.ok, false);
  assert.equal(result.reason, "repo_access_denied");
});
