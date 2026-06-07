# Changelog

All notable changes to Agent River will be documented in this file.

## Unreleased

### v2 Phase 1 (branch: v2-phase1)

#### Added
- **Repo resolver** (`src/agent/v2/repo-resolver.js`): canonical git top-level
  identity, workspace-root containment check, and a specific error taxonomy
  (`missing_workspace_root`, `invalid_input`, `repo_not_found`,
  `repo_access_denied`, `repo_outside_workspace`). Accepts only `repo=<name>`
  and `repo=/abs/path` forms; no NL or recursive search.
- **Deterministic router** (`src/agent/v2/router.js`): parses `@<agent>
  [repo=...] [mode=...] [--] <free text>`. Only leading control tokens are
  parsed; later `mode=/repo=` in prose are part of the prompt. Unknown/duplicate
  control tokens, forbidden modes (`danger-full-access`, `bypassPermissions`,
  etc.), and `mode=write` without `repo=` are errors surfaced to the owner.
- **Thin AgentAdapter interface + Claude/Codex adapters**
  (`src/agent/v2/agent-adapter.js`): `run({ repoToplevel, mode, prompt,
  sessionId, model, signal, execFileImpl }) → { ok, text, sessionId, tokens,
  outcome }`. All spawns use `execFile` (no shell). Adapters are injectable for
  tests; no real `claude`/`codex` binary is required by tests.
- **5-dim session model** (`src/agent/v2/session.js`): key =
  `(ownerUserId, chatId, agent, repoToplevel, mode)` stored as a SHA-256 hash
  with raw fields for audit. Contracts: session_id updated only on success;
  stale-session retry once (read turns only); write + uncertain outcome = no
  auto-rerun; schema_version=2 on all records.
- **Kill switch / /stop** (`src/agent/v2/kill.js`): in-process active-turn
  registry, AbortController-based cancellation, process-group SIGTERM, v2 run
  records with `cancelled`/`timed_out` status. `stopAllTurns()` called on
  kill-switch-on.
- **Ack/status UX** (`src/agent/v2/ux.js`): every start ack shows
  `agent · repo · mode · session`; `/status` reports without calling a model;
  `repo_unavailable` if active repo has moved/been deleted; failure-reason
  messages for all outcome codes and resolver/router errors.
- **v1/v2 single-poller routing** (`src/agent/v2/poller.js`): `@agent ...`
  messages route to v2; everything else stays on v1. Versioned callbacks:
  `v2:turn:<id>:<action>` namespace; `parseV2Callback`, `isV1Callback`,
  `makeV2CallbackData`. `schema_version` on v2 run records.
- Tests: 67 new tests covering all spec §13 acceptance criteria (§13.1–9). All
  tests are injectable (no real `codex`/`claude` binary required).

#### Security
- Updated `SECURITY.md` with v2 local-parity trust model, explicit residual
  risks, capability ceiling (no `danger-full-access`/`bypass` from Telegram),
  and acknowledgement of deferred Phase 2 hardening (OS sandbox,
  per-action approval, project-settings isolation).

#### Integration & fixes (post Opus review)
- Adapters now spawn `detached: true` so the kill switch / `/stop` can SIGTERM the
  agent's whole process group, not just the direct child (§12.2 was previously
  half-met: `process.kill(-pid)` always fell back to a single-process kill).
- Wired v2 into the single Telegram dispatcher (`handleTelegramUpdate`): opt-in via
  `policy.v2_enabled`, owner-only; routes `@agent ...`, `/stop`, `/status` to v2,
  everything else falls through to v1 unchanged. Outbound v2 replies are
  secret-redacted, like v1.
- Added `v2_enabled` (default off) and `workspace_root` to the policy schema +
  `--v2-enabled` / `--workspace-root` CLI flags, so v2 has a production config path.

#### Coexistence
- v1 classifier / task planner / repo allowlist are unchanged. v2 is a new code
  path added alongside v1, not replacing it.

## v0.1.1 — 2026-06-06

### Changed
- Model controls (`agent config opus-model` / `codex-model`) now require owner
  authority, matching the inline model buttons. A gateway-allowlisted operator
  alone can no longer switch runner models.
- Owner natural-language requests that name Claude/Opus with a review intent now
  route directly to an Opus exchange message (no Codex task substitutes for the
  named reviewer). Requests to review it yourself, or explicit refusals to hand
  off, are excluded.
- "照/依/按照/根據這個 plan 做/執行/修正" and "apply/use/follow this/the previous
  plan" follow-ups now resolve the originating plan and pass its id + summary into
  the edit worker prompt. The plan must match the same chat, user, and repo
  (an explicit `task_...` id is honored, else newest by `created_at`); no match
  fails closed with no task created.
- Runner readiness (gateway `@opus` ack and reviewer delegation) now includes the
  kill switch / token budget, so a paused or budget-exhausted runner reports the
  reason instead of queuing a message it cannot process.
- Edit diff reports now attribute only what the task changed. Pre-existing dirty
  tracked text is excluded by numstat delta; binary and untracked files are
  fingerprinted by content hash before and after the task, so a file that was
  already dirty or untracked before the task is reported only when the task
  actually changed its contents. Files that cannot be read/hashed fail closed
  (never claimed as changed), and no raw file content is persisted.

### Known limitations
- Edit diff attribution for **tracked text files** subtracts numstat counts, so an
  edit to a file that was already dirty before the task and that nets the same
  added/deleted line counts (or reverts a pre-existing hunk) can be under-reported
  or shown without direction. (Binary and untracked files are content-hashed and
  not subject to this.) Approval/commit gating is unaffected; only the summary
  text is.

### Documentation
- Clarified that every edit task enters an approval state, while low-risk owner
  edits may be auto-approved by policy (previously implied all edits need a
  manual Approve).
- Narrowed the secret-scanning claim to agent-to-agent messages, replies, diffs,
  test output, and outbound Telegram replies; raw inbound chat is stored locally
  unredacted.
- Corrected the bot-token note: tokens never enter argv or agent state; only the
  curl transport passes the token through a stdin config file.

## v0.1.0 — 2026-06-06

First public release.

- Made Codex Memory River an optional integration.
- Added a package-absent test gate for core operation.
- Added Telegram bot-token secret detection.
- Added persistent retry for failed Telegram gateway replies.
- Added security policy, CI, contributor guidance, and canonical release docs.
