# Changelog

All notable changes to this project are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/), versions follow
[SemVer](https://semver.org/).

## [1.4.0] - 2026-06-28

### Added
- Non-active Claude account usage via the claude.ai browser-cookie web API
  (macOS app, advanced/opt-in). Reads usage with a captured `sessionKey` instead
  of refreshing an account's rotating OAuth token, so displaying a non-active
  account's balance never triggers a re-login. Includes a "Capture current
  browser Claude session" action and a per-account cookie cache at
  `~/.oauth-switch/cookies.json` (0600). Firefox/Zen supported; the web call runs
  through macOS URLSession (Cloudflare blocks plain HTTP clients).
- `oas update` self-updater and an npm version-check notice.

### Fixed
- Stop the repeated "Re-login" loop: all Claude store mutations are serialized
  with a cross-process file lock, and switch pre-flight re-reads the store and
  retries once on `invalid_grant` before blocking. This removes the
  rotating-refresh-token race between `oas` processes (and Claude Code) that
  forced manual re-logins.
- Non-active account balances no longer go stale while the active account has
  headroom: non-current usage now refreshes on a round-robin every cycle instead
  of only when the active account nears its limit. Request volume is unchanged
  (~1 non-current request / 15 min, regardless of account count).
- A Claude account with a dead credential (re-auth required) no longer shows a
  fabricated `0%` balance; the row shows the re-login state with no misleading
  number.
- Cookie failures (expired/invalid session) surface a distinct "Cookie expired —
  re-import" state and never mark the OAuth credential as needing re-login.

### Changed
- Non-current usage polling cadence and back-off consolidated (per-provider
  throttle state, `Retry-After` honored, capped warming).

## [1.0.0] - 2026-05-21

### Added
- Multi-account switcher for Claude Code, Codex, and Kiro with auto-switch on
  rate limits; macOS menu-bar app.

[1.4.0]: https://github.com/Fei2-Labs/oauth-switch/compare/v1.0.0...v1.4.0
[1.0.0]: https://github.com/Fei2-Labs/oauth-switch/releases/tag/v1.0.0
