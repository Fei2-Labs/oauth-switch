import SwiftUI

struct SettingsView: View {
    @EnvironmentObject var appState: AppState

    var body: some View {
        Form {
            Section("Refresh") {
                Picker("Background refresh", selection: $appState.refreshIntervalSeconds) {
                    Text("60 seconds").tag(60)
                    Text("120 seconds").tag(120)
                    Text("300 seconds").tag(300)
                    Text("15 minutes").tag(900)
                    Text("30 minutes").tag(1800)
                    Text("60 minutes").tag(3600)
                }

                LabeledContent("Current interval") {
                    Text(appState.refreshIntervalLabel)
                        .foregroundStyle(.secondary)
                }
            }

            Section("Automation") {
                Toggle("Sync Claude usage on refresh", isOn: $appState.autoSyncClaudeUsage)
                Toggle("Sync Codex usage on refresh", isOn: $appState.autoSyncCodexUsage)
                Toggle("Sync Kiro accounts from local SSO cache", isOn: $appState.autoSyncKiroAccounts)
                Toggle("Auto-refresh expired Kiro accounts", isOn: $appState.autoRefreshExpiredKiro)
            }

            Section("Codex Accounts") {
                Button("Add Codex Account") {
                    appState.addManagedCodexAccount()
                }

                Text("Opens a separate Codex login in Terminal and stores it under ~/.OAuthSwitch/codex-homes.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Section("Display") {
                Toggle("Show reset times", isOn: $appState.showResetTimes)
                Toggle("Show inactive accounts", isOn: $appState.showInactiveAccounts)
                Picker("Menu bar balance", selection: $appState.menuBarBalanceSourceRawValue) {
                    ForEach(MenuBarBalanceSource.allCases) { source in
                        Text(source.title).tag(source.rawValue)
                    }
                }
            }

            Section("Claude Warning Thresholds") {
                HStack {
                    Text("5h warning threshold")
                    Spacer()
                    TextField("", value: $appState.trigger5h, format: .number)
                        .frame(width: 56)
                        .multilineTextAlignment(.trailing)
                    Text("%")
                        .foregroundStyle(.secondary)
                }

                HStack {
                    Text("7d warning threshold")
                    Spacer()
                    TextField("", value: $appState.trigger7d, format: .number)
                        .frame(width: 56)
                        .multilineTextAlignment(.trailing)
                    Text("%")
                        .foregroundStyle(.secondary)
                }
            }

            Section("Diagnostics") {
                LabeledContent("Claude accounts") {
                    Text("\(appState.claudeAccounts.count)")
                }
                LabeledContent("Codex accounts") {
                    Text("\(appState.codexAccounts.count)")
                }
                LabeledContent("Kiro accounts") {
                    Text("\(appState.kiroAccounts.count)")
                }
                LabeledContent("Windsurf profiles") {
                    Text("\(appState.windsurfAccounts.count)")
                }
                LabeledContent("Windsurf plan") {
                    Text(appState.windsurfAccounts.first?.planLabel ?? "Unknown")
                        .lineLimit(1)
                }
                LabeledContent("CLI path") {
                    Text("~/Dropbox/My Apps/oauth-switch/bin/oauth-switch.cjs")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
        }
        .formStyle(.grouped)
        .frame(width: 460, height: 540)
    }
}
