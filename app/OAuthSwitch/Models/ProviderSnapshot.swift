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
    case switchCodex(index: Int)
    case switchKiro(index: Int)
    case refresh

    var title: String {
        switch self {
        case .refresh:
            return "Refresh"
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
    let action: ProviderRowAction?
}

struct ProviderSectionSnapshot: Identifiable {
    let id: ProviderID
    let rows: [ProviderRowSnapshot]
    let emptyMessage: String
    let isLoading: Bool

    var title: String { id.title }
}
