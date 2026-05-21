import SwiftUI

@main
struct OAuthSwitchApp: App {
    @StateObject private var appState = AppState()

    var body: some Scene {
        MenuBarExtra {
            MenuBarView()
                .environmentObject(appState)
        } label: {
            Label {
                Text("OAuth Switch")
            } icon: {
                Image(systemName: appState.menuBarIcon)
            }
        }
        .menuBarExtraStyle(.window)

        Settings {
            SettingsView()
                .environmentObject(appState)
        }
    }
}
