# Quality Guidelines

> Code quality standards for backend development.

---

## Overview

<!--
Document your project's quality standards here.

Questions to answer:
- What patterns are forbidden?
- What linting rules do you enforce?
- What are your testing requirements?
- What code review standards apply?
-->

(To be filled by the team)

---

## Forbidden Patterns

<!-- Patterns that should never be used and why -->

(To be filled by the team)

---

## Required Patterns

<!-- Patterns that must always be used -->

(To be filled by the team)

---

## Testing Requirements

<!-- What level of testing is expected -->

### External API contracts: unit tests are necessary but NOT sufficient

Unit tests in this project mock the network (inject fake `https` / fetch
functions) so they never touch real endpoints, credentials, or the Keychain.
That is the correct safety boundary — but it means a wrong URL host, a wrong
request path, a wrong `client_id`, or a mis-named response field (e.g. reading
`expiresAt` when the API returns `expires_in`) will pass every test and ship
broken.

Rule: any code that talks to an external HTTP API (usage fetch, OAuth token
refresh, provider usage endpoints) MUST be smoke-tested against the REAL
endpoint at least once before the feature is considered done — a single
throwaway `node -e` request confirming status 200 and the actual response
field names. Record the verified endpoint + field shape in the commit or the
code comment. Do not copy an endpoint URL or auth client_id from memory and
assume it is correct.

Concrete failure this prevents: the OAuth refresh endpoint was hardcoded as
`console.anthropic.com/v1/oauth/token` from memory (correct host is
`api.anthropic.com`). Every injected-fake test passed; the bug only surfaced
days later in production when a real token needed refreshing and the endpoint
returned 404. Fixed in commit 93e45aa.

When the smoke test would consume a one-time/rotating credential (OAuth
refresh tokens rotate on use), note that calling it invalidates the stored
token — do it deliberately and let the daemon re-sync, or use a throwaway
account.

---

## Code Review Checklist

<!-- What reviewers should check -->

(To be filled by the team)
