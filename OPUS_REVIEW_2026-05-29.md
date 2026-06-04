# Opus Code Review — codex-memory-river

- Date: 2026-05-29
- Reviewer: Claude Opus 4.7
- Scope: full working tree (repo has no commits yet)
- Status at review time: `npm test` → 29/29 pass; skill file at `~/.codex/skills/codex-memory-river/SKILL.md` exists.

Cross-checked the README claims against the implementation, plus a recall-biased
bug scan. Fix items are ordered by severity. Each item names the file:line and
the concrete failure.

---

## Real code bugs (fix these)

### 1. `recall --repo` silently drops global durable memories
- File: `src/recall.js:40`
- `scoreMemory` returns `null` whenever `--repo` is set and the memory scope is
  not exactly `repo:<resolvedRepo>`. So `global`-scoped durable memories never
  surface in a repo-scoped `recall`.
- This contradicts `src/preflight.js:30`, which deliberately includes
  `global` ∪ `repo:X`. A user who stored a global preference sees it in
  `preflight` but not in `recall`.
- Fix: in repo-scoped recall, accept `memory.scope === "global"` as well as
  `repo:<resolvedRepo>` (mirror the preflight predicate).

### 2. Secret rejection is inconsistent across durable write paths
- Files: `src/memory-store.js` (`storeMemory` vs `approveCandidate` /
  `candidateWarnings`), README line 28.
- `storeMemory` calls `assertNoSecrets` (throws). `approveCandidate` does NOT —
  it relies on `candidateWarnings`, which only emits a non-blocking
  `possible_secret` warning and still writes the memory into `memories.jsonl`.
- README states "durable memory writes reject obvious secret-like content",
  which is only true for the `store` path.
- Important caveat: `addCandidate` also calls `assertNoSecrets`, so a
  secret-bearing candidate cannot be created in the first place. That makes the
  approve-path leak currently UNREACHABLE and makes the `possible_secret`
  warning in `candidateWarnings` effectively dead code.
- Fix (defense-in-depth): call `assertNoSecrets(candidate.content)` inside
  `approveCandidate` before writing, OR make `approveCandidate` block when a
  `possible_secret` warning is present. Then decide whether the warning is still
  needed.

### 3. `maintain --dry-run` flag is a no-op; `--apply` doesn't apply anything
- Files: `src/cli.js:90`, `src/maintainer.js:41`.
- CLI only reads `args.apply`; `--dry-run` is never parsed (default mode is
  already dry-run, so it's harmless but decorative).
- The report file is written to `reports/` ONLY when `--apply` is set; dry-run
  prints the report but never persists it.
- `--apply` performs no maintenance mutations (no dedup, no archiving) — it only
  writes the report to disk. The name "apply" is misleading.
- Fix: either (a) persist the report in dry-run too and rename the persist
  trigger to something like `--write-report`, or (b) document clearly that
  "apply" currently means "write report only". Align README accordingly.

### 4. History chunk text is not length-capped
- File: `src/session-parser.js:16` (`parseHistoryFile`).
- `parseSessionFile` applies `limitText(12000)`, but `parseHistoryFile` stores
  `normalizeText(row.value.text)` with no cap.
- README privacy model says "index records keep capped searchable text"
  (line 26). History chunks can be arbitrarily large.
- Fix: run history text through `limitText` too.

### 5. `status` crashes on a corrupt manifest
- File: `src/status.js:45` (`readJson`).
- `readJson` does a raw `JSON.parse` with no try/catch, while
  `src/indexer.js` `readManifest` tolerates corruption. A damaged
  `manifest.json` lets `index` run but makes `status` throw.
- Fix: give `status`'s `readJson` the same try/catch-returns-null behavior.

### 6. `findStaleCandidates` "not recalled" false positives
- File: `src/maintainer.js:120`.
- When `recalls.jsonl` exists but contains no matching memory ids,
  `recalledMemoryIds` is an empty `Set` (not `null`), so every active memory
  gets flagged `"not recalled"`. Very noisy.
- Note also `resultIds` mixes chunk ids and memory ids (`src/recall.js:29`).
- Fix: only flag "not recalled" when there is a meaningful recall history, or
  compare against memory ids specifically.

## Minor / lower priority

### 7. `recencyScore` is a near-constant offset
- File: `src/suggestions.js:134` — `parsed / 1_000_000_000_000` ≈ 1.77 for
  current timestamps. There is effectively no time decay, just a flat offset.
- Fix: compute decay relative to "now" (or a fixed reference) like
  `recall.js`'s `recencyScore` does, if recency is meant to matter.

### 8. `supersedeMemory` reads the oldest log entry
- File: `src/memory-store.js:159` — uses `.find` over the full append log, which
  returns the FIRST (oldest) entry for `newId`. If `newId` has multiple
  versions, the new supersede entry is built from stale fields and may drop
  `supersedes` added in between.
- Fix: resolve `newId` via the latest-by-id view (as `buildActiveMemories` does)
  before appending.

### 9. `parseArgs` swallows values that start with `--`
- File: `src/args.js:19` — `--content --foo` treats `content` as boolean `true`,
  losing the value (or tripping `requireArg`). Edge case for content/queries
  that begin with `--`.
- Fix: support `--key=value` (already works) and document that leading-`--`
  values must use the `=` form.

---

## README ↔ code mismatches (doc fixes)

| README says | Reality |
|---|---|
| "delete **or supersede** ... **with tombstones**" (L14) | only `delete` writes a tombstone; `supersede` just appends `oldId` to the new memory's `supersedes` array |
| Commands section (L87-106) | omits `supersede` and `candidate reject` (both exist in code and `--help`) |
| `maintain --dry-run` (L105, L126) | flag is never parsed — see bug #3 |
| "durable memory writes reject ... secret" (L28) | only `store` rejects; `approve` warns — see bug #2 |
| "keep capped searchable text" (L26) | history text is not capped — see bug #4 |

## Verified correct (no action)

read-only session ingestion; keyword index; source citations; `rehydrate`;
`store`; candidate add/list/review/approve/reject flow; "no auto-inject / no
autonomous consolidation" scope claims; `.gitignore` + `package.json` `files`
whitelist both exclude `.local-state`; referenced SKILL.md exists; 29/29 tests
pass.

---

## Suggested fix order

1. #1 recall global (correctness, user-visible)
2. #2 / #3 (close the README-vs-behavior gaps on the "evidence-backed, trustworthy" selling point)
3. #4, #5, #6
4. #7, #8, #9 + doc-table fixes

---

# Architecture Direction (added 2026-05-29, from discussion with the user)

This section is design opinion, not bug fixes. It records the conclusions of a
discussion about where this project is heading: turning Codex into an
OpenClaw-like agent by building a portable "exoskeleton" around it (memory layer
first, gateway later), rather than plugging GPT into OpenClaw or trimming
OpenClaw's harness.

## Verdict on the direction

The exoskeleton approach is sound. Reasoning that actually matters (not the
"runner-agnostic, never locked in" sales pitch):

- The memory layer is an independent, worthwhile investment regardless of which
  runner you end up on. That is the real justification — not portability.
- The motivation ("OpenClaw is bloated because it re-stuffs a huge context every
  turn") is better addressed by growing outward from a lean coding-agent harness
  than by fighting someone else's architecture decisions. You keep control.

## Caveats the roadmap glossed over

1. **Do not pre-build the multi-backend adapter layer.** Designing an abstraction
   for Codex / OpenAI API / OpenClaw before a second backend exists is premature
   — abstractions written against one implementation are usually wrong. The real
   portability insurance is *isolation*, which the code already does: keep
   Codex-specific logic confined to `src/session-parser.js` and `src/paths.js`.
   Abstract only when a second backend actually arrives.

2. **The memory model is more Codex-shaped than "runner-agnostic" admits.** It
   indexes a transcript log after the fact. An OpenAI-API agent has no session
   log to index and would need memory written inline. So Codex→OpenClaw (both
   have logs) is portable; Codex→pure-API is a different memory-write model.

3. **"Codex updates won't break us" is ~80% true, not 100%.** Log-format changes
   break the indexer; CLI/sandbox behavior changes break adapters. Lower lock-in,
   not zero maintenance.

4. **Scope risk.** The 10-phase roadmap is a large distributed-system +
   security-boundary project for a solo dev. The realistic failure mode is never
   finishing. Recommendation: **draw the finish line at "a memory layer I use
   daily" (≈ end of Phase 2).** Build the read-only gateway only once daily use
   reveals a concrete need (e.g. wanting to recall from a phone). Do not write a
   line of the execution layer until read-only has proven its value.

## The core design decision: how to inject memory without re-creating the bloat

The thing that makes OpenClaw feel fat — re-stuffing memory/context every turn —
is exactly what this project will be tempted to re-add once `recall` + `preflight`
exist. The user's sharpened framing: **auto-recall is not the problem; injecting
too much, too noisy, irrelevant content is the problem.**

Resolution — **split push vs pull by memory type, not by auto vs manual.** The
two existing layers (`durable_memory` vs raw `chunks`) already are this dividing
line:

- **Durable memory (curated layer) → auto-inject (push).** It is small,
  approval-gated, stable, and almost always relevant (preferences, protected
  zones, workflow rules). It should be present every turn like a system prompt.
  This is also the answer to "the LLM won't reliably recall on its own" — you
  cannot rely on the model to fetch its own standing instructions, so those must
  always be present. Approval keeps this layer small by construction, so it does
  not cause bloat.
- **Raw session chunks (episodic layer) → pull / pointer-only.** This is the
  source of "too much, noisy, irrelevant." Never auto-inject full text; return
  pointer + snippet at most, and require `rehydrate` for full content. Episodic
  history is query-driven — the model knows when it needs history, so pull is
  trustworthy here.

One line: **curated = push, episodic = pull.**

### Three gates on the push layer (so it never becomes fat either)

1. **Hard budget** — cap auto-injection at N entries / X tokens; when full, drop
   the tail by confidence + recency + scope, never inject everything.
2. **Relevance threshold** — run auto-recall against the current turn's user
   message; only inject results above a score threshold. Below-threshold episodic
   results get no pointer at all (stay silent).
3. **Surface conflicts, don't silently pick** — when same scope/type has
   contradictory memories, flag the conflict rather than silently choosing one.
   Silently picking wrong is worse than not injecting.

### Minimal implementation (almost no architecture change)

- `task-start` / `preflight`: inject the durable layer as a standing context block.
- `recall`: default to pointer + snippet only (already the case).
- Raw chunk full text: always via `rehydrate`, never auto-injected.

This lands the whole "auto-recall without bloat" design on top of the structure
that already exists — no major rewrite required.
