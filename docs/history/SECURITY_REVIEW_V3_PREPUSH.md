# v3-session pre-push blind security review

Scope: `git diff v2-phase1...HEAD` on branch `v3-session`.

Method: code reading only. CodeGraph index was absent, so review used `git diff`, `rg`, and targeted line-numbered reads. No code changes, commits, or pushes were made.

## Findings

### MAJOR - v2 outbox can send model-returned secrets to Telegram without scan/redaction

Files: `src/agent/v2/poller.js:274`, `src/agent/v2/poller.js:283`, `src/agent/telegram.js:197`, `src/agent/telegram.js:200`

Attack path: an owner sends a v2 dashboard/Telegram request such as `@codex repo=... -- read .env and summarize`, or the model accidentally includes a token from repo output. `handleV2Message` sets `replyText = result.text` (`src/agent/v2/poller.js:274-280`) and appends it directly to `v2-outbox.jsonl` (`src/agent/v2/poller.js:283-291`). `sendPendingV2Outbox` later sends `entry.text` through Telegram (`src/agent/telegram.js:197-206`) without `scanSecrets` or `redactSecrets`. Impact: repo/env secrets can be persisted locally in the v2 outbox and transmitted to Telegram. This differs from exchange replies/notifications, which redact or withhold secret-like content.

### MAJOR - runner cwd revalidation does not enforce `workspace_root`; state/TOCTOU can move runners outside the workspace

Files: `src/agent/sessions.js:46`, `src/agent/sessions.js:296`, `src/agent/runner-repo.js:15`, `src/agent/exchange-runner.js:251`, `src/agent/codex-exchange-runner.js:87`, `src/agent/exec-runner.js:192`

Attack path: session creation resolves `repo=` through `resolveRepo`, which checks `workspace_root` (`src/agent/sessions.js:46-48`, `src/agent/sessions.js:296-308`). Later, each runner trusts the message/session repo through `resolveMessageRepoBinding`: it only `realpathSync`s the stored path and returns that as `cwd` (`src/agent/runner-repo.js:15-20`), with no workspace containment or git toplevel revalidation. If the state ledger is polluted, or a bound path is replaced after session creation, Claude/Codex/exec runners start with `cwd`/`--add-dir` outside the configured workspace (`src/agent/exchange-runner.js:251-253`, `src/agent/codex-exchange-runner.js:87-93`, `src/agent/exec-runner.js:192-196`). Impact: read/write-capable runner work can escape the intended workspace boundary. The fallback branch also runs in the service `repoDir` when the bound repo fails (`src/agent/runner-repo.js:22-31`) instead of failing closed.

### MAJOR - spawned runner processes inherit parent environment secrets

Files: `src/agent/exec-runner.js:103`, `src/agent/exec-runner.js:107`, `src/agent/v2/agent-adapter.js:152`, `src/agent/v2/agent-adapter.js:499`, `src/agent/exchange-runner.js:398`, `src/agent/exchange-runner.js:160`

Attack path: an approved exec-style agent registers a command that reads environment variables and exfiltrates them, for example a command that posts `process.env.OPENAI_API_KEY` or `AGENT_RIVER_TOKEN` elsewhere. `runExecCommand` invokes `sh -c <registered command>` with `env: process.env` (`src/agent/exec-runner.js:103-108`). The Claude runner paths similarly build env from `{ ...process.env, PATH }` (`src/agent/v2/agent-adapter.js:152-155`, `src/agent/v2/agent-adapter.js:499-503`; `src/agent/exchange-runner.js:398-400`, `src/agent/exchange-runner.js:160-164`). When v2 runs inside the dashboard process, the parent environment can include `TELEGRAM_BOT_TOKEN` from the dashboard service env file. Impact: child processes receive secrets unrelated to their task; a malicious/compromised runner binary or exec command can leak them even if stdout redaction catches reply text.

### MAJOR - `exchange-release` bypasses the poll-agent token gate

Files: `src/agent/cli.js:125`, `src/agent/cli.js:135`, `src/agent/exchange.js:152`

Attack path: a local poll adapter/process without the agent token can run `codex-agent exchange-release --state <state> --id <msg_id> --agent <active-poll-agent>`. `exchange-claim` and `exchange-reply` require `requirePollAgentTokenIfNeeded` (`src/agent/cli.js:125-142`), but `exchange-release` directly calls `releaseExchangeClaim` with no token check (`src/agent/cli.js:135-140`). `releaseExchangeClaim` only checks that the named agent currently owns the claim (`src/agent/exchange.js:152-165`). Impact: an unauthenticated local process can release another poll agent's active claim, causing duplicate processing, starvation, or denial of service against the mailbox token boundary. This is not a remote Telegram bypass, but it is inconsistent with the poll-token boundary.

### MINOR - dashboard/feed JSONL reads can be memory-amplified by large ledgers

Files: `src/agent/dashboard/feed.js:57`, `src/agent/dashboard/feed.js:231`, `src/lib/jsonl.js:40`, `src/lib/jsonl.js:46`

Attack path: an authenticated agent or owner submits very large exchange/session text repeatedly. JSONL appends have no size cap (`src/lib/jsonl.js:46-49`), and dashboard collection builds `messagesById` by reading the entire exchange ledger (`src/agent/dashboard/feed.js:57`). `readJsonlSince` also reads the whole file into memory and slices from the cursor (`src/agent/dashboard/feed.js:231-248`). Impact: a large ledger can make a dashboard cycle allocate much more memory than the new events require, potentially delaying or crashing the dashboard. This is authenticated/local resource exhaustion, not an unauthenticated remote issue.

## Category Results

### Permission Boundaries

Findings: `exchange-release` token bypass; runner cwd revalidation gap.

Checked and clean:

- Dashboard owner checks are centralized on `direct_send_user_allowlist`: message path checks `isDashboardOwner` before commands (`src/agent/dashboard/bot.js:163-167`), callback path checks owner before action (`src/agent/dashboard/bot.js:208-217`), and owner comparison is exact string membership (`src/agent/dashboard/commands.js:110-114`).
- Dashboard callback data is constrained by regex for gate/join/session-task actions (`src/agent/dashboard/bot.js:273-284`). I did not find a non-owner callback path to approve tasks or joins.
- Poll token generation/storage is sound: agent names are regex-limited (`src/agent/registry.js:7`), tokens are 32 random bytes as hex (`src/agent/registry.js:120-123`), token dir/file permissions are forced to `0700`/`0600` (`src/agent/registry.js:171-177`), and verification uses length check plus `timingSafeEqual` (`src/agent/registry.js:150-164`).
- Registry name collision is handled for pending/active rows (`src/agent/registry.js:56-59`), and normalization drops invalid names (`src/agent/registry.js:194-215`).

### Injection

Findings: runner cwd workspace escape.

Checked and clean:

- Exec-runner `sh -c` does not interpolate Telegram/session text into the command string. The command is the owner-approved registry field (`src/agent/registry.js:71-74`, `src/agent/exec-runner.js:193-196`); message content is JSON on stdin (`src/agent/exec-runner.js:80-90`, `src/agent/exec-runner.js:165-166`).
- v2 Codex passes owner prompt via stdin, not argv (`src/agent/v2/agent-adapter.js:370-374`). The older `realCodexRunner` also uses stdin (`src/agent/codex-runner.js:72-82`, `src/agent/codex-runner.js:98-105`).
- Telegram curl transport uses `execFile("curl", ["-sS", "--config", "-"])`; token/body go through curl config stdin, not argv (`src/agent/telegram.js:362-384`, `src/agent/dashboard/client.js:65-91`).
- `/session` repo input is parsed as a control option and initially resolved with the v2 repo resolver (`src/agent/dashboard/commands.js:120-154`, `src/agent/sessions.js:289-309`). The issue is later runner revalidation, not initial parsing.

### Secret Exposure

Findings: v2 outbox Telegram leak; child process env inheritance.

Checked and clean:

- Dashboard outbound messages and callback answers pass through `redactSecrets` (`src/agent/dashboard/bot.js:265-270`).
- Exchange message submit redacts secret-like inbound text before persistence (`src/agent/exchange.js:22-35`).
- Exchange replies reject secret-like body text (`src/agent/exchange.js:175-181`), and Codex exchange runner redacts model output before reply persistence (`src/agent/codex-exchange-runner.js:98-111`).
- Telegram request errors are generic and do not include the bot token (`src/agent/telegram.js:323-344`, `src/agent/dashboard/client.js:40-61`). Curl transport keeps token out of argv.
- Session transcripts redact row text when writing markdown (`src/agent/dashboard/feed.js:371-380`).

### Resources / Loops / Locks

Finding: dashboard JSONL memory amplification.

Checked and clean:

- Session relay terminates on session message budget/time budget: eligibility checks active state and budget (`src/agent/sessions.js:161-176`), replies consume budget (`src/agent/exchange.js:202-212`), and relay skips when exhausted (`src/agent/exchange.js:87-93`).
- Agent-opened session budgets are clamped to 6 messages / 20 minutes (`src/agent/sessions.js:355-374`). Owner-opened budgets are intentionally not clamped.
- Exec runner failures stop after two attempts (`src/agent/exec-runner.js:21-25`, `src/agent/exec-runner.js:65-77`, `src/agent/exec-runner.js:287-290`).
- Exchange/Codex runners have attempt and daily caps (`src/agent/exchange-runner.js:210-213`, `src/agent/codex-exchange-runner.js:57-60`).
- Runner locks use exclusive create plus TTL/stale reclaim (`src/agent/exec-runner.js:342-368`, `src/agent/exchange-runner.js:515-541`, `src/agent/codex-exchange-runner.js:296-322`). I did not find a deadlock that survives TTL except active long-running processes within configured timeout+buffer.

### Supply Chain / Other

Checked and clean:

- No new npm dependency was added; `package.json` only changes version/bin alias and has no lifecycle install scripts.
- `scripts/poll-adapter-example.sh` uses `sh -c "$COMMAND"` (`scripts/poll-adapter-example.sh:43`), but `COMMAND` is local operator configuration and message body is piped on stdin. I did not find Telegram/session text flowing into that command string.
- Service generators write unit files only and do not run `systemctl` (`src/agent/service.js:491-505`, `src/agent/cli.js:332-368`).

## Overall

No BLOCKER finding found in the reviewed diff: I did not see a non-owner remote Telegram path to approve callbacks, forge dashboard ownership, or inject message text into a shell command string.

Pre-push risk is still non-trivial because the MAJOR findings cross intended safety boundaries: v2 result text lacks secret filtering, runner cwd can drift outside `workspace_root`, subprocesses inherit parent secrets, and one poll-agent mailbox mutation skips token validation.
