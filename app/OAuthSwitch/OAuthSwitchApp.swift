import SwiftUI
import AppKit

extension Notification.Name {
    static let openOAuthSwitchSettings = Notification.Name("openOAuthSwitchSettings")
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var settingsWindowController: NSWindowController?
    private weak var appState: AppState?

    func configure(appState: AppState) {
        self.appState = appState
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleOpenSettings),
            name: .openOAuthSwitchSettings,
            object: nil
        )
    }

    @objc
    func handleOpenSettings() {
        showSettingsWindow()
    }

    func showSettingsWindow() {
        guard let appState else { return }

        if settingsWindowController == nil {
            let contentView = AnyView(
                SettingsView()
                    .environmentObject(appState)
            )

            let hostingController = NSHostingController(rootView: contentView)
            let window = NSWindow(contentViewController: hostingController)
            window.title = "OAuth Switch Settings"
            window.styleMask = [.titled, .closable, .miniaturizable]
            window.setContentSize(NSSize(width: 420, height: 330))
            window.isReleasedWhenClosed = false
            window.center()

            settingsWindowController = NSWindowController(window: window)
        } else if let hostingController = settingsWindowController?.contentViewController as? NSHostingController<AnyView> {
            hostingController.rootView = AnyView(
                SettingsView()
                    .environmentObject(appState)
            )
        }

        NSApp.activate(ignoringOtherApps: true)
        settingsWindowController?.showWindow(nil)
        settingsWindowController?.window?.makeKeyAndOrderFront(nil)
    }
}

@main
struct OAuthSwitchApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var appState = AppState()

    var body: some Scene {
        MenuBarExtra {
            MenuBarView()
                .environmentObject(appState)
                .onAppear {
                    appDelegate.configure(appState: appState)
                }
        } label: {
            HStack(spacing: 8) {
                if let provider = appState.menuBarProviderIcon {
                    ProviderIconView(
                        provider: provider,
                        size: 18,
                        cornerRadius: 3,
                        scale: provider.menuBarIconScale
                    )
                } else {
                    Image(systemName: appState.menuBarIcon)
                }
                Text(appState.menuBarTitle)
                    .font(.system(size: 12, weight: .semibold, design: .rounded))
            }
        }
        .menuBarExtraStyle(.window)
    }
}
