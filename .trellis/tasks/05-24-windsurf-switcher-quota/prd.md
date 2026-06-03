# windsurf switcher quota display

## Goal

Add Windsurf as a first-class provider in OAuth Switch and display the current Windsurf quota in the app and CLI using the local Windsurf state on this machine.

## What I already know

* The app already supports Claude Code, Codex, and Kiro in both the menu bar UI and the backing CLI.
* Windsurf local state exists on this machine under `~/Library/Application Support/Windsurf - Next/User/globalStorage/state.vscdb`.
* The Windsurf SQLite store contains `windsurf.settings.cachedPlanInfo`, which includes `planName`, `usage`, and `quotaUsage`.
* For quota plans, `quotaUsage.dailyRemainingPercent` and `quotaUsage.weeklyRemainingPercent` are available.
* For non-quota plans, `usage.remainingMessages`, `usage.remainingFlowActions`, and `usage.remainingFlexCredits` are available.
* There is no existing Windsurf provider code in the app or CLI yet.

## Assumptions

* Windsurf should be added as a read-only provider section first, with local quota display.
* The current Windsurf state is enough to show the active plan and remaining quota on this machine.
* If Windsurf multi-account switching is not backed by a stable local store, we should not fake a switch action.

## Requirements

* Add Windsurf support to the SwiftUI app state and menu bar.
* Read Windsurf plan/quota data from the local `state.vscdb` file.
* Display the current Windsurf plan and remaining quota in the menu bar.
* Add a CLI path for showing Windsurf quota from the same local source.
* Keep the existing Claude, Codex, and Kiro flows unchanged.

## Acceptance Criteria

* [ ] The menu bar shows a Windsurf section when local Windsurf state is present.
* [ ] The Windsurf section shows the plan name and remaining quota values.
* [ ] The app continues to show Claude, Codex, and Kiro data as before.
* [ ] The CLI can print Windsurf quota information from the local store.
* [ ] The project builds successfully after the change.

## Definition of Done

* Tests or build validation run for the touched layers.
* No regressions in the existing provider sections.
* The implementation uses the real local Windsurf quota source rather than a hardcoded placeholder.

## Out of Scope

* Fake multi-account Windsurf switching.
* Network calls to Windsurf services.
* Any change to Windsurf authentication flow.

## Technical Notes

* Swift app files: `app/OAuthSwitch/Models/Account.swift`, `app/OAuthSwitch/Models/AppState.swift`, `app/OAuthSwitch/Services/StoreService.swift`, `app/OAuthSwitch/Views/MenuBarView.swift`, `app/OAuthSwitch/Views/SettingsView.swift`
* CLI files: `bin/oauth-switch.cjs`, `bin/lib/actions/*.cjs`, `bin/lib/output/*.cjs`, and a new Windsurf provider/helper module.
* Local state source: `~/Library/Application Support/Windsurf - Next/User/globalStorage/state.vscdb`
* Relevant state key: `windsurf.settings.cachedPlanInfo`
