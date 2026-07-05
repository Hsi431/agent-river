# WORKORDER U9 Report

## Summary

- Added sanitized `error` fields to exchange, codex-exchange, and exec runner dispatch failure rows.
- Extended dashboard feed cursors to scan the three runner dispatch ledgers and notify only terminal failures.
- Added dashboard `/say <session> <text>` to broadcast owner interjections to active session participants with budget checks.
- Added closed-session transcript harvesting under `<stateDir>/session-transcripts/<session_id>.md`.
- Deduped same-cycle dashboard `/session` `session_opened` feed notifications while preserving CLI-opened session feed notices.

## Verification

- `node --test test/agent-dashboard.test.js test/agent-exchange-runner.test.js test/agent-codex-exchange-runner.test.js test/agent-exec-runner.test.js`
- `npm test`

Both passed before handoff.

## Notes

- No commits or pushes were made.
- Did not touch runner eligibility/relay logic, `sessions.js`, `v2/`, or `telegram.js`.
