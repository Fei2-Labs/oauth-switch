import Foundation

enum ProviderID: String, CaseIterable, Identifiable {
    case claude
    case codex
    case kiro
    case windsurf

    var id: String { rawValue }

    var title: String {
        switch self {
        case .claude:
            return "Claude Code"
        case .codex:
            return "Codex"
        case .kiro:
            return "Kiro"
        case .windsurf:
            return "Windsurf"
        }
    }

    var templateAssetName: String {
        switch self {
        case .claude:
            return "claudeTemplate"
        case .codex:
            return "codexTemplate"
        case .kiro:
            return "kiroTemplate"
        case .windsurf:
            return "windsurfTemplate"
        }
    }

    var menuBarIconScale: CGFloat {
        switch self {
        case .claude:
            return 1.12
        case .codex:
            return 1
        case .kiro:
            return 1
        case .windsurf:
            return 1
        }
    }
}

enum MenuBarBalanceSource: String, CaseIterable, Identifiable {
    case off
    case claude
    case codex
    case windsurf

    var id: String { rawValue }

    var title: String {
        switch self {
        case .off:
            return "Off"
        case .claude:
            return "Claude Code"
        case .codex:
            return "Codex"
        case .windsurf:
            return "Windsurf"
        }
    }

    var providerID: ProviderID? {
        switch self {
        case .off:
            return nil
        case .claude:
            return .claude
        case .codex:
            return .codex
        case .windsurf:
            return .windsurf
        }
    }
}

enum ProviderMetricStyle {
    case utilization
    case remaining
}

enum ProviderRowAction {
    case switchClaude(key: String)
    case switchCodex(key: String)
    case switchKiro(index: Int)
    case toggleDisabled(provider: ProviderID, key: String, disabled: Bool)
    case refresh

    var title: String {
        switch self {
        case .refresh:
            return "Refresh"
        case let .toggleDisabled(_, _, disabled):
            return disabled ? "Disable" : "Enable"
        default:
            return "Switch"
        }
    }
}

struct ProviderMetric: Identifiable {
    let id: String
    let label: String
    let value: Double
    let style: ProviderMetricStyle
}

struct ProviderRowSnapshot: Identifiable {
    let id: String
    let title: String
    let secondaryTexts: [String]
    let detailText: String?
    let detailLines: [String]
    let statusText: String?
    let statusColorName: String?
    let metrics: [ProviderMetric]
    let isActive: Bool
    let isDisabled: Bool
    let action: ProviderRowAction?
    let secondaryAction: ProviderRowAction?

    init(
        id: String,
        title: String,
        secondaryTexts: [String],
        detailText: String?,
        detailLines: [String],
        statusText: String?,
        statusColorName: String?,
        metrics: [ProviderMetric],
        isActive: Bool,
        isDisabled: Bool = false,
        action: ProviderRowAction?,
        secondaryAction: ProviderRowAction? = nil
    ) {
        self.id = id
        self.title = title
        self.secondaryTexts = secondaryTexts
        self.detailText = detailText
        self.detailLines = detailLines
        self.statusText = statusText
        self.statusColorName = statusColorName
        self.metrics = metrics
        self.isActive = isActive
        self.isDisabled = isDisabled
        self.action = action
        self.secondaryAction = secondaryAction
    }
}

struct ProviderSectionSnapshot: Identifiable {
    let id: ProviderID
    let rows: [ProviderRowSnapshot]
    let emptyMessage: String
    let isLoading: Bool

    var title: String { id.title }
}
