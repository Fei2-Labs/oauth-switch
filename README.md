<p align="center">
  <img src="app/OAuthSwitch/Resources/Assets.xcassets/AppIcon.appiconset/icon_256x256.png" width="128" alt="OAuth Switch icon" />
</p>

<h1 align="center">OAuth Switch</h1>

<p align="center">
  <strong>Multi-account switcher for Claude Code & Codex CLI</strong><br/>
  Auto-switch when you hit rate limits. Never waste time waiting again.
</p>

<p align="center">
  <a href="https://github.com/Fei2-Labs/oauth-switch/releases"><img src="https://img.shields.io/github/v/release/Fei2-Labs/oauth-switch?style=flat-square" alt="Release" /></a>
  <a href="https://github.com/Fei2-Labs/oauth-switch/blob/main/LICENSE"><img src="https://img.shields.io/github/license/Fei2-Labs/oauth-switch?style=flat-square" alt="License" /></a>
  <img src="https://img.shields.io/badge/platform-macOS-blue?style=flat-square" alt="macOS" />
</p>

---

## What it does

Pool multiple OAuth accounts for **Claude Code** and **OpenAI Codex**, switch between them instantly, and let the tool auto-rotate when usage limits approach.

| Feature | Description |
|---------|-------------|
| 🔄 **Instant switch** | One command to swap the active account — by index or alias |
| 📊 **Usage monitoring** | See 5-hour and 7-day utilization per account |
| ⚡ **Auto-switch** | Background daemon rotates to the best account before you hit limits |
| 🖥️ **Menu bar app** | Native macOS app — see status, switch accounts, adjust thresholds |
| 🔔 **Notifications** | macOS alerts when a switch happens |
| 🔑 **Multi-provider** | Claude Code, Codex, and Kiro IDE — all in one tool |
| 🏢 **Enterprise SSO** | Supports Builder ID, Google/GitHub social, and IAM Identity Center |

---

## Quick start

```bash
# Clone
git clone https://github.com/Fei2-Labs/oauth-switch.git
cd oauth-switch

# Create the CLI wrapper
mkdir -p ~/.local/bin
cat > ~/.local/bin/oas << 'EOF'
#!/usr/bin/env bash
set -euo pipefail
node "$(dirname "$(realpath "$0")")/../oauth-switch/bin/oauth-switch.cjs" --usage-command "oas" "$@"
EOF
chmod +x ~/.local/bin/oas
```

Make sure `~/.local/bin` is in your `PATH`.

---

## Usage

```bash
# List Claude Code accounts with usage
oas

# Switch to account by index or alias
oas 2
oas work

# Set alias for Claude Code account
oas alias 0 work

# List Kiro accounts
oas kiro

# Switch Kiro account by index or alias
oas kiro 1
oas kiro work

# Set alias for Kiro account
oas kiro alias 0 personal

# List Codex accounts
oas codex

# Switch Codex account by index or alias
oas codex 1
oas codex personal

# Set alias for Codex account
oas codex alias 0 personal

# Run auto-switch check manually
oas auto

# Sync current account into store
oas sync
```

Accounts are captured automatically — just log in with different accounts and run `oas` (or `oas kiro` / `oas codex`) each time. Use `oas alias`, `oas kiro alias`, or `oas codex alias` to give accounts memorable names.

---

## Auto-switch

The auto-switch daemon checks usage every 5 minutes and switches to the account with the most remaining quota when thresholds are exceeded.

| Condition | Trigger | Target requirement |
|-----------|---------|-------------------|
| 5h utilization | ≥ 80% | < 60% |
| 7d utilization | ≥ 90% | < 80% |

If all accounts are exhausted, it notifies without switching — unless the current account is fully rate-limited (429), in which case it picks the least-bad option.

### Install the daemon

```bash
cp com.oauth-switch.auto.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.oauth-switch.auto.plist
```

### Manage

```bash
# Stop
launchctl unload ~/Library/LaunchAgents/com.oauth-switch.auto.plist

# View logs
cat /tmp/oauth-switch-auto.log
```

---

## Menu bar app

A native SwiftUI menu bar app for visual monitoring and one-click switching.

```bash
cd app
make install
open /Applications/OAuthSwitch.app
```

Features:
- Live usage display for all accounts (Claude + Codex)
- One-click account switching
- Manual "Check Now" trigger
- Threshold configuration in Settings

---

## How it works

```
# Claude Code
~/.claude.json              ← Claude Code reads config from here
~/.claude/.credentials.json ← OAuth tokens live here

# Codex
~/.codex/auth.json          ← Codex OAuth tokens

# Kiro
~/.aws/sso/cache/kiro-auth-token.json  ← Kiro IDE reads tokens from here

# Stores
~/.ClaudeCodeMultiAccounts.json  ← oauth-switch store (Claude)
~/.CodexMultiAccounts.json       ← oauth-switch store (Codex)
~/.KiroMultiAccounts.json        ← oauth-switch store (Kiro)
```

`oauth-switch` snapshots each account's credentials when you use it. Switching replaces the live config files with the stored snapshot and refreshes the token. Restart the CLI/IDE for changes to take effect.

### Kiro account types

| Type | How to capture |
|------|---------------|
| Builder ID | Log in via Kiro IDE, run `oas kiro` |
| Google/GitHub | Log in via Kiro IDE, run `oas kiro` |
| Enterprise SSO | Log in via Kiro IDE, run `oas kiro` |

Token refresh is handled automatically on switch (OIDC for Builder ID/Enterprise, social endpoint for Google/GitHub).

---

## Project structure

```
oauth-switch/
├── bin/
│   ├── oauth-switch.cjs          # Main CLI entry
│   └── lib/
│       ├── actions/              # list, switch, sync, auto-switch
│       ├── providers/codex.cjs   # Codex provider
│       ├── store/                # IO, account management
│       ├── output/               # Formatting, messages
│       └── usage/                # Fetch, cache, format usage data
├── app/                          # macOS menu bar app (SwiftUI)
├── hooks/                        # Claude Code session hooks
└── com.oauth-switch.auto.plist   # launchd agent config
```

---

## Requirements

- macOS 13+
- Node.js 20+
- Claude Code and/or Codex CLI with OAuth login
- Swift 5.9+ (for building the menu bar app)

---

## License

MIT

---

## Star History

<p align="center">
  <a href="https://star-history.com/#Fei2-Labs/oauth-switch&Date">
    <img src="https://api.star-history.com/svg?repos=Fei2-Labs/oauth-switch&type=Date" alt="Star History Chart" width="600" />
  </a>
</p>
