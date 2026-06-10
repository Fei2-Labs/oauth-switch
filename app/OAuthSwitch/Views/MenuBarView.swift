import SwiftUI

private enum MenuBarTheme {
    static let outerPadding: CGFloat = 12
    static let sectionSpacing: CGFloat = 10
    static let cardRadius: CGFloat = 14
    static let rowRadius: CGFloat = 10
    static let windowWidth: CGFloat = 372
    static let providerRowsMaxHeight: CGFloat = 420
}

struct MenuBarView: View {
    @EnvironmentObject var appState: AppState
    @AppStorage("selectedProviderTab") private var selectedProviderTabRawValue: String = ""

    var body: some View {
        VStack(alignment: .leading, spacing: MenuBarTheme.sectionSpacing) {
            headerSection
            providerTabBar
            selectedProviderContent
            footerSection
        }
        .frame(width: MenuBarTheme.windowWidth)
        .padding(MenuBarTheme.outerPadding)
        .background(
            LinearGradient(
                colors: [
                    Color(nsColor: .windowBackgroundColor),
                    Color.black.opacity(0.04),
                ],
                startPoint: .top,
                endPoint: .bottom
            )
        )
    }

    private var headerSection: some View {
        HStack(alignment: .top) {
            VStack(alignment: .leading, spacing: 2) {
                Text("OAuth Switch")
                    .font(.system(size: 19, weight: .semibold, design: .rounded))
                Text("Local account routing and quota visibility")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Spacer(minLength: 12)

            headerStatus
        }
    }

    @ViewBuilder
    private var headerStatus: some View {
        if appState.isInitialLoading {
            StatusPill(title: "Syncing", tone: .neutral)
        } else if let time = appState.lastCheckTime {
            VStack(alignment: .trailing, spacing: 2) {
                StatusPill(title: "Updated", tone: .success)
                Text(time, style: .relative)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private var selectedSection: ProviderSectionSnapshot? {
        let sections = appState.providerSections
        if let match = sections.first(where: { $0.id.rawValue == selectedProviderTabRawValue }) {
            return match
        }
        return sections.first
    }

    private var providerTabBar: some View {
        HStack(spacing: 4) {
            ForEach(appState.providerSections) { section in
                ProviderTabButton(
                    section: section,
                    isSelected: section.id == selectedSection?.id,
                    onSelect: {
                        selectedProviderTabRawValue = section.id.rawValue
                    }
                )
            }
        }
        .padding(4)
        .background(
            RoundedRectangle(cornerRadius: MenuBarTheme.cardRadius, style: .continuous)
                .fill(Color.white.opacity(0.05))
        )
        .overlay(
            RoundedRectangle(cornerRadius: MenuBarTheme.cardRadius, style: .continuous)
                .stroke(Color.white.opacity(0.06), lineWidth: 1)
        )
    }

    @ViewBuilder
    private var selectedProviderContent: some View {
        if let section = selectedSection {
            if section.isLoading {
                EmptySectionState(text: "Refreshing local state…")
            } else if section.rows.isEmpty {
                EmptySectionState(text: section.emptyMessage)
            } else {
                ScrollView(.vertical, showsIndicators: false) {
                    VStack(spacing: 6) {
                        ForEach(section.rows) { row in
                            ProviderRowView(row: row) { action in
                                appState.perform(action)
                            }
                        }
                    }
                }
                .frame(maxHeight: MenuBarTheme.providerRowsMaxHeight)
            }
        }
    }

    private var footerSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let msg = appState.lastSwitchMessage, !msg.isEmpty {
                Text(msg)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 2)
            }

            HStack(spacing: 8) {
                Button("Refresh All") {
                    appState.loadAll()
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.small)

                Spacer()

                Button("Settings") {
                    NotificationCenter.default.post(name: .openOAuthSwitchSettings, object: nil)
                }
                .buttonStyle(.bordered)
                .controlSize(.small)

                Button("Quit") {
                    NSApplication.shared.terminate(nil)
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
            }

            Text(AppVersion.display)
                .font(.caption2)
                .foregroundStyle(.tertiary)
                .padding(.horizontal, 2)
        }
        .padding(.top, 2)
    }
}

struct ProviderTabButton: View {
    let section: ProviderSectionSnapshot
    let isSelected: Bool
    let onSelect: () -> Void

    var body: some View {
        Button(action: onSelect) {
            HStack(spacing: 5) {
                ProviderIconView(
                    provider: section.id,
                    size: 14,
                    cornerRadius: 4,
                    tint: isSelected ? .white.opacity(0.95) : .white.opacity(0.65)
                )
                Text(section.title)
                    .font(.system(size: 11, weight: .semibold))
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
                    .foregroundStyle(isSelected ? Color.primary : Color.secondary)
                if !section.isLoading && !section.rows.isEmpty {
                    Text("\(section.rows.count)")
                        .font(.system(size: 9, weight: .semibold, design: .monospaced))
                        .foregroundStyle(isSelected ? Color.primary : Color.secondary)
                        .padding(.horizontal, 5)
                        .padding(.vertical, 2)
                        .background(
                            Capsule(style: .continuous)
                                .fill(Color.white.opacity(isSelected ? 0.16 : 0.08))
                        )
                }
            }
            .padding(.horizontal, 6)
            .padding(.vertical, 7)
            .frame(maxWidth: .infinity)
            .background(
                RoundedRectangle(cornerRadius: MenuBarTheme.rowRadius, style: .continuous)
                    .fill(isSelected ? Color.accentColor.opacity(0.22) : Color.clear)
            )
            .overlay(
                RoundedRectangle(cornerRadius: MenuBarTheme.rowRadius, style: .continuous)
                    .stroke(isSelected ? Color.accentColor.opacity(0.3) : Color.clear, lineWidth: 1)
            )
            .contentShape(RoundedRectangle(cornerRadius: MenuBarTheme.rowRadius, style: .continuous))
        }
        .buttonStyle(.plain)
    }
}

struct ProviderRowView: View {
    let row: ProviderRowSnapshot
    let onAction: (ProviderRowAction) -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            RoundedRectangle(cornerRadius: 999, style: .continuous)
                .fill(row.isActive ? Color.green : Color.white.opacity(0.14))
                .frame(width: 5)

            VStack(alignment: .leading, spacing: 6) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(row.title)
                        .font(.system(size: 13, weight: .semibold))
                        .lineLimit(1)
                        .opacity(row.isDisabled ? 0.5 : 1)

                    if !row.secondaryTexts.isEmpty {
                        Text(row.secondaryTexts.joined(separator: " · "))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                            .opacity(row.isDisabled ? 0.5 : 1)
                    }

                    Spacer(minLength: 8)

                    if let statusText = row.statusText {
                        Text(statusText)
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(row.statusColor)
                    }
                }

                if let detailText = row.detailText, !detailText.isEmpty {
                    Text(detailText)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }

                if !row.detailLines.isEmpty {
                    VStack(alignment: .leading, spacing: 2) {
                        ForEach(Array(row.detailLines.enumerated()), id: \.offset) { _, detailLine in
                            Text(detailLine)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }

                if !row.metrics.isEmpty || row.action != nil || row.secondaryAction != nil {
                    HStack(alignment: .center, spacing: 8) {
                        if !row.metrics.isEmpty {
                            HStack(spacing: 6) {
                                ForEach(row.metrics) { metric in
                                    MetricBadge(metric: metric)
                                }
                            }
                            .opacity(row.isDisabled ? 0.5 : 1)
                        }

                        Spacer(minLength: 8)

                        if let secondaryAction = row.secondaryAction {
                            Button(secondaryAction.title) {
                                onAction(secondaryAction)
                            }
                            .buttonStyle(.bordered)
                            .controlSize(.mini)
                        }

                        if let action = row.action {
                            Button(action.title) {
                                onAction(action)
                            }
                            .buttonStyle(.bordered)
                            .controlSize(.mini)
                        }
                    }
                }
            }
        }
        .padding(10)
        .background(
            RoundedRectangle(cornerRadius: MenuBarTheme.rowRadius, style: .continuous)
                .fill(row.isActive ? Color.accentColor.opacity(0.12) : Color.white.opacity(0.025))
        )
        .overlay(
            RoundedRectangle(cornerRadius: MenuBarTheme.rowRadius, style: .continuous)
                .stroke(row.isActive ? Color.accentColor.opacity(0.18) : Color.white.opacity(0.04), lineWidth: 1)
        )
    }
}

private extension ProviderRowSnapshot {
    var statusColor: Color {
        switch statusColorName {
        case "red":
            return .red
        default:
            return .secondary
        }
    }
}

struct MetricBadge: View {
    let metric: ProviderMetric

    var color: Color {
        switch metric.style {
        case .utilization:
            if metric.value >= 90 { return .red }
            if metric.value >= 80 { return .orange }
            if metric.value >= 60 { return Color(nsColor: .systemYellow) }
            return .green
        case .remaining:
            if metric.value <= 10 { return .red }
            if metric.value <= 50 { return .orange }
            return .green
        }
    }

    var body: some View {
        HStack(spacing: 4) {
            Text(metric.label.uppercased())
                .font(.system(size: 9, weight: .semibold, design: .rounded))
                .foregroundStyle(.secondary)
            Text("\(Int(min(100, max(0, metric.value)).rounded()))%")
                .font(.system(size: 10, weight: .semibold, design: .monospaced))
                .foregroundStyle(color)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(
            Capsule(style: .continuous)
                .fill(color.opacity(0.12))
        )
    }
}

struct StatusPill: View {
    enum Tone {
        case neutral
        case success
    }

    let title: String
    let tone: Tone

    var foreground: Color {
        switch tone {
        case .neutral:
            return .secondary
        case .success:
            return .green
        }
    }

    var background: Color {
        switch tone {
        case .neutral:
            return Color.white.opacity(0.06)
        case .success:
            return Color.green.opacity(0.12)
        }
    }

    var body: some View {
        Text(title)
            .font(.system(size: 11, weight: .semibold))
            .foregroundStyle(foreground)
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(Capsule(style: .continuous).fill(background))
    }
}

struct EmptySectionState: View {
    let text: String

    var body: some View {
        Text(text)
            .font(.caption)
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.vertical, 8)
            .padding(.horizontal, 10)
            .background(
                RoundedRectangle(cornerRadius: MenuBarTheme.rowRadius, style: .continuous)
                    .fill(Color.white.opacity(0.025))
            )
    }
}
