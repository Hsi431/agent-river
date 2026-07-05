#!/usr/bin/env bash
# Poll adapter example for an agent that already has a CLI command.
# Edit AGENT, STATE, TOKEN_FILE, and COMMAND. The command receives the message
# body on stdin and must write the final reply on stdout.

set -euo pipefail

STATE="${STATE:-$HOME/.codex/agent}"
AGENT="${AGENT:-otter}"
TOKEN_FILE="${TOKEN_FILE:-$STATE/agent-tokens/$AGENT.token}"
COMMAND="${COMMAND:-cat}"
AGENT_RIVER_BIN="${AGENT_RIVER_BIN:-bin/codex-agent.js}"

codex_agent() {
  node "$AGENT_RIVER_BIN" "$@"
}

inbox_json="$(codex_agent exchange-inbox --state "$STATE" --agent "$AGENT" --token-file "$TOKEN_FILE")"
msg_id="$(printf '%s' "$inbox_json" | node -e '
let raw = "";
process.stdin.on("data", (c) => raw += c);
process.stdin.on("end", () => {
  const data = JSON.parse(raw || "{}");
  const msg = (data.messages || [])[0];
  process.stdout.write(msg ? msg.id : "");
});
')"

if [ -z "$msg_id" ]; then
  exit 0
fi

codex_agent exchange-claim --state "$STATE" --id "$msg_id" --agent "$AGENT" --token-file "$TOKEN_FILE" >/dev/null
thread_json="$(codex_agent exchange-thread --state "$STATE" --id "$msg_id")"
body="$(printf '%s' "$thread_json" | node -e '
let raw = "";
process.stdin.on("data", (c) => raw += c);
process.stdin.on("end", () => process.stdout.write(JSON.parse(raw).message.text || ""));
')"

reply_file="$(mktemp)"
trap 'rm -f "$reply_file"' EXIT
printf '%s\n' "$body" | sh -c "$COMMAND" > "$reply_file"
codex_agent exchange-reply --state "$STATE" --id "$msg_id" --agent "$AGENT" --token-file "$TOKEN_FILE" --from-file "$reply_file"
