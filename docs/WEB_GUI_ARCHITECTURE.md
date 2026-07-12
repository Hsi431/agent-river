# Web GUI Architecture

## Scope

The Web GUI is an optional, local-first view over Agent River's existing state and owner operations. Telegram remains supported, and the Web surface must not introduce a second task, mailbox, dispatch, session, registry, safety, or service state system.

Version 1 uses the existing Node.js runtime, server-rendered HTML, plain CSS, and small client-side JavaScript. It adds no framework, database, cloud service, or fake data.

## Existing sources of truth

All paths below are relative to the resolved agent state directory (`--state`, normally `~/.codex/agent`). `src/agent/paths.js` exports `agentPaths(agentHome)`, which is the canonical path map.

| Concern | Existing state | Existing readers and mutations to reuse |
| --- | --- | --- |
| Exchange mailbox | `exchange-messages.jsonl`, `exchange-claims.jsonl`, `exchange-replies.jsonl` | `src/agent/exchange.js`: `listExchangeInbox`, `listExchangeReplies`, `getExchangeThread`, `exchangeStatus`, `submitExchangeMessage`, `claimExchangeMessage`, `releaseExchangeClaim`, and `replyExchangeMessage`. Claims are append-only events folded by the module; completed messages are excluded from the open inbox. |
| Exchange notification delivery | `exchange-notifications.jsonl` | `src/agent/telegram.js`: `sendPendingExchangeNotifications`. This is a Telegram delivery/deduplication ledger, not an inbox read-state ledger. |
| Dispatch approvals | `dispatch-approvals.jsonl` | `src/agent/dispatch.js`: `listDispatchApprovals`, `getDispatchApproval`, `createDispatchApproval`, `approveDispatch`, and `rejectDispatch`. Approval events are append-only and folded by dispatch id. |
| Sessions | `sessions.jsonl`; generated transcripts under `session-transcripts/` | `src/agent/sessions.js`: `getSession`, `listActiveSessions`, `openSession`, `closeSession`, `killSession`, `consumeBudget`, and `assertSessionMessageAllowed`. `src/agent/dashboard/feed.js`: `writeSessionTranscript` and `lastSessionMail`. Session state is an event fold, not one row per current session. |
| Agent registry | `agent-registry.json`; poll-agent credentials under `agent-tokens/` | `src/agent/registry.js`: `readAgentRegistry`, `listRegisteredAgents`, `getRegisteredAgent`, `joinAgentRegistry`, `approveAgentRegistration`, `rejectAgentRegistration`, `isActiveRegisteredAgent`, and `verifyAgentToken`. The Web read model must never expose token contents. |
| Safety policy and owner configuration | `config.json`; usage in `cost.jsonl` | `src/agent/safety.js`: `readAgentConfig`, `getTelegramCodexPolicy`, `getSafetyStatus`, `checkSafety`, `setKillSwitch`, `setDailyTokenBudget`, `enableExchangeAgent`, and `disableExchangeAgent`. A missing config gets safe defaults; a corrupt config is normalized fail-closed. |
| Kill switch | `config.json` field `kill_switch` | `src/agent/safety.js`: `setKillSwitch` persists the switch and `checkSafety` gates future work. `src/agent/v2/kill.js`: `stopAllTurns` terminates turns registered in that Node process only. |
| Telegram dashboard | `dashboard-cursor.json`, `dashboard.lock`, plus the ledgers above | `src/agent/dashboard/bot.js`: `dashboardOnce`, `dashboardBridge`, `acquireDashboardLock`, and its internal owner-checked message/callback handlers. `src/agent/dashboard/feed.js`: `collectDashboardFeed` and callback markup helpers. Legacy dispatch callbacks in `src/agent/telegram.js` authenticate the Telegram owner before calling dispatch functions. |
| systemd user services | Unit files in the caller-selected systemd user directory; runner settings remain in their existing locations | `src/agent/service.js`: the `build*Service`, `write*Service`, and `*ServiceStatus` pairs for Opus, Codex, exec runners, and the dashboard. The Web service must follow the same print/write/status pattern rather than enabling or starting units implicitly. |

JSONL access continues through `src/lib/jsonl.js` (`readJsonl`, `appendJsonl`, and `writeJsonl`). The GUI must tolerate absent files in the same way as the existing readers and must not rewrite ledgers while serving reads.

## Read-model boundary

`src/web/read-model.js` will be a projection layer, not a persistence layer. It will:

- call existing domain readers where they already express the current state;
- join exchange messages, claims, replies, dispatches, sessions, tasks, and registry entries by their existing ids;
- preserve source ids, timestamps, repo/session/dispatch relationships, and raw records for local debugging;
- derive display status only from persisted events, without changing their meaning;
- return `null`, an empty collection, or an explicit unavailable field when the backend has no value;
- redact sensitive configuration fields and never read or return Telegram tokens or agent token files.

The read model will not calculate invented response-time averages, charts, health scores, budget impact, unread counts, heartbeat times, or summaries. A metric or card is rendered only when an existing record supports it.

There is currently no archive, unread, reviewed, or per-item Web metadata ledger. `/archive` can initially be a read-only projection of terminal records (completed/rejected/failed/closed), but `archive` and `mark reviewed` mutations must remain unavailable until a deliberately specified local metadata format and migration policy exist. The Telegram notification ledger must not be repurposed for this.

### Status projection

UI statuses are projections of existing fields, not new workflow states:

- an exchange message with no terminal claim remains open;
- a live claim is working, and an expired or released claim is open again;
- a completed claim is paired with its persisted reply and treated as completed;
- a dispatch keeps its folded `pending`, `approved`, or `rejected` status;
- a task uses its existing task approval and execution status;
- a session uses its folded `active`, `closed_ok`, `exhausted`, or `killed` state;
- a registry entry uses its existing `pending`, `active`, or `rejected` status.

Labels such as `unread`, `ready_to_review`, and `archived` are not inferred unless a real existing event supports them. The UI may group records by the statuses above, but it must preserve the underlying source status in JSON responses.

## Server and browser security boundary

The `web` command listens on `127.0.0.1` by default. Version 1 does not accept a public or wildcard bind address. The server also rejects unexpected `Host` headers, emits no permissive CORS headers, sets a restrictive Content Security Policy, and does not place secrets in HTML or JSON responses.

Loopback binding is not sufficient authorization for mutations: any page opened in the owner's browser can attempt a request to a loopback service. On startup, the Web server therefore creates an unpredictable, process-local action token. HTML forms receive a token tied to a `SameSite=Strict`, `HttpOnly` session cookie. Every mutating `POST` must validate both that token and an exact same-origin `Origin` header (with a conservative `Referer` fallback only where required), reject cross-origin and tokenless requests, accept only the expected form or JSON content type, and use no state-changing `GET` routes. Dangerous operations also require an explicit confirmation value in the request body.

This boundary authenticates a browser session to the local Web process. It does not replace the Telegram owner allowlist, agent poll tokens, dispatch checks, task execution approval, secret scanning, repo resolution, or runner safety gates.

## Action reuse

Dispatch actions call `approveDispatch` and `rejectDispatch` from `src/agent/dispatch.js` directly. They do not reproduce dispatch state transitions in the HTTP layer.

`approveDispatch` already requires a pending approval. A dispatch to the primary agent calls the existing `createTask` path with `approval: "pending"`, so edit execution still requires its separate task approval. A dispatch to another enabled agent calls the existing `submitExchangeMessage` path. The Web layer supplies the configured `telegram_codex_policy.default_repo`, matching the existing Telegram callback path, and reports a missing default repo instead of inventing one. Proposal creation continues to enforce target allowlisting, self-dispatch prevention, hop limits, task bounds, and secret scanning through the existing dispatch module.

Session kill, exchange-agent enable/disable, and kill-switch mutations likewise call the existing exported functions. Registry records currently have `pending`, `active`, and `rejected` states but no general `disabled` transition; the GUI must not label a new registry mutation as supported. Join approval/rejection can be exposed separately through `approveAgentRegistration` and `rejectAgentRegistration` after the same Web action boundary is tested.

### Stop-all limitation

`stopAllTurns` operates on an in-memory registry in `src/agent/v2/kill.js`. A standalone Web server cannot directly see turns owned by the dashboard or another runner process. A Web `/api/stop` action can safely persist the existing kill switch, which prevents new work and is swept by the dashboard, but it must not claim synchronous termination of turns in other processes. Immediate cross-process stop needs an explicit IPC or service-control design and is outside the first read-mostly slice. The response and UI must state this limitation.

## Planned routes

HTML pages:

- `GET /` — real system, agent, session, approval, inbox, completion, and warning counts that are available.
- `GET /inbox` and `GET /inbox/:id` — exchange messages/replies, dispatch requests, task results, and system events backed by existing records.
- `GET /dispatch` — dispatch approval list and detail links.
- `GET /sessions` and `GET /sessions/:id` — folded session state and an audit timeline assembled from existing session and exchange records.
- `GET /agents` — registry and configured exchange agents without token material.
- `GET /safety` — policy, kill switch, budget, lock, and existing service-status results.
- `GET /archive` — derived terminal records only; no persistent archive/read status in v1.

JSON reads:

- `GET /api/status`
- `GET /api/inbox` and `GET /api/inbox/:id`
- `GET /api/dispatch`
- `GET /api/sessions` and `GET /api/sessions/:id`
- `GET /api/agents`
- `GET /api/safety`
- `GET /api/archive`

Initial mutations, all protected by the Web action boundary:

- `POST /api/dispatch/:id/approve`
- `POST /api/dispatch/:id/reject`
- `POST /api/sessions/:id/kill`
- `POST /api/agents/:name/enable` and `POST /api/agents/:name/disable` for existing exchange-agent configuration only
- `POST /api/stop` to persist the kill switch, with the cross-process limitation above

`POST /api/inbox/:id/archive` is reserved but not implemented while no archive metadata source exists. Agent registry enable/disable, session archive, settings writes, and free-form compose are also deferred rather than represented as working controls.

## Service integration

The new CLI commands will parallel the existing service helpers:

- `web` starts the loopback HTTP server.
- `web-service-print` renders the proposed systemd user unit without writing it.
- `web-service-write` writes the unit to the explicit directory but does not enable or start it.
- `web-service-status` compares the expected unit with disk and reports missing, matching, or drifted state.

Telegram code paths and service definitions remain unchanged. The Web server reads the same `--state` and `--repo` inputs and introduces no background poller or competing dashboard lock.

## Verification boundary

Tests will cover read-model normalization from real temporary ledgers, missing/corrupt optional state, raw-record redaction, loopback/Host enforcement, CSRF and same-origin rejection, and at least one approve/reject dispatch action proving that the existing dispatch function creates the expected pending task or exchange message. Existing tests must continue to pass.
