# Agent River Web GUI

The Web GUI is an optional local control surface for Agent River. It presents the existing mailbox, dispatch, session, agent, safety, and completion state in a browser. Telegram remains supported, and the GUI does not add a database or a parallel workflow.

The visual layout follows the dark navy and purple direction in `agentriver_gui.png`, but every displayed record and count comes from real Agent River state. The GUI does not create fake charts, metrics, health states, summaries, or placeholder records.

For the design and source-of-truth mapping, see [WEB_GUI_ARCHITECTURE.md](WEB_GUI_ARCHITECTURE.md).

## Commands

Run these commands from the Agent River repository. The four Web commands are:

```bash
node bin/codex-agent.js web-service-print --state ~/.codex/agent --repo "$PWD"
node bin/codex-agent.js web-service-write --state ~/.codex/agent --repo "$PWD" --dir ~/.config/systemd/user
node bin/codex-agent.js web-service-status --state ~/.codex/agent --repo "$PWD"
node bin/codex-agent.js web --state ~/.codex/agent --repo "$PWD" --port 4310
```

`web` listens only on `127.0.0.1`. The default URL is:

```text
http://127.0.0.1:4310/
```

There is no option to bind the v1 server to a LAN or wildcard address.

## Pages

| Page | Purpose |
| --- | --- |
| `/` | Dashboard counts and safety warnings backed by current state. |
| `/compose` | Submit a direct agent request or open a read-only multi-agent session. |
| `/inbox` | Exchange messages and replies, dispatch requests, tasks/results, and persisted runner alerts. |
| `/inbox/:id` | One normalized record, its relationships, source ledger path, and redacted raw JSON. |
| `/dispatch` | Folded dispatch approvals with actions only while an approval is pending. |
| `/sessions` | Folded session records and their real budgets, participants, repos, and states. |
| `/sessions/:id` | Session metadata and an audit timeline assembled from session and exchange records. |
| `/agents` | Registry state and dispatch-route configuration shown separately. Token contents are never displayed. |
| `/safety` | Kill switch, budget, policy, lock-file presence, and systemd unit-file drift. |
| `/archive` | A read-only projection of terminal records; it is not persistent archive metadata. |

The layout is dense and review-oriented rather than chat-first. Unsupported controls are omitted instead of being represented with invented backend data.

Inbox and session detail pages refresh their current record every five seconds. Auto-refresh pauses while a form is focused or contains unsent changes so in-progress input is not replaced.

## New request workflows

`/compose` exposes two distinct queueing paths:

- **Direct request** writes one canonical Web mailbox envelope to one eligible direct route. Fields are target, required request text, optional subject (up to 120 characters), and optional repository. The primary Codex route and eligible enabled agent routes are offered. Agent River requests a wake-up from a managed runner when available, but submission only means the item was queued; it does not mean the agent completed it.
- **Multi-agent session** opens an owner-initiated session with at least two participants, a 5–500 character topic, an optional repository, and optional positive-integer message and minute budgets. Defaults are 10 messages and 30 minutes. Session eligibility follows the existing session domain policy: the primary agent, enabled exchange routes, and active registered agents can participate, even when an active registered agent is not a direct-request route.

Session creation calls the existing `openSession` path and then the existing kickoff path. The topic is queued once to every participant with the session ID and resolved repository. Owner kickoff messages do not consume the session message budget; agent replies do. The Web workflow never supplies session write access, so sessions opened in the browser have an empty `write_access` list.

An active `/sessions/:id` page includes an owner-instruction form. It broadcasts one canonical `session-say` message to every participant and then reloads the audit view. This is the same domain operation used by Telegram `/say`; owner follow-ups do not consume the agent-reply budget. Closed, killed, exhausted, or unknown sessions reject follow-ups.

Repository values are optional. When supplied, both workflows use the existing repo resolver and policy: the target must resolve to a Git worktree within the configured workspace root, and the canonical repository top level is stored. Omitting the field leaves the envelope or session unbound; the Web layer does not invent a repository or grant write capability.

## JSON API

Read endpoints:

```text
GET /api/status
GET /api/request-options
GET /api/inbox
GET /api/inbox/:id
GET /api/dispatch
GET /api/sessions
GET /api/sessions/:id
GET /api/agents
GET /api/safety
GET /api/archive
```

Safety-gated action endpoints:

```text
POST /api/requests
POST /api/sessions
POST /api/sessions/:id/messages
POST /api/dispatch/:id/approve
POST /api/dispatch/:id/reject
POST /api/sessions/:id/kill
POST /api/agents/:name/enable
POST /api/agents/:name/disable
POST /api/stop
```

All mutations use the browser security boundary described below. Direct requests, session creation, and session follow-ups submit without an extra confirmation dialog. Dangerous or state-transition controls require the server's matching confirmation value. Dispatch approve/reject calls the existing dispatch domain functions. Session kill calls the existing session function. Agent actions change an eligible existing dispatch route; they do not approve a pending registry join or issue an agent token.

The request and session endpoints reject unknown fields before calling domain mutations. They do not accept a write mode, write-access list, agent identity override, or arbitrary command. They enqueue existing mailbox/session records and do not bypass dispatch approval, task execution approval, kill-switch checks, secret redaction, budgets, agent registration, or runner policy.

Approving a dispatch does not approve its eventual file edits. A dispatch to the primary Codex agent creates a task whose execution approval remains `pending`, preserving the separate execution safety gate.

`POST /api/inbox/:id/archive` is reserved but returns `501 Not Implemented`. Agent River currently has no archive, unread, reviewed, or other per-item Web metadata ledger. `/archive` and `/api/archive` therefore derive terminal records without writing state.

## State sources

The GUI reads the same resolved `--state` directory as the CLI, normally `~/.codex/agent`:

| Data | Existing source |
| --- | --- |
| Mailbox | `exchange-messages.jsonl`, `exchange-claims.jsonl`, `exchange-replies.jsonl` |
| Dispatch | `dispatch-approvals.jsonl` |
| Sessions | `sessions.jsonl`, plus existing files under `session-transcripts/` |
| Tasks and results | JSON files under `tasks/` |
| Agents | `agent-registry.json` and dispatch-route entries in `config.json` |
| Safety and routing policy | `config.json` and daily accounting in `cost.jsonl` |
| Runner alerts | Existing Opus, Codex, and exec runner dispatch ledgers |
| Lock indicators | Existing dashboard and runner lock files |
| Service unit checks | Unit files in the selected systemd user directory |

All paths are resolved through the existing Agent River path and domain modules. Raw JSON views recursively redact recognized secret-like values and sensitive fields. Agent token files and Telegram bot token values are not returned.

## Browser and owner security model

The Web server is local-only and trusts processes running as the same local user. It is not an authentication boundary against a malicious same-user process, because such a process can already reach the state files and local CLI. Do not expose the port through a reverse proxy, port forward, container publish rule, or SSH tunnel to untrusted clients.

Browser mutations have an additional loopback CSRF boundary:

- the server accepts only the exact `127.0.0.1` or `localhost` Host with its actual port;
- HTML receives a signed, process-lifetime session cookie with `HttpOnly` and `SameSite=Strict`;
- a signed CSRF value is supplied separately to the same-origin client script;
- actions require an exact same-origin `Origin`, the signed cookie, the CSRF value, JSON content type, and a bounded request body; dangerous controls additionally require an explicit confirmation value;
- state-changing `GET` requests are not supported;
- responses use a restrictive Content Security Policy and do not enable permissive CORS.

The Telegram owner allowlist is separate. It continues to authorize Telegram dashboard messages and callbacks; it is not reused as a Web login. Likewise, Web browser authority does not replace agent poll tokens, registry join approval, secret scanning, repo resolution, kill-switch checks, budgets, or task execution approval.

## Stop limitation

The Web `Stop all` action first persists the existing kill switch, which blocks new work through the normal safety checks. It then asks the Web process to terminate any v2 turns registered in that process.

Active turns owned by the Telegram dashboard or another runner process are not synchronously visible to the standalone Web process. The action response reports this limitation and does not claim that cross-process termination occurred. The persistent kill switch remains the fail-safe control; immediate cross-process termination would require a future IPC or service-control design.

## systemd user service

Inspect the unit that would be generated:

```bash
node bin/codex-agent.js web-service-print --state ~/.codex/agent --repo "$PWD"
```

Write the unit file, then explicitly reload and enable it:

```bash
node bin/codex-agent.js web-service-write --state ~/.codex/agent --repo "$PWD" --dir ~/.config/systemd/user
systemctl --user daemon-reload
systemctl --user enable --now codex-agent-web.service
```

The print, write, and status commands never run `systemctl`, enable a unit, or start a service. They only generate, write, or inspect files.

Check the expected unit file and view service logs:

```bash
node bin/codex-agent.js web-service-status --state ~/.codex/agent --repo "$PWD"
systemctl --user status codex-agent-web.service
journalctl --user -u codex-agent-web.service -n 50
```

`web-service-status` reports whether the unit file is missing, matches the generated content, or has drifted. This is unit-file status, not runtime service health. Use `systemctl --user status` for the runtime state.

## Troubleshooting

- **The browser cannot connect:** confirm the process is running, the port is `4310` unless overridden, and use `http://127.0.0.1:4310/` rather than a LAN hostname.
- **`421 Misdirected Request`:** the Host header does not exactly match the loopback address and listening port. Remove a proxy or use the local URL directly.
- **`403 invalid_origin`, `invalid_session`, or `invalid_csrf`:** reload the page from the same local origin. Restarting the Web process invalidates its process-lifetime browser authority.
- **`409 action_failed`:** the existing domain gate rejected the action, for example because a dispatch is no longer pending, a session is already closed, or a dispatch route is ineligible.
- **`501 not_implemented` for archive:** persistent archive/read metadata is intentionally not implemented in v1.
- **A lock file is shown as present:** this reports filesystem presence, not runner health or proof that its PID is alive.
- **A service is shown as missing or drifted:** regenerate with `web-service-write`, inspect local modifications, then run `systemctl --user daemon-reload` yourself if appropriate.

## Verification

From the repository root:

```bash
npm test
npm run test:no-memory
npm pack --dry-run
git diff --check
```

The test suite includes real temporary state projections, loopback HTTP routes, HTML escaping, Host and CSRF rejection, bounded JSON action bodies, failure non-mutation, and dispatch approval preserving its separate execution gate.
