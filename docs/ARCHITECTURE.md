# Agent River Architecture

Agent River is a local, approval-gated control plane for Codex and Claude
runners. The persistent agent is the Node orchestrator and its on-disk state;
Codex and Claude are spawned as bounded workers for individual steps.

This document describes the current implementation. The older
`CODEX_AGENT_EXOSKELETON_ARCH_2026-05-29.md` file is a historical design
snapshot.

## Core Model

- State lives under `~/.codex/agent` by default.
- Tasks, runs, costs, chat inbox, exchange messages, replies, dispatch approvals,
  and audits are stored as JSON or JSONL.
- Codex is invoked via `codex exec` for plan/edit/direct-reply work.
- Claude is invoked via the exchange runner for the Claude agent lane.
- Telegram is an operator interface, not the source of authority. On-disk state
  is authoritative.
- High-risk operations such as commit, push, deploy, install, delete, reset, and
  broad edits are blocked or require explicit owner approval.

## Main Components

### Gateway

The gateway parses local or Telegram text commands, enforces the allowlist, and
records a hash-only audit. It handles commands such as:

- `agent status`
- `agent models`
- `agent approve task_...`
- `agent reject task_...`
- `@claude ...`
- `@opus ...`

`@claude` is the preferred user-facing Claude agent entrypoint. `@opus` remains
a backwards-compatible alias. Internally both route to the existing `opus`
exchange mailbox lane.

### Telegram Bridge

The Telegram bridge is a foreground long-poll process intended to run under an
operator-managed systemd user service. The CLI can print and write service files,
but it does not enable, start, deploy, or install services by itself.

The bridge handles:

- owner commands and task callbacks,
- model-selection callbacks,
- queued reply delivery,
- exchange reply notifications,
- dispatch approval callbacks,
- bounded Codex direct replies with approval and safety gates.

### Task Orchestrator

Tasks support plan and edit modes. Remote and owner-originated edits are
approval-gated. The orchestrator advances queued approved tasks, appends run
records, appends cost records, and records task history transitions.

Current statuses use the implemented task model (`queued`, `planning`,
`reporting`, `done`, `failed`) plus the approval field (`pending`, `approved`,
`rejected`, `not_required`). This differs from the older design document's
`awaiting_approval` terminology, but the persisted approval semantics are the
same: approval is stored on disk and survives process restarts.

### Codex Runner

Codex plan/direct-reply work runs read-only. Owner-approved Codex edit tasks run
with workspace-write sandboxing. Prompts are passed on stdin, not argv, so user
text is not exposed through process listings. Model selection is optional: when
`codex_runner_model` is empty, Agent River does not pass `--model` and lets the
local Codex configuration decide.

### Claude Agent

The Claude agent handles the `@claude` / `@opus` exchange lane. The normal
conversation/review lane is read-only. Owner-approved Claude edit tasks use a
separate edit runner and settings file that allows edits while still denying
dangerous commands.

The user-facing identity is "Claude agent." It should not call itself Opus except
when discussing the legacy `@opus` alias.

### Exchange Mailbox

The exchange mailbox is a local multi-agent message ledger with claims, replies,
threads, and leases. The Claude runner claims eligible messages and writes
responses through Node-owned reply recording.

### Dispatch

Agents cannot directly submit cross-agent work. They can only propose dispatch
with a structured `agent-dispatch` block in their final reply. Node parses valid
proposals from the agent's final reply only, creates a pending dispatch approval,
and waits for the owner.

Approval outcomes:

- `to=codex`: create a pending Codex task that needs execution approval.
- `to=opus`: submit a `dispatch` channel exchange message to Claude.

This keeps routing consent separate from execution consent.

### Model Controls

The owner can inspect local accounting and switch runner models from Telegram.
The status is explicitly local-only and is not an official OpenAI or Anthropic
quota report.

Claude buttons currently map to default, Sonnet 4.6, and Opus 4.8. Codex buttons
map to default, GPT-5.5, GPT-5.4, and GPT-5.4 mini. The exact model identifiers
are operator-configurable through local config and runner flags.

## Safety Boundaries

- Allowlisted users only.
- Owner-only control plane for approvals and model controls.
- Kill switch before worker invocation.
- Local token budget guard, with disabled-budget sentinel support.
- Secret scan before prompts and outbound replies.
- Dangerous action classifier for commit, push, deploy, install, delete, reset,
  and related operations.
- Separate read-only review lane and approved edit lane.
- Dispatch always requires owner approval before creating a task or exchange
  message.
- Direct sends are conservative for non-owner users. Owner Q&A has a lighter
  guard but still blocks empty, secret-like, too-long, and language-mismatched
  output.

## Memory Integration

Agent River currently has a partial Codex Memory River integration. Telegram
Codex direct replies can include same-chat history and, when configured, a
Memory River context block for the default repo.

This is not yet a fully memory-native agent:

- Claude review does not consistently receive curated Memory River context.
- Every task step does not yet inject a uniform curated memory layer.
- Completed tasks do not yet produce Memory River candidates automatically.
- `codex-memory-river` is still a hard package dependency because Agent River
  reuses several utility modules from it.

The intended direction is to make Memory River an optional integration while
keeping Agent River's core Telegram, approval, dispatch, and runner features
usable without it.

## Current Non-Goals

- No automatic commit, push, deploy, install, or destructive filesystem actions.
- No public webhook endpoint.
- No Discord adapter yet.
- No multi-machine distributed locking guarantee.
- No promise of official account quota reporting.
