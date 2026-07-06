# WORKORDER U6 REPORT

## Summary
- `/session` topic separator now accepts space-wrapped `--`, em dash `—`, and en dash `–`.
- `/session` local parser errors now return structured `code`/`details` and map to Traditional Chinese dashboard messages for missing separator, missing participants, and bad options.
- `/model` UI now names the Claude runner as `claude runner(信箱名 opus)`, accepts `/model claude <值>`, keeps `/model opus <值>` as a `claude` alias, and keeps `/model codex <值>`.

## Files Changed
- `src/agent/dashboard/commands.js`
- `test/agent-dashboard.test.js`
- `docs/history/WORKORDER_U6_REPORT.md`

## Verification
- `node --test test/agent-dashboard.test.js` PASS
- `npm test` PASS: 18/18 test files passed

