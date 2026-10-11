# llarhorn — ODD Task Plan

## Goal
Pi extension that balances multiple **named** OpenCode Go API keys:
auto-rotates to another key when the active one hits its rate limit,
and always shows which account is in use via a persistent TUI status indicator
and `/llarhorn` slash commands.

## Context
- Repo: https://github.com/Mjolnirk-Industries/llarhorn (public), local `E:/HomeLab/llarhorn`
- Reference studied: `@lnilluv/pi-opencode-go-rotation` v1.5.3 (npm tarball, read-only copy in `%TEMP%/llarhorn-ref`)
- User's two accounts: `heimdall`, `baldur` (names are user data, not hardcoded)

## Key API mechanics (verified against installed pi 1.1.0)
- Runtime key override: `modelRegistry.runtime.setRuntimeApiKey("opencode-go", key)`
  (takes priority over `OPENCODE_API_KEY` env and `auth.json`; the `authStorage` name from the
  reference is an unreachable branch on 1.1.0 and kept only as a duck-typed forward-compat path)
- Read current key: `await ctx.modelRegistry.getApiKeyForProvider("opencode-go")`
- Events: `session_start`, `message_end`, `after_provider_response`
- Slash command: `pi.registerCommand("llarhorn", { description, handler })`
- Status UI: `ctx.ui.setStatus(...)` + `ctx.ui.setWidget(..., { placement: "belowEditor" })`
- Usage check: `GET https://opencode.ai/zen/go/v1/usage` with the key, 10 s timeout,
  window `rate-limited` + reset timestamp => quota-block until reset
- Config file: `~/.pi/agent/llarhorn-keys.json`, permissions 0600, never print key material

## Differentiators vs reference
1. Name-based switching (`/llarhorn use heimdall`), not index-based
2. Persistent status indicator of the active account (core user requirement)
3. Lean v1: reactive 429 rotation; watchdog stall detection is a documented roadmap item, not v1

## Tasks
- [x] T1 Scaffold: package.json (pi package manifest), tsconfig, .gitignore, MIT LICENSE
- [x] T2 Config store (`src/config-store.ts`) + tests: load/save named keys, 0600, active key, cooldown + quota-block state
- [x] T3 Rotation engine (`src/rotation.ts`, `src/usage.ts`) + tests: eligibility policy, usage-verified 429 handling, runtime key application
- [x] T4 Commands (`src/commands.ts`): `/llarhorn` status, `add`, `use <name>`, `next`, `rm <name>`, `reset`, `usage`, `cooldown`
- [x] T5 Status UI (`src/status.ts`): persistent active-account indicator, updated on session start and every rotation
- [x] T6 Event wiring (`src/index.ts`): `session_start` apply/restore, `message_end` 429 -> usage check -> rotate, `after_provider_response` 429 with dedup
- [x] T7 README.md (install, named-key setup, commands, limitations, roadmap: watchdog)

## Verification
- `npm run typecheck` clean
- `node --experimental-strip-types --test test/*.test.ts`: 46 tests, 45 pass, 1 skipped
  (skip = POSIX 0600 mode assertion, not observable on Windows), stable across two runs
- `npm run build` clean; `dist/index.js` loads as ES module with default export
- Independent verification (gentle-ai-verify): verdict `verified-with-notes`; policy, masking,
  config safety, event scoping/dedup and README-vs-parser audited statically with file:line evidence
- Known limitation: `src/index.ts` event glue and `src/commands.ts` parser are covered by typecheck +
  module-load smoke and static audit only, not by unit tests (no live opencode-go 429 available)
- Post-verification fix: `/llarhorn next` now reports the earliest reset when every key is quota-blocked

## Evidence (commits on `main`)
| Commit | Work unit |
| --- | --- |
| 766b295 | `chore: scaffold pi extension package` (T1) |
| 2884c1e | `feat: named key config store with 0600 atomic persistence` (T2) |
| 978ff46 | `feat: rotation engine with usage-verified rate limit handling` (T3) |
| 674e478 | `feat: /llarhorn commands and persistent status indicator` (T4+T5) |
| 12afb48 | `feat: wire provider events for reactive rotation` (T6) |
| d525f40 | `docs: readme with setup and command reference` (T7) |
