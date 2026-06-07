# Agent River v2 — Phase 1 Spec (canonical)

Status: agreed after three Opus↔Codex review rounds. This file is the single
source of truth for Phase 1. If the implementation and this file disagree, this
file wins until it is explicitly amended.

## 1. Vision

Agent River v2 is a **Telegram-driven remote launcher** for the Codex and Claude
Code CLIs already installed on the owner's machine. It lets the owner run those
agents on their own machine, in their own repos, from Telegram instead of from a
keyboard — as **general agents**, not a bespoke "coding agent" / "review agent".

There is **no** separate review pipeline vs coding pipeline. It is just Claude or
Codex, given:

- a **target repo** (a working directory), and
- a **capability level**: `read` (read/analyze/answer — covers review, Q&A,
  planning, explaining) or `write` (may edit the target repo).

Agent River does **not** interpret natural-language intent, does **not** sandbox
repos at the OS level, and does **not** run a second task planner. It does:
message transport, agent + repo + capability selection, process lifecycle,
result relay, and clear notification when something needs interaction the owner
cannot give remotely.

## 2. Trust model

**Local parity.** Running an agent over Telegram is treated as equivalent to the
owner running `claude` / `codex` by hand in that repo. Any risk that also exists
when running the tool locally (project `CLAUDE.md`, project settings, hooks, MCP,
the model reading other readable files) is an **accepted residual risk**,
documented in `SECURITY.md` — **not** something Phase 1 must eliminate.

The security boundary is exactly three things:

1. **Telegram owner allowlist** (who may drive the bot).
2. **The provider's own permission system** (the same one used locally).
3. **Capability ceiling**: Telegram may select only `read` or `write`
   (`workspace-write`). `danger-full-access` / `bypassPermissions` are **never**
   selectable from Telegram; they require a local, short-lived toggle. (A stolen
   Telegram token must not equal unattended full RCE.)

### Explicitly OUT of scope for Phase 1 (do NOT build)

- Per-action approval over Telegram ("mode B"): Codex app-server, Claude Agent
  SDK `canUseTool`, persistent approval state machine.
- OS-level sandbox (bubblewrap/systemd) for repo write confinement.
- Project-settings / hooks / MCP isolation (`mode=isolated`). These are deferred
  hardening for the "review an untrusted repo" case.

Reviewers must not re-raise these as Phase 1 blockers.

## 3. Repo resolver (canonical repo identity)

`resolveRepo({ workspaceRoot, input, defaultRepo })` → `{ ok, toplevel, reason }`.

Rules:

1. `workspace_root` config: default = `realpath(dirname(default_repo))`. If there
   is no `default_repo`, repo resolution **requires** an explicit
   `workspace_root`; **never** fall back to `~` or `process.cwd()`.
2. `input` forms accepted (and only these — no NL, no recursive search):
   - `repo=<name>` → resolves to `workspace_root/<name>` (a **direct child**
     only).
   - `repo=/absolute/path`.
3. Resolution + validation, in order, each failure → a specific reason:
   - `realpath` the workspace root and the candidate target.
   - target exists and is a directory → else `repo_not_found`.
   - `git -C <target> rev-parse --show-toplevel` succeeds → else
     `repo_access_denied` (covers non-git and **bare** repos).
   - `realpath` the top-level.
   - top-level is the workspace root or a path under `workspaceRoot + sep` → else
     `repo_outside_workspace`.
4. The **git top-level** is the canonical repo identity. Use it as the run `cwd`,
   the repo identity in records, and part of the session key. This makes
   `repo=/ws/project` and `repo=/ws/project/src` resolve to the same identity,
   and supports git worktrees (where `.git` is a file).
5. Re-validate just before spawn (the repo may vanish between resolve and spawn →
   `repo_access_denied`). Node validation is best-effort and does not claim to
   prevent TOCTOU; the provider sandbox is the real write boundary.

## 4. Agent adapters (thin)

Do **not** merge the two providers into one process runner. Define a thin shared
interface and one adapter each.

```
AgentAdapter.run({ repoToplevel, mode, prompt, sessionId, model, signal })
  → { ok, text, sessionId, tokens, outcome }
```

`outcome` ∈ `ok | capability_blocked | provider_permission_denied |
repo_access_denied | timed_out | outcome_unknown | spawn_error`.

All spawns use `execFile` (no shell). Prompt is delivered the same safe way the
current runners use (Codex via stdin; Claude via argv positional with no secret).

### Codex adapter

- `codex exec --sandbox read-only` for `read`; `--sandbox workspace-write` for
  `write`.
- `--cd <repoToplevel>` (canonical). Do not also pass `--add-dir` for the cwd repo.
- Capture a real session/thread id from `codex exec --json` events and resume with
  `codex exec resume <session-id>`. Do **not** invent ids or rely on the `-o`
  output file as identity.
- Consider `--ignore-user-config` only as part of a future `isolated` mode; Phase 1
  default is local parity (inherit user config). Record the effective sandbox mode
  in the run record.

### Claude adapter

- `claude -p --output-format json --add-dir <repoToplevel>` with cwd = repo
  top-level.
- `read` uses the read-only settings profile; `write` uses the edit settings
  profile (reuse the existing generators). Phase 1 deliberately loads project
  settings (local parity).
- Resume via the `session_id` from the JSON result (extend the existing store).
- **Honesty note for docs**: `cwd` + `--add-dir` is *not* an OS write sandbox;
  Claude write confinement is the provider permission profile, same as local. Do
  not describe it as "repo-scoped sandbox" anywhere.

## 5. Session model

Session key = `(owner_user_id, chat_id, agent, repo_toplevel, mode)`.

- Stored as a structured record (or stable hash of the tuple) that also keeps the
  raw fields for audit — **not** a path concatenated into a filename.
- `mode` is part of the key so edit context does not bleed into later `read`
  conversations.
- **One active turn per key** at a time.
- Update the stored session id **only after** a successful provider result.
- On resume failure (stale/expired id): clear that key and retry **once** with a
  fresh session — **but** for a `write` turn this retry is allowed **only** when
  it is certain the tool had not started working (see §6). Group chats do not
  share sessions (the key includes `chat_id`, and `owner_user_id`).

## 6. Turn execution & failure semantics

- A turn's outcome must be one of the §4 `outcome` values. **Never** collapse a
  capability/permission/repo failure into a generic "failed" or "no output".
- `read` turns may retry on transient transport errors.
- `write` turns: once spawned, if the result is uncertain (Telegram/network
  timeout, bridge crash, unparseable stdout), mark `outcome_unknown` and **do not
  auto-rerun**. The owner inspects `git diff` and re-sends explicitly. Do not port
  the v1 exchange-runner retry/release behavior onto write turns.
- Every outcome is surfaced to Telegram with the reason and the next step (e.g.
  `capability_blocked` on a read turn that tried to write → "re-send with
  mode=write").

## 7. Kill switch / stop (must actually stop running agents)

The current kill switch only gates *before* spawn. Phase 1 must also stop
*running* agents.

- Track active turns with their child process handle / PID and process group.
- Provide `/stop` (and honor the kill switch): terminate the active child's whole
  **process group**, not just the parent.
- On kill-switch-on, terminate all active children.
- On timeout, confirm the process group is gone.
- Mark the run record `cancelled` / `timed_out` accordingly.

## 8. Router grammar

Fixed grammar, parsed deterministically:

```
@<agent> [repo=<name|/abs>] [mode=read|write] [--] <free text>
```

- Only **leading** control tokens (immediately after `@agent`) are parsed. The
  first non-control token ends control parsing; any later `repo=`/`mode=` is part
  of the prompt. `--` explicitly ends control parsing.
- Unknown or duplicated control token → **error** back to the owner; never pass the
  raw control token into the model prompt.
- Passthrough prompt = the text after stripping the leading control tokens (and an
  optional `--`).
- Defaults: no `repo=` → the (owner, chat, agent) **active repo**, else
  `default_repo`. No `mode=` → `read`.
- **`mode=write` requires an explicit `repo=`** and an owner. (Telegram does not
  show the current cwd; an implicit active repo for writes risks editing the wrong
  project.)
- `@claude` is an alias for the Claude agent; `@codex` for Codex. (Keep existing
  `@opus`→claude back-compat.)

## 9. Ack / status UX

- **Every** start ack must show: `agent · repo (git top-level real path) · mode ·
  session`. Show the canonical top-level path, not the input alias.
- Provide `/status` (and `/context`) that, **without calling a model**, reports the
  current agent, active repo, mode, session, and any active turn.
- Active repo state is stored by canonical identity; if it has moved/been deleted,
  return `repo_unavailable: previous active repository no longer exists` — do not
  silently fall back to `default_repo`.
- (Nice-to-have, not a blocker) emit a "started / still working" heartbeat for
  long turns so Telegram does not sit silent.

## 10. v1 / v2 coexistence

- **Single Telegram poller.** Exactly one process reads `getUpdates`. The router,
  in that one process, decides v1 vs v2. Do not run a v1 bridge service and a v2
  bridge service that both poll. Stop the old service before starting the new one
  during deployment; confirm child processes have exited before schema migration.
- New `@agent ...` messages → v2 path. Existing v1 pending callbacks → old handler.
- **Versioned callbacks.** v2 uses a `v2:` namespace (e.g. `v2:turn:...`). Keep the
  v1 callback parser for at least one release window. Expired/removed v1 actions
  reply "legacy action expired". 
- Callback records bind and verify `owner_user_id`, `chat_id`, `turn_id`,
  `schema_version`, current state. Even single-owner MVP stores these fields now.
- Add a `schema_version` to task / exchange / run records; readers treat missing
  version as v1. Do **not** rewrite pending v1 tasks' repo or approval semantics.

## 11. Agent ↔ agent collaboration

Keep dispatch/exchange but carry: repo identity, parent turn id, a **concise**
task, and only necessary quotes — **not** the full thread (limits secret exposure
and token cost). Keep the existing hop limit.

## 12. Phase 1 acceptance criteria (hard)

1. `mode=write` requires an explicit `repo=`; the wrong-repo footgun is impossible.
2. Kill switch **and** `/stop` terminate the active child / process group of a
   running agent (not just pre-spawn gating).
3. A `write` turn with an uncertain outcome is **never** auto-rerun.
4. v1 and v2 share a **single** Telegram poller; no two services compete for
   `getUpdates`.

## 13. Required end-to-end tests

1. First turn creates a session; a second same-key turn remembers prior context.
2. Different repo or different mode does **not** resume the other session.
3. Stale session resumes once with a fresh session (read turn).
4. A `write` turn with an uncertain result is not re-executed.
5. Cross-repo `read` review works: `@claude repo=<other> -- review ...` runs in the
   other repo's top-level and returns findings, with no Codex task created.
6. Repo resolver returns the correct specific reason for: not found, not a dir,
   non-git, bare repo, outside workspace, vanished-before-spawn.
7. Router: leading control tokens parsed; later `mode=write` in prose ignored; `--`
   honored; unknown/duplicate token errors; `mode=write` without `repo=` errors.
8. `/status` reports agent/repo/mode/session without invoking a model.
9. Kill switch / `/stop` cancels an in-flight (mocked long-running) child and marks
   the run `cancelled`.

All tests must pass under a clean `HOME` (CI parity): run with
`env HOME=$(mktemp -d) CODEX_AGENT_HOME= npm test`.

## 14. Suggested implementation order

1. Repo resolver + canonical identity + error taxonomy (+ tests §13.6).
2. Router grammar (+ tests §13.7).
3. Thin AgentAdapter interface; Claude adapter (read first), Codex adapter; run
   in resolved repo (+ test §13.5 read path).
4. Session model: 5-dim key, storage, resume contracts, update-on-success, stale
   retry once, write no-rerun (+ tests §13.1–4).
5. Kill switch / `/stop` / process group (+ test §13.9).
6. Ack/status UX + failure-reason surfacing (+ test §13.8).
7. Single-poller v1/v2 routing + versioned callbacks + schema_version on records.
8. Update `SECURITY.md` (local-parity trust model, residual risks, capability
   ceiling) and `CHANGELOG.md`.

Do not delete v1 classifier / task planner / repo allowlist in Phase 1 beyond what
is needed to route v2; full removal is Phase 2 once v1 actions have a retirement
window.
