# Changelog

All notable changes to Agent River will be documented in this file.

## Unreleased

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
