# Security Policy

## Reporting A Vulnerability

Report vulnerabilities privately through GitHub's **Report a vulnerability**
security-advisory flow for this repository. If that flow is unavailable,
contact the repository owner through a private channel listed on their GitHub
profile. Do not open a public issue containing exploit details, tokens, private
paths, or agent-state contents.

Include the affected commit, reproduction steps, impact, and any suggested
mitigation. Rotate any credential included in a report before sending it.

## Threat Model

Agent River is a local, single-operator control plane. It assumes:

- the host account, Node.js runtime, configured repositories, and local Codex
  and Claude installations are trusted;
- Telegram is an untrusted transport and only allowlisted users may enter the
  gateway;
- model output and agent-proposed dispatch blocks are untrusted until checked
  by Node-owned safety and approval gates;
- high-risk actions such as commit, push, deploy, install, delete, reset, and
  broad edits remain manual or require explicit owner approval;
- one primary bridge/runner set owns an agent state directory.

Agent state under `~/.codex/agent` can contain raw task, chat, prompt, reply,
repository, and audit data. Keep it private, restrict filesystem access, and
never commit it.

## Authority Levels

Gateway allowlist membership grants operator access to bounded gateway and
exchange functions. It does not grant owner authority.

Owner authority additionally requires owner mode and membership in the direct
send user allowlist. Owner checks protect edit execution, callback approvals,
dispatch routing, and model controls. Routing approval does not replace the
separate execution approval required for Codex edits.

## External Trust Boundaries

The Claude runner safety envelope depends on Claude Code permission semantics:

- `claude -p` with `permissions.defaultMode: "default"` must auto-deny tools
  not present in the allowlist;
- Bash permission rules must reject chained, compound, or otherwise expanded
  commands that exceed an allowed command pattern;
- edit mode relies on `acceptEdits` plus the configured working directory and
  `--add-dir` scope.

Agent River supports Claude Code `2.1.162` or newer. Treat Claude Code upgrades
as security-sensitive: regenerate/review settings and rerun the full test suite
before deployment. If upstream permission behavior changes, disable the Claude
runner until the envelope is revalidated.

Codex execution similarly depends on the local Codex CLI honoring its sandbox,
approval, and working-directory options.

## Known Limitations

- JSONL ledgers assume a single primary writer set. Concurrent manual commands
  and duplicate services can race; do not run multiple bridges against one
  state directory.
- Rate limits are global/per-chat or lane-level, not a general per-user gateway
  throttle. Token budgets and daily caps bound model use.
- Generated systemd command lines assume paths without whitespace. Review every
  generated unit before enabling it.
- This project does not provide distributed locking or a multi-machine
  consistency guarantee.
