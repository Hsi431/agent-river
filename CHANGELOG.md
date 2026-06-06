# Changelog

All notable changes to Agent River will be documented in this file.

## Unreleased

### Changed
- Model controls (`agent config opus-model` / `codex-model`) now require owner
  authority, matching the inline model buttons. A gateway-allowlisted operator
  alone can no longer switch runner models.

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
