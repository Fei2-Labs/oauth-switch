import Foundation

struct UsageSnapshot: Codable {
    struct Window: Codable {
        let utilization: Double?
        let resets_at: String?

        enum CodingKeys: String, CodingKey {
            case utilization
            case resets_at
        }
    }

    let five_hour: Window?
    let seven_day: Window?
    let fetchedAt: String?

    enum CodingKeys: String, CodingKey {
        case five_hour
        case seven_day
        case fetchedAt
    }
}

// NOTE: Claude Code account model
struct ClaudeAccount: Codable, Identifiable {
    let key: String
    let metadata: ClaudeMetadata?
    let capturedAt: String?
    let lastUsedAt: String?
    let usageSnapshot: UsageSnapshot?

    var id: String { key }

    var displayName: String {
        metadata?.emailAddress ?? key
    }

    var fiveHourUsed: Double {
        usageSnapshot?.five_hour?.utilization ?? 0
    }

    var sevenDayUsed: Double {
        usageSnapshot?.seven_day?.utilization ?? 0
    }
}

struct ClaudeMetadata: Codable {
    let emailAddress: String?
    let accountUuid: String?
    let organizationName: String?
    let planType: String?
}

struct ClaudeStore: Codable {
    let version: String?
    var accounts: [ClaudeAccount]
    let updatedAt: String?
}

// NOTE: Codex account model
struct CodexAccount: Codable, Identifiable {
    let key: String
    let auth: CodexAuth?
    let displayName: String?
    let capturedAt: String?
    let lastUsedAt: String?

    var id: String { key }

    var label: String {
        displayName ?? key
    }
}

struct CodexAuth: Codable {
    let OPENAI_API_KEY: String?
    let auth_mode: String?
    let tokens: CodexTokens?
}

struct CodexTokens: Codable {
    let access_token: String?
    let account_id: String?
}

struct CodexStore: Codable {
    let version: String?
    var accounts: [CodexAccount]
    let updatedAt: String?
}

enum Provider: String, CaseIterable {
    case claude = "Claude Code"
    case codex = "Codex"
}
