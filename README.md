# Agent River

Local approval-gated Codex/Telegram agent control plane.

Agent River is split from Codex Memory River. It can use `codex-memory-river`
as a local dependency for JSONL helpers, secret scanning, preflight context, and
memory context blocks, but it keeps agent state under `~/.codex/agent`.

Run tests:

```sh
npm test
```

Run the CLI from this source tree:

```sh
node bin/codex-agent.js status --state ~/.codex/agent
```
