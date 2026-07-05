# WORKORDER U3 self-review report

## What I ran
- `node --test test/agent-registry.test.js test/agent-dashboard.test.js test/agent-sessions.test.js` - pass.
- `node --test test/agent-registry.test.js` - pass after tightening capabilities validation.
- `npm test` - pass, 18 test files, 18 pass.
- `git diff --check` - pass, no whitespace errors.
- `git diff --stat` / `git status --short --branch` - reviewed changed tracked files and new untracked files.
- Forbidden-area diff check: no changes under `src/agent/telegram*.js`, `src/agent/v2/`, `src/agent/direct-send.js`, `src/agent/owner-mode.js`, `src/agent/exchange-runner.js`, or `src/agent/codex-exchange-runner.js`.

## Constraint review
- Added `src/agent/registry.js` as the registry/token module for `<stateDir>/agent-registry.json` with the locked `{ agents: { name: ... } }` shape.
- Added CLI commands:
  - `agent-join --name <name> --style poll|spawn --capabilities read[,write]`
  - `agent-registry-list`
  - `registry-seed`
- `agent-join` validates names with the same agent-name regex shape as sessions, rejects duplicate pending/active names, and only accepts `read` or `read,write` capabilities.
- Dashboard feed now emits pending join events with `join:approve:<name>` / `join:reject:<name>` inline callbacks, cursored through `registry_keys` like U2 `task_keys`.
- Dashboard callbacks reuse the U2 owner gate. Non-owner join callbacks answer `唯讀` and do not mutate the registry.
- Join approval generates a 32-byte hex token, writes only `<stateDir>/agent-tokens/<name>.token`, enforces token dir `0700` and token file `0600`, and flips registry status to `active`.
- Registry JSON, jsonl ledgers, dashboard callback answers, and dashboard messages do not contain the token value. The owner-facing approval notice only says token was written to disk.
- Token verification uses `crypto.timingSafeEqual` and checks buffer length before comparing, so length mismatches return false instead of throwing.
- CLI token checks are enforced only at the CLI boundary for active `poll` registry agents:
  - `exchange-submit --from <poll-agent>`
  - `exchange-inbox --agent <poll-agent>`
  - `exchange-claim --agent <poll-agent>`
  - `exchange-reply --agent <poll-agent>`
  - `session-open --initiator agent:<poll-agent>`
- Bad/missing poll tokens fail with error code `bad_agent_token`; unregistered agent session initiators fail with `agent_not_registered`.
- Owner CLI paths and spawn-style agents remain token-free. Function-level runner paths were not changed.
- `registry-seed` registers current primary agent and enabled exchange agents as active `spawn` agents without token files.
- Session participant validation now allows `dispatchTargetAllowlist ∪ registry active agents` without changing the public function signature.
- Exchange claim/reply now allow active poll registry agents in addition to the existing enabled exchange-agent config path.

## Test coverage added
- Full join flow: CLI join -> pending registry -> dashboard feed event -> non-owner callback denied -> owner approval -> token file exists with mode `0600` -> registry active.
- Token secrecy checks: token is absent from registry JSON and dashboard transport calls.
- Duplicate join rejection and invalid `write`-only capabilities rejection.
- `verifyAgentToken` length mismatch returns false.
- Poll agent `exchange-submit` rejects missing/wrong tokens with `bad_agent_token` and leaves the ledger unchanged; correct token succeeds.
- Poll agent `session-open` rejects missing token and unregistered initiator with stable codes; correct token succeeds.
- Poll agent `exchange-inbox`, `exchange-claim`, and `exchange-reply` reject bad/missing tokens and succeed with the correct token.
- `registry-seed` spawn agents do not create token files; seeded spawn/owner exchange and session paths work without tokens.

## Files changed
- `src/agent/registry.js`
- `src/agent/paths.js`
- `src/agent/cli.js`
- `src/agent/dashboard/feed.js`
- `src/agent/dashboard/bot.js`
- `src/agent/dashboard/commands.js`
- `src/agent/exchange.js`
- `src/agent/sessions.js`
- `test/agent-registry.test.js`
- `docs/history/WORKORDER_U3_REPORT.md`

## Notes
- No commit and no push performed.
- `docs/history/WORKORDER_U3_HANDSHAKE.md` was already untracked when work started and was left as-is.
