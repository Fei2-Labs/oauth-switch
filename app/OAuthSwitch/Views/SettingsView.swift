import SwiftUI

struct SettingsView: View {
    @EnvironmentObject var appState: AppState

    var body: some View {
        Form {
            Section("Auto-Switch") {
                Toggle("Enable auto-switch", isOn: $appState.autoSwitchEnabled)

                HStack {
                    Text("5h trigger threshold")
                    Spacer()
                    TextField("", value: $appState.trigger5h, format: .number)
                        .frame(width: 50)
                    Text("%")
                }

                HStack {
                    Text("7d trigger threshold")
                    Spacer()
                    TextField("", value: $appState.trigger7d, format: .number)
                        .frame(width: 50)
                    Text("%")
                }
            }

            Section("Info") {
                LabeledContent("Claude accounts") {
                    Text("\(appState.claudeAccounts.count)")
                }
                LabeledContent("Codex accounts") {
                    Text("\(appState.codexAccounts.count)")
                }
                LabeledContent("CLI path") {
                    Text("~/Dropbox/My Apps/oauth-switch/bin/oauth-switch.cjs")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .formStyle(.grouped)
        .frame(width: 400, height: 250)
    }
}
