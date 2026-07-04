# WORKORDER U1 self-review report

## What I ran
- `node --test test/agent-sessions.test.js` — pass.
- `node --test test/agent-exchange-runner.test.js test/agent-codex-exchange-runner.test.js` — pass.
- `npm test` — pass, 16 test files, 16 pass.
- CLI smoke with temp state:
  - `agent-enable --agent opus --kind review`
  - `session-open --initiator owner --participants codex,opus --budget-messages 3 --budget-minutes 5 --topic "..."`
  - `session-list`
  - Result: active session listed.

## Constraint review
- Session ledger implemented as `<stateDir>/sessions.jsonl` with append-only `session_opened`, `session_message`, and `session_closed` events. Current state is read by folding events.
- Added API functions: `openSession`, `getSession`, `listActiveSessions`, `killSession`, `closeSession`, `consumeBudget`.
- Added CLI: `session-open`, `session-list`, `session-show`, `session-kill`; `exchange-submit` now accepts optional `--session`.
- Agent-initiated sessions auto-include the initiating agent, clamp to 6 messages / 20 minutes, force empty `write_access`, and record clamp details in the opening event.
- Session exchange submit validates active session, participant membership, and remaining budget with stable error codes: `session_not_active`, `not_participant`, `budget_exhausted`.
- Session exchange submit and reply both persist `session_id` and consume message budget. Minute budget expires lazily via `getSession` / active listing.
- Opus and Codex exchange runners now treat active session messages as eligible even when channel is not Telegram/dispatch. Non-session runner eligibility remains unchanged.
- Killed/dead session messages are skipped and recorded in runner dispatch logs as `session_skip:<reason>`.
- Hard-gate runner sandbox/service settings were not changed. `write_access` is only stored/read; no workspace-write execution path was connected.
- Secret handling remains on existing exchange paths: submit still redacts through `redactSecrets`; replies still reject secret-like text through `scanSecrets`.
- Forbidden areas were not edited: no `src/agent/telegram*.js`, no `src/agent/v2/`, no `src/agent/direct-send.js`, no `src/agent/owner-mode.js`, no service/systemd generator changes.
- No commit and no push performed.

## Files changed
- `src/agent/sessions.js`
- `src/agent/paths.js`
- `src/agent/exchange.js`
- `src/agent/exchange-runner.js`
- `src/agent/codex-exchange-runner.js`
- `src/agent/cli.js`
- `test/agent-sessions.test.js`
- `docs/history/WORKORDER_U1_REPORT.md`

## Notes / not done by design
- Token validation for agent-initiated sessions remains out of scope for U1 and is left for U3.
- Telegram dashboard push/control is out of scope for U1 and was not touched.
- `write_access` is persisted but not wired to execution permissions, per workorder.

## Round 2 review fix
- Fixed unbounded `session_skip:*` dispatch logging for killed/dead session messages in both Opus and Codex exchange runners. Each runner now checks its dispatch log for an existing `session_skip:*` row with the same `message_id`; duplicates are not appended and return `no_eligible_message` through the existing no-message path.
- Added regression coverage in `test/agent-sessions.test.js`: both runners are run twice against a killed-session message, asserting the first cycle records exactly one skip row and the second cycle still has exactly one skip row with `reason === "no_eligible_message"`.
- Verification: `node --test test/agent-sessions.test.js` passed; `npm test` passed, 16 test files, 16 pass.
