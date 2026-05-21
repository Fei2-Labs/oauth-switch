import SwiftUI

struct MenuBarView: View {
    @EnvironmentObject var appState: AppState

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            headerSection
            Divider()
            claudeSection
            Divider()
            codexSection
            Divider()
            footerSection
        }
        .frame(width: 320)
        .padding(.vertical, 8)
    }

    private var headerSection: some View {
        HStack {
            Text("OAuth Switch")
                .font(.headline)
            Spacer()
            if let time = appState.lastCheckTime {
                Text(time, style: .relative)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.horizontal, 12)
        .padding(.bottom, 8)
    }

    private var claudeSection: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Claude Code")
                .font(.subheadline.bold())
                .padding(.horizontal, 12)
                .padding(.top, 8)

            ForEach(Array(appState.claudeAccounts.enumerated()), id: \.element.id) { index, account in
                AccountRow(
                    name: account.displayName,
                    plan: account.metadata?.planType,
                    fiveHour: account.fiveHourUsed,
                    sevenDay: account.sevenDayUsed,
                    isActive: account.key == appState.activeClaudeKey,
                    onSwitch: { appState.switchClaude(to: account) }
                )
            }
        }
        .padding(.bottom, 8)
    }

    private var codexSection: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Codex")
                .font(.subheadline.bold())
                .padding(.horizontal, 12)
                .padding(.top, 8)

            if appState.codexAccounts.isEmpty {
                Text("No accounts")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 12)
            } else {
                ForEach(Array(appState.codexAccounts.enumerated()), id: \.element.id) { index, account in
                    CodexRow(
                        name: account.label,
                        isActive: account.key == appState.activeCodexKey,
                        onSwitch: { appState.switchCodex(to: index) }
                    )
                }
            }
        }
        .padding(.bottom, 8)
    }

    private var footerSection: some View {
        VStack(spacing: 4) {
            Button("Check Now") {
                appState.runAutoCheck()
            }
            .padding(.horizontal, 12)
            .padding(.top, 8)

            if let msg = appState.lastSwitchMessage, !msg.isEmpty {
                Text(msg)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 12)
                    .lineLimit(2)
            }

            HStack {
                Button("Settings...") {
                    NSApp.sendAction(Selector(("showSettingsWindow:")), to: nil, from: nil)
                }
                Spacer()
                Button("Quit") {
                    NSApplication.shared.terminate(nil)
                }
            }
            .padding(.horizontal, 12)
            .padding(.top, 4)
            .padding(.bottom, 4)
        }
    }
}

struct AccountRow: View {
    let name: String
    let plan: String?
    let fiveHour: Double
    let sevenDay: Double
    let isActive: Bool
    let onSwitch: () -> Void

    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 4) {
                    if isActive {
                        Circle()
                            .fill(.green)
                            .frame(width: 6, height: 6)
                    }
                    Text(name)
                        .font(.caption)
                        .lineLimit(1)
                    if let plan = plan {
                        Text(plan)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }
                HStack(spacing: 8) {
                    UsageBadge(label: "5h", value: fiveHour)
                    UsageBadge(label: "7d", value: sevenDay)
                }
            }
            Spacer()
            if !isActive {
                Button("Switch") { onSwitch() }
                    .controlSize(.small)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 4)
        .background(isActive ? Color.accentColor.opacity(0.08) : Color.clear)
        .cornerRadius(4)
    }
}

struct CodexRow: View {
    let name: String
    let isActive: Bool
    let onSwitch: () -> Void

    var body: some View {
        HStack {
            HStack(spacing: 4) {
                if isActive {
                    Circle()
                        .fill(.green)
                        .frame(width: 6, height: 6)
                }
                Text(name)
                    .font(.caption)
                    .lineLimit(1)
            }
            Spacer()
            if !isActive {
                Button("Switch") { onSwitch() }
                    .controlSize(.small)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 4)
        .background(isActive ? Color.accentColor.opacity(0.08) : Color.clear)
        .cornerRadius(4)
    }
}

struct UsageBadge: View {
    let label: String
    let value: Double

    var color: Color {
        if value >= 90 { return .red }
        if value >= 80 { return .orange }
        if value >= 60 { return .yellow }
        return .green
    }

    var body: some View {
        HStack(spacing: 2) {
            Text(label)
                .font(.system(size: 9))
                .foregroundStyle(.secondary)
            Text("\(Int(value))%")
                .font(.system(size: 9, weight: .medium, design: .monospaced))
                .foregroundStyle(color)
        }
    }
}
