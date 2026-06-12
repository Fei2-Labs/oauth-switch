# PRD: Usage throttle backoff everywhere

## Problem

After the 2026-06-10 429 fix (commit e41d3e2), the auto-switch daemon correctly
backs off when the Anthropic oauth/usage endpoint throttles this machine. But the
machine has stayed throttled for 3+ hours because two request sources bypass the
backoff gate and keep the rate-limit window alive:

1. The menu bar app's refresh Timer (AppState.swift:213) shells out to
   `usage` and `codex sync-usage` on every refresh interval. These CLI paths were
   deliberately exempted as "manual commands", but when driven by a timer they are
   effectively automatic and hammer the throttled endpoint.
2. The daemon re-probes on a fixed 15-minute deadline; each probe eats a fresh 429
   and renews the throttle (9 consecutive 429s between 12:42 and 14:33).

Result: `throttledUntil` keeps extending, the daemon stays blind, auto-switch
never resumes.

## Requirements

1. **CLI usage paths respect the backoff deadline.** `usage` (Claude) and
   `codex sync-usage` actions check `throttledUntil` from
   `~/.oauth-switch/state.json` before making usage requests. While throttled:
   skip the network fetch, render from stored snapshots, print one clear line
   ("Usage API throttled, showing cached data, next attempt at <time>").
   A genuinely manual escape hatch stays available: `--force` flag bypasses the
   gate (document it; the app must NOT pass it).
2. **Exponential backoff in the daemon.** Consecutive 429s double the backoff:
   15 min -> 30 min -> 60 min cap. A successful usage fetch resets the streak.
   Persist the streak count in state.json alongside throttledUntil.
3. **App refresh interval sanity.** Check `refreshIntervalSeconds` default in the
   app (Settings). If below 15 min, raise the default to 15 min (existing user
   settings stay as chosen, but Settings UI should offer sane choices).
4. Whatever provider-specific throttle state exists for Claude must work the same
   for Codex if its endpoint ever 429s (the state schema already supports
   per-provider keys).

## Acceptance criteria

- While `throttledUntil` is in the future: `oas usage`, `cc-switch usage`, and
  `oas codex sync-usage` make zero usage-API requests (verified by injected fake
  fetch in tests) and still print cached account data.
- `--force` makes the request anyway and, on 429, records the new deadline.
- Daemon backoff doubles per consecutive 429 and caps at 60 min; success resets.
- App default refresh interval >= 15 min; Swift builds clean.
- `npm test` green (new tests for the gate, --force, exponential backoff);
  `node --check` clean; README documents the gate, --force, and backoff curve.
- No real user stores/state/log mutated by tests.

## Out of scope

- Kiro/Windsurf switch logging or throttling.
- Changing the 5-minute launchd StartInterval.
