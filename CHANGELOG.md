# Changelog

All notable changes to Agent River will be documented in this file.

## v1.0.0 — 2026-09-13

Agent River 1.0 establishes the local agent post office as the core workflow:
one place for an owner, Codex, Claude, and connected agents to exchange letters
and hold bounded group discussions.

### Added
- Local web post office with single-recipient letters, capability routing,
  agent-to-agent delegation, follow-ups, and delivery tracking.
- Group mail with shared context and automatic discussions of 1–3 rounds
  (default 3). Each round waits for all successful replies; a new owner
  instruction supersedes further rounds from the previous discussion.
- Per-letter model and reasoning choices for single-recipient mail; group
  recipients use their own runner configuration.
- Local web control plane, request composer, live status refresh, and CLI/systemd
  integration for running the post office without Telegram.
- English and Traditional Chinese interfaces and onboarding documentation.

### Changed
- Compact conversation view shows group requests once, folds earlier messages
  and delivery records, and keeps active or failed deliveries visible.
- Riverbank visual theme, bilingual README rewrite, and repository cover art.
- Version 1.0 establishes the documented interfaces as a compatibility baseline;
  future incompatible changes will include release notes and migration guidance.

### Fixed
- Fenced agent-mail blocks with trailing newlines now parse consistently for
  delivery and display instead of appearing as raw JSON without being sent.
- Package lockfile version is synchronized with the release version.

### Upgrade notes
- The web post office is the primary entry point; Telegram remains optional.
  Follow the README setup steps to enable runners and start the web service.
- Existing Telegram sessions retain their separate message-budget workflow.
- Existing group letters without round metadata remain manual and do not
  automatically restart discussions after upgrade.
- The supported deployment remains one trusted local operator. Provider CLIs
  and external agent adapters still require their own installation and setup.

## v0.4.0 — 2026-07-06

### Added
- Exec envelope is versioned: it now leads with
  `agent_river_contract: "exec-v1"` and `message_id`, so external adapters can
  rely on a stable, evolvable stdin contract.
- Codex and exec runner replies now parse fenced `agent-dispatch` blocks and
  create pending dispatch approvals, matching the opus lane — every lane can
  propose cross-agent routing, and every proposal still waits for the owner.
- `telegram-codex-policy-set --direct-send-user-add / --direct-send-user-remove`
  restores owner-list management that was accidentally dropped with the v1
  direct-send retirement (fresh installs could not become owner from the CLI).

### Changed
- Dashboard gate approval buttons are bound to a hash of the task content and
  fail closed: buttons whose task changed underneath, and legacy buttons
  without a hash, are refused; approving twice answers idempotently.
- README (en/zh-Hant) rewritten for from-zero onboarding: prerequisites,
  bot + owner bootstrap in an order that actually works, and a session
  walkthrough. SECURITY.md documents the repository trust model (registering a
  repo means executing its code) and state-directory retention responsibility.

### Breaking
- Gate approval buttons sent before this release stop working after upgrade
  (fail-closed by design). Re-trigger the pending approval to get a fresh
  button.

## v0.3.0 — 2026-07-06

### Added
- Collab sessions: budget rings counting only agent messages, kickoff plus
  automatic relay, agent-initiated help requests with read-only fixed small
  budgets, transcript harvesting, and two-step approval to convert a session
  into an edit task.
- Dashboard bot replaces v1 remotes: live feed, `/session`, `/say`, `/sessions`,
  `/kill`, `/agents`, `/model`, `/task`, hard-gate and registry approval buttons,
  and failure pushes that include the original error text.
- Handshake onboarding: `agent-join` with poll+token or one-line exec intake,
  per-agent tokens, and the participant prompt template in
  `docs/AGENT_PROMPT_TEMPLATE.md`.
- v2 `@agent` launcher is merged into the dashboard as the single poller.

### Changed
- Packaging now exposes `agent-river` as a CLI bin and adds `init` for first-run
  state, registry, systemd unit, and Telegram env template setup.

### Breaking
- v1 chat/classifier/old Telegram command surfaces are retired (-9.3k lines).
  The old `codex-agent-telegram-bridge.service` is replaced by
  `codex-agent-dashboard.service`; see
  `docs/history/WORKORDER_U4_KILLLIST.md` for cutover notes.

## v0.2.0 — 2026-06-08

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
  messages route to v2; everything else stays on v1. `schema_version` on v2 run
  records.
- **v2 callback helpers are RESERVED for Phase 3, not a wired path** (§15.J). The
  `v2:turn:<id>:<action>` namespace and `parseV2Callback` / `isV1Callback` /
  `makeV2CallbackData` are scaffolding only; no Telegram callback button is wired
  to them in Phase 1. Per-action approval over callbacks stays Phase 3.
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

#### Fixes (post round-2 Codex review, spec §15)
- **Codex `--json` parser** (§15.D): extract final text from
  `item.completed`/`agent_message` events, sum tokens from `turn.completed`
  usage, and read the thread/session id from the start event — real `codex exec
  --json` format, with JSONL fixtures.
- **Codex resume carries the prompt** (§15.E): `codex exec resume <id>` sends the
  user's new prompt via stdin like a fresh turn (no more null prompt on resume).
- **Background execution + real PID** (§15.A/B): `@agent` turns ack immediately,
  advance the offset, and run in the background; results land in a durable v2
  outbox flushed each poll cycle. Adapters report the spawned PID via `onSpawn`,
  so the active-turn registry stores the real PID and `/stop` + the kill-switch
  sweep can terminate a running child.
- **Process-group timeout** (§15.C): manual `SIGTERM → grace → SIGKILL → confirm`
  on the whole group instead of execFile's built-in `timeout` (which leaves
  detached grandchildren). Fixed a hang where a synchronously-settling
  `execFileImpl` left the kill timer uncleared.
- **Claude settings fail-closed** (§15.F): a missing read/write settings profile
  returns `capability_blocked` instead of launching Claude with provider defaults.
- **Router agent allowlist** (§15.G): only `@codex`/`@claude`/`@opus` are v2; any
  other `@name` falls through to v1.
- **Single-poller lock** (§15.H): a lockfile under agent state; a second poller
  refuses to start.
- **`/status` lists real sessions** (§15.I): `buildStatusReport` enumerates the
  `(owner, chat)` sessions from the store plus active turns.

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
