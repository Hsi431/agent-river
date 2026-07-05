# WORKORDER U7 Report

## Summary

- Added exec-style registry support: `agent-join --style exec --exec '<command>'` stores `exec_command`, `exec_timeout_seconds` (default 300), and optional `exec_cwd`.
- Dashboard join feed now includes the full exec command, and exec approval is token-free (`Node 代管,不產 token`); poll approval still writes the token file.
- Added `src/agent/exec-runner.js` and CLI `exec-runner-once`.
  - Scans active exec registry agents.
  - Picks one eligible message per agent using codex-runner-style eligibility.
  - Claims in Node, runs `sh -c <registered command>` with message data only on stdin, truncates stdout to 64KB, writes `replyExchangeMessage`, and relays session replies.
  - Starts commands detached and uses `terminateGroup` on timeout.
  - Releases failed/timeout claims and caps failed attempts at 2 via `<stateDir>/exec-runner-dispatch.jsonl` rows that include agent name.
- Added exec runner systemd generation: `exec-runner-service-print/write/status`, one-shot service plus 90-second timer, files only.
- Added README sections for "Connect Any Agent"/「接入任意 agent」 and `scripts/poll-adapter-example.sh`.

## Tests

- `node --test test/agent-registry.test.js test/agent-dashboard.test.js test/agent-exec-runner.test.js test/agent-sessions.test.js` - pass.
- `npm test` - pass, 19 test files, 19 pass.
- `git diff --check` - pass.

## Coverage Added

- exec join -> dashboard feed -> owner approval -> active registry row with command and no token file.
- session end-to-end with real `cat`: owner message -> exec runner stdin/stdout -> reply ledger -> session relay.
- timeout of a real detached process with `terminateGroup`, release claim, dispatch log outcome.
- stdout truncation to exactly 64KB.
- failed attempts release claims and stop being picked after 2 attempts.
- exec runner service generator emits the expected service/timer without systemctl.

## Self-Review

- Did not modify existing runner files, `telegram.js`, or `src/agent/v2/*` beyond importing `terminateGroup` from the new runner.
- Message text is never interpolated into the exec command; the registered command is passed to `sh -c`, and the request envelope goes through stdin.
- Poll token enforcement remains poll-only; active exec agents are enabled for mailbox claim/reply through the registry and do not receive token files.
- No commit or push performed.
