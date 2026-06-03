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
    let credentials: ClaudeCredentials?
    let capturedAt: String?
    let lastUsedAt: String?
    let usageSnapshot: UsageSnapshot?

    var id: String { key }

    var credentialFingerprint: String? {
        credentials?.claudeAiOauth?.fingerprint
    }

    var displayName: String {
        metadata?.emailAddress ?? key
    }

    var fiveHourUsed: Double {
        usageSnapshot?.five_hour?.utilization ?? 0
    }

    var sevenDayUsed: Double {
        usageSnapshot?.seven_day?.utilization ?? 0
    }

    var resetSummary: String? {
        usageSnapshot?.resetSummary
    }

    var lowestRemainingPercent: Double? {
        let values = [fiveHourRemainingPercent, sevenDayRemainingPercent].compactMap { $0 }
        return values.min()
    }

    private var fiveHourRemainingPercent: Double? {
        remainingPercent(fromUsed: usageSnapshot?.five_hour?.utilization)
    }

    private var sevenDayRemainingPercent: Double? {
        remainingPercent(fromUsed: usageSnapshot?.seven_day?.utilization)
    }
}

struct ClaudeMetadata: Codable {
    let emailAddress: String?
    let accountUuid: String?
    let organizationName: String?
    let planType: String?
}

struct ClaudeCredentials: Codable {
    let claudeAiOauth: ClaudeOAuthCredentials?
}

struct ClaudeOAuthCredentials: Codable {
    let accessToken: String?
    let refreshToken: String?

    var fingerprint: String? {
        let normalizedAccessToken = accessToken?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let normalizedRefreshToken = refreshToken?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !normalizedAccessToken.isEmpty || !normalizedRefreshToken.isEmpty else {
            return nil
        }
        guard let data = try? JSONEncoder().encode([normalizedAccessToken, normalizedRefreshToken]),
              let fingerprint = String(data: data, encoding: .utf8) else {
            return nil
        }
        return fingerprint
    }
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
    let usageSnapshot: UsageSnapshot?

    var id: String { key }

    var label: String {
        displayName ?? key
    }

    var fiveHourUsed: Double? {
        usageSnapshot?.five_hour?.utilization
    }

    var sevenDayUsed: Double? {
        usageSnapshot?.seven_day?.utilization
    }

    var resetSummary: String? {
        usageSnapshot?.resetSummary
    }

    var lowestRemainingPercent: Double? {
        let values = [
            remainingPercent(fromUsed: fiveHourUsed),
            remainingPercent(fromUsed: sevenDayUsed),
        ].compactMap { $0 }
        return values.min()
    }
}

private extension UsageSnapshot {
    var resetSummary: String? {
        var parts: [String] = []
        if let fiveHourReset = formattedReset(five_hour?.resets_at, label: "5h") {
            parts.append(fiveHourReset)
        }
        if let sevenDayReset = formattedReset(seven_day?.resets_at, label: "7d") {
            parts.append(sevenDayReset)
        }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    func formattedReset(_ isoString: String?, label: String) -> String? {
        guard let isoString else { return nil }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let fallbackFormatter = ISO8601DateFormatter()
        fallbackFormatter.formatOptions = [.withInternetDateTime]
        guard let date = formatter.date(from: isoString) ?? fallbackFormatter.date(from: isoString) else {
            return nil
        }
        return "\(label) resets \(formatMenuDateTime(date))"
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

// NOTE: Kiro account model
struct KiroAccount: Codable, Identifiable {
    let key: String
    let displayName: String?
    let capturedAt: String?
    let lastUsedAt: String?
    let auth: KiroAuth?

    var id: String { key }

    var label: String {
        displayName ?? key
    }

    var isExpired: Bool {
        guard let exp = auth?.expiresAt else { return false }
        let fmt = ISO8601DateFormatter()
        fmt.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let date = fmt.date(from: exp) else { return false }
        return date < Date()
    }
}

struct KiroAuth: Codable {
    let expiresAt: String?
    let authMethod: String?
    let provider: String?
}

struct KiroStore: Codable {
    let version: String?
    var accounts: [KiroAccount]
    let updatedAt: String?
    let activeKey: String?
}

struct WindsurfUsage: Codable {
    let duration: Int?
    let messages: Int?
    let flowActions: Int?
    let flexCredits: Int?
    let usedMessages: Int?
    let usedFlowActions: Int?
    let usedFlexCredits: Int?
    let remainingMessages: Int?
    let remainingFlowActions: Int?
    let remainingFlexCredits: Int?
}

struct WindsurfQuotaUsage: Codable {
    let dailyRemainingPercent: Double?
    let weeklyRemainingPercent: Double?
    let overageBalanceMicros: Int64?
    let dailyResetAtUnix: Int64?
    let weeklyResetAtUnix: Int64?
}

struct WindsurfPlanInfo: Codable {
    let planName: String?
    let startTimestamp: Double?
    let endTimestamp: Double?
    let usage: WindsurfUsage?
    let hasBillingWritePermissions: Bool?
    let gracePeriodStatus: Int?
    let billingStrategy: String?
    let quotaUsage: WindsurfQuotaUsage?
    let teamsTier: Int?
    let hideDailyQuota: Bool?
    let hideWeeklyQuota: Bool?
}

struct WindsurfAccount: Codable, Identifiable {
    let key: String
    let planInfo: WindsurfPlanInfo?
    let capturedAt: String?
    let sourcePath: String?

    var id: String { key }

    var displayName: String {
        "Windsurf"
    }

    var planLabel: String {
        planInfo?.planName ?? "Unknown"
    }

    var billingLabel: String? {
        planInfo?.billingStrategy?.capitalized
    }

    var quotaSummary: String {
        if planInfo?.quotaUsage != nil {
            var parts: [String] = []
            if planInfo?.hideDailyQuota != true, let daily = WindsurfAccount.formatPercent(dailyUsagePercent) {
                parts.append("Daily usage \(daily)")
            }
            if planInfo?.hideWeeklyQuota != true, let weekly = WindsurfAccount.formatPercent(weeklyUsagePercent) {
                parts.append("Weekly usage \(weekly)")
            }
            if !parts.isEmpty {
                return parts.joined(separator: " · ")
            }
        }

        if let usage = planInfo?.usage {
            let messages = WindsurfAccount.formatRemainingCount(
                remaining: usage.remainingMessages,
                total: usage.messages
            )
            let flow = WindsurfAccount.formatRemainingCount(
                remaining: usage.remainingFlowActions,
                total: usage.flowActions
            )
            return "Messages \(messages) · Flow \(flow)"
        }

        return "No quota data"
    }

    var resetSummary: String? {
        guard let quota = planInfo?.quotaUsage else { return nil }
        var parts: [String] = []

        if planInfo?.hideDailyQuota != true,
           let formatted = WindsurfAccount.formatUnixReset(quota.dailyResetAtUnix, label: "Daily") {
            parts.append(formatted)
        }

        if planInfo?.hideWeeklyQuota != true,
           let formatted = WindsurfAccount.formatUnixReset(quota.weeklyResetAtUnix, label: "Weekly") {
            parts.append(formatted)
        }

        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    var detailSummary: String {
        [quotaSummary, resetSummary].compactMap { $0 }.joined(separator: "\n")
    }

    var dailyUsagePercent: Double? {
        if let quota = planInfo?.quotaUsage {
            guard planInfo?.hideDailyQuota != true else { return nil }
            return WindsurfAccount.usagePercent(fromRemaining: quota.dailyRemainingPercent)
        }
        return WindsurfAccount.usedPercent(
            used: planInfo?.usage?.usedMessages,
            total: planInfo?.usage?.messages
        )
    }

    var weeklyUsagePercent: Double? {
        if let quota = planInfo?.quotaUsage {
            guard planInfo?.hideWeeklyQuota != true else { return nil }
            return WindsurfAccount.usagePercent(fromRemaining: quota.weeklyRemainingPercent)
        }
        return WindsurfAccount.usedPercent(
            used: planInfo?.usage?.usedFlowActions,
            total: planInfo?.usage?.flowActions
        )
    }

    var lowestRemainingPercent: Double? {
        let values = [
            planInfo?.hideDailyQuota == true ? nil : dailyRemainingPercent,
            planInfo?.hideWeeklyQuota == true ? nil : weeklyRemainingPercent,
        ].compactMap { $0 }
        return values.min()
    }

    var dailyQuotaRemainingPercent: Double? {
        if let remaining = planInfo?.quotaUsage?.dailyRemainingPercent {
            return remaining
        }
        return remainingPercent(fromUsed: dailyUsagePercent)
    }

    var weeklyQuotaRemainingPercent: Double? {
        if let remaining = planInfo?.quotaUsage?.weeklyRemainingPercent {
            return remaining
        }
        return remainingPercent(fromUsed: weeklyUsagePercent)
    }

    private var dailyRemainingPercent: Double? {
        dailyQuotaRemainingPercent
    }

    private var weeklyRemainingPercent: Double? {
        weeklyQuotaRemainingPercent
    }

    private static func usedPercent(used: Int?, total: Int?) -> Double? {
        guard let used, let total, total > 0, used >= 0 else { return nil }
        return (Double(used) / Double(total)) * 100
    }

    private static func usagePercent(fromRemaining remaining: Double?) -> Double? {
        guard let remaining, !remaining.isNaN else { return nil }
        return max(0, min(100, 100 - remaining))
    }

    private static func formatPercent(_ value: Double?) -> String? {
        guard let value, !value.isNaN else { return nil }
        let clamped = min(100, max(0, value))
        return "\(Int(clamped.rounded()))%"
    }

    private static func formatRemainingCount(remaining: Int?, total: Int?) -> String {
        guard let remaining, let total else { return "?" }
        if total < 0 || remaining < 0 {
            return "unlimited"
        }
        return "\(remaining)/\(total)"
    }

    private static func formatUnixReset(_ unix: Int64?, label: String) -> String? {
        guard let unix, unix > 0 else { return nil }
        let date = Date(timeIntervalSince1970: TimeInterval(unix))
        return "\(label) resets \(formatMenuDateTime(date))"
    }
}

private func formatMenuDateTime(_ date: Date) -> String {
    date.formatted(
        Date.FormatStyle()
            .month(.abbreviated)
            .day()
            .hour(.defaultDigits(amPM: .abbreviated))
            .minute(.twoDigits)
    )
}

private func remainingPercent(fromUsed used: Double?) -> Double? {
    guard let used, !used.isNaN else { return nil }
    return max(0, min(100, 100 - used))
}

struct WindsurfStore: Codable {
    let version: String?
    var accounts: [WindsurfAccount]
    let updatedAt: String?
    let activeKey: String?
}

enum Provider: String, CaseIterable {
    case claude = "Claude Code"
    case codex = "Codex"
    case kiro = "Kiro"
    case windsurf = "Windsurf"
}
