# Contributing

## Development

Requirements:

- Node.js 20 or newer.
- No Codex Memory River checkout is required for core development or tests.

From the repository:

```sh
npm install
npm test
npm run test:no-memory
npm pack --dry-run
git diff --check
```

Keep changes narrowly scoped. Preserve the approval, secret-scan, sandbox, and
manual high-risk action boundaries. Add regression tests for behavior changes.

Do not commit tokens, local agent state, generated service credentials, or
private repository paths. Report security issues privately as described in
[`SECURITY.md`](SECURITY.md).

## Pull Requests

- Explain the user-visible behavior and safety impact.
- Include focused tests and the verification commands run.
- Do not include unrelated refactors.
- Do not weaken owner approval, dispatch approval, runner restrictions, or
  fail-closed behavior without an explicit design discussion.
