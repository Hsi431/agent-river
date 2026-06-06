# Agent River Roadmap

This roadmap tracks known gaps and future work. It is intentionally separate
from the historical exoskeleton design document so release documentation reflects
the current Agent River product shape.

## Before Wider Source Release

### Codex Memory River Optional Integration

Agent River no longer hard-depends on `codex-memory-river` for core runtime
startup. JSONL helpers, hashing, secret scanning, argument parsing, and path
helpers live in this repo. Memory River is dynamically loaded only when memory
context is requested.

Current result:

- Agent River core starts and runs without a sibling `codex-memory-river` clone.
- Telegram, gateway, approvals, dispatch, model controls, and Codex/Claude
  runners still work.
- Memory River context is optional and fails closed with a clear unavailable
  status when configured but missing.

Remaining work:

- Decide whether a future shared utility package is worthwhile once another repo
  needs the same helpers.

### Documentation Cleanup

- Keep `docs/history/CODEX_AGENT_EXOSKELETON_ARCH_2026-05-29.md` as an archived
  design snapshot.
- Keep `docs/ARCHITECTURE.md` current with real implementation boundaries.
- Document source-release installation clearly.
- Document the deployment rule: code/settings changes require commit, settings
  regeneration when relevant, and bridge restart.

### Release Readiness Review

- Run the full test suite.
- Run a secret/path leak scan.
- Ask a separate reviewer to check safety boundaries:
  - read-only Claude conversation lane,
  - approved edit lane,
  - dispatch approval,
  - owner Q&A guard,
  - model controls,
  - Telegram bridge deployment notes.

## Near-Term Product Work

### Agent Cancel

Add an owner/operator command to cancel queued or pending work without conflating
it with reject/fail states.

Expected result:

- `agent cancel task_...`
- Telegram owner callback or command equivalent.
- Task history records the cancellation reason.

### Agent Log

Add a human-readable operator log command over existing JSON/JSONL ledgers.

Expected result:

- Recent task submissions, approvals, dispatch outcomes, runner failures, and
  token usage can be inspected without reading raw files.
- No raw secrets or unbounded logs are printed.

### Better Memory-Native Task Context

Make memory behavior consistent across Codex plan/edit, Claude review, and
dispatch tasks.

Expected result:

- Curated repo memory is injected only when enabled and available.
- Prompt size remains bounded.
- Memory failures fail closed before invoking a model.
- Completed tasks can propose memory candidates, with owner approval before
  durable writes.

## Later Integrations

### Per-Task Worktree Isolation

Approved edit tasks currently run against an allowlisted repo with sandbox and
command restrictions. A stronger model is to run remote edit work in a per-task
git worktree and report diff/tests from there.

Expected result:

- Remote edit tasks do not mutate the operator's main checkout directly.
- Failed tasks can retain their worktree for inspection.
- Successful tasks report a clean diff and verification result.

### Additional Wake Sources

Add optional ways to create tasks beyond Telegram:

- cron-style scheduled tasks,
- GitHub/webhook events,
- Discord adapter.

These are not needed for the local Telegram-first MVP.

### Stronger Multi-Process Locking

Current operation assumes one primary bridge/runner per state directory. Before
multi-user or multi-machine deployment, task transitions and exchange claims
need stronger atomicity.

Expected result:

- Concurrent bridge/runner processes cannot double-advance a task.
- Exchange claims and dispatch approvals remain idempotent under parallel
  callbacks.

## Explicit Non-Goals

- Automatic commit/push/deploy/install from Telegram.
- Agent-to-agent autonomous loops without owner approval.
- Official OpenAI or Anthropic account quota reporting.
- Replacing the operator's local Codex or Claude configuration by default.
