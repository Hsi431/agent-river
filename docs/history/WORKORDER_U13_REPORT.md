# U13 report — pre-push security hardening

Implemented by Fable directly (codex hit its usage-limit mid-dispatch, unavailable ~2.5h). Four MAJOR findings from SECURITY_REVIEW_V3_PREPUSH.md, all verified against real code before fixing. MINOR (jsonl memory amplification) deferred to backlog ledger-rotation.

## Fixes
1. **exchange-release token gate** (`cli.js`): added `requirePollAgentTokenIfNeeded` to the release case, matching claim/reply. Test: active poll agent without token → `bad_agent_token`; with token → released.
2. **runner cwd workspace containment + fail-closed** (`runner-repo.js` rewrite; 3 runner call sites pass `workspaceRoot` from policy): a bound repo must realpath AND stay inside `workspace_root` (prefix check via `path.relative`, `/ws-evil` cannot pass as inside `/ws`). Invalid or out-of-workspace repo now fails CLOSED to `os.homedir()` + the unbound prompt, never to the service checkout. Tests: outside-workspace repo → homedir + `repo_fallback.reason=outside_workspace`; invalid repo → homedir + `realpath_failed`. Three U12 tests updated from the old fall-back-to-repoDir contract to the new fail-closed contract.
3. **exec child env allowlist** (`exec-runner.js`): `runExecCommand` no longer passes `process.env`; child gets only PATH/HOME/LANG/LC_*/TZ/USER + `AGENT_RIVER_MESSAGE=1`. Never TELEGRAM_BOT_TOKEN / API keys / AGENT_RIVER_TOKEN. Test: fake TELEGRAM_BOT_TOKEN + OPENAI_API_KEY in parent env, exec command prints them → both empty, PATH present, marker=1. claude/codex runners intentionally untouched (they need env to authenticate).
4. **v2 outbox redaction** (`v2/poller.js`): result text is `redactSecrets`'d before `appendV2Outbox`, so secrets don't reach the outbox ledger, transcript, or Telegram. Test: adapter returns text with an `sk-...` key → outbox entry redacted.

## Verification
- `npm test` 376 pass / 0 fail (was 372; +4 new regression tests, 3 contract updates).
- Did not touch: claude/codex runner env inheritance, claude headless settings envelope, dashboard control logic.

## Not done (deferred)
- MINOR jsonl memory amplification → backlog with ledger rotation.
