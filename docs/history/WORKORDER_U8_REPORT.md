# WORKORDER U8 Report

## Summary

- Added hidden `owner` session endpoint handling for session submit/reply eligibility.
- Added owner kickoff helpers and wired them into dashboard `/session` and CLI `session-open`.
- Added CLI `session-open --no-kickoff`.
- Added runner relay after successful session replies for both Claude/opus and Codex runners.
- Relay skips are swallowed and surfaced in runner summaries as `relay_skipped`.

## Behavior

- Owner-opened sessions can send `from=owner` kickoff messages to each participant.
- Kickoff messages are normal exchange messages, so they are redacted, recorded in the exchange mailbox, and consume session message budget.
- Agent-opened sessions do not kickoff.
- Runner replies in active sessions are relayed to the next participant in sorted participant order, excluding the replying agent.
- If the reply exhausts the budget, the session closes as `exhausted` and no relay is sent.
- Messages addressed to `owner` remain mailbox/feed records only; no owner runner is introduced.

## Tests

- Added coverage for owner kickoff ledger rows and budget consumption.
- Added coverage for CLI default kickoff and `--no-kickoff`.
- Added coverage for agent-opened sessions not kicking off.
- Added coverage for relay creation from a runner reply.
- Added coverage for relay stop on budget exhaustion.
- Updated dashboard `/session` tests for kickoff ledger rows and kickoff budget text.

## Verification

- `npm test` passed: 18/18 test files, 0 failures.
