# WORKORDER U12 Report

Date: 2026-07-06
Branch: v3-session

## Done

- Budget semantics changed so owner session submits (`/session` kickoff and `/say`) do not consume `messages_used`.
- Agent session submits still consume budget except relay submits on `session-relay`.
- Agent replies still consume budget, and exhaustion checks continue to reject already exhausted sessions.
- Dashboard feed now suppresses owner-origin session exchange-message pushes while keeping agent messages and session close pushes.
- Runner repo binding added for:
  - `exchange-runner.js`: session message `repo` realpath becomes Claude cwd and `--add-dir`.
  - `codex-exchange-runner.js`: session message `repo` realpath becomes runner cwd.
  - `exec-runner.js`: session message `repo` realpath becomes exec cwd unless the exec agent has an explicit `exec_cwd`.
- Runner prompts/envelopes now include either:
  - `本 session 綁定 repo:<path>`
  - `本對話未綁定任何 repo;不要假設題目與你目前所在的 codebase 相關,依題目本身回答`
- Invalid message repos fall back to the original runner `repoDir` and write `repo_fallback` into the runner dispatch row.
- `codex exec` now receives the effective cwd through `-C <cwd>` as well as the process cwd option.

## Tests Added/Updated

- Owner kickoff and `/say` leave `messages_used` at `0`.
- Agent reply consumes budget; relay submit does not.
- Full ping-pong budget sequence is `kickoff 0 + A reply 1 + relay 0 + B reply 1 = 2/N`.
- Dashboard feed suppresses owner session messages and still sends agent session messages.
- Claude, Codex, and exec runners use bound repo cwd and record invalid repo fallback.
- Unbound Codex/exec prompts include the required unbound repo warning.
- Codex runner argv tests updated for `-C <cwd>`.

## Verification

- `npm test` passed.
- Result: 19/19 test files passed, 0 failures.

## Notes

- No commit or push was performed.
- Existing pre-worktree changes in `docs/AGENT_RIVER_V3_SESSION_DASHBOARD.md` were left untouched.
