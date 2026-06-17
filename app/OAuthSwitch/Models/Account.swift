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

// A snapshot whose fetchedAt is older than this is "stale": the daemon may be
// backed off from a usage-API 429, so the displayed numbers could be hours old.
// The UI must visually signal staleness so users don't trust a cached value as
// the live balance.
let STALE_THRESHOLD: TimeInterval = 20 * 60

extension UsageSnapshot {
    // True when there is no fetch timestamp, or the snapshot was fetched more
    // than STALE_THRESHOLD ago.
    var isStale: Bool {
        guard let date = parseISODate(fetchedAt) else { return true }
        return Date().timeIntervalSince(date) > STALE_THRESHOLD
    }

    // Compact human age of the snapshot ("12m ago", "3h ago"); nil when fresh
    // (within STALE_THRESHOLD) or when there is no timestamp.
    var ageText: String? {
        guard let date = parseISODate(fetchedAt) else { return nil }
        let seconds = Date().timeIntervalSince(date)
        guard seconds > STALE_THRESHOLD else { return nil }
        if seconds < 3600 {
            return "\(Int((seconds / 60).rounded()))m ago"
        }
        if seconds < 86_400 {
            return "\(Int((seconds / 3600).rounded()))h ago"
        }
        return "\(Int((seconds / 86_400).rounded()))d ago"
    }
}

extension UsageSnapshot.Window {
    var resetDate: Date? {
        parseISODate(resets_at)
    }

    // resets_at in the past means the window HAS reset since the snapshot was
    // taken: the stored utilization is obsolete.
    var hasResetInPast: Bool {
        guard let resetDate else { return false }
        return resetDate < Date()
    }

    // Reset-aware utilization: a window that already reset counts as 0 used.
    // Only a network refresh gives better data.
    var effectiveUtilization: Double? {
        hasResetInPast ? 0 : utilization
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
    let disabled: Bool?
    // "reauth_required" when the CLI marked this credential group as needing
    // a manual Claude Code login (refreshToken rejected by the OAuth endpoint).
    let credentialStatus: String?

    var id: String { key }

    var isDisabled: Bool {
        disabled == true
    }

    var needsReauth: Bool {
        guard credentialStatus == "reauth_required" else { return false }
        // A stale marker can survive a successful re-login until the next
        // sync clears it; if the stored token is still valid, the account
        // does not actually need reauth.
        return credentials?.claudeAiOauth?.isValidNow != true
    }

    var credentialFingerprint: String? {
        credentials?.claudeAiOauth?.fingerprint
    }

    var canonicalKey: String {
        ClaudeAccount.makeCanonicalKey(
            accountUuid: metadata?.accountUuid,
            emailAddress: metadata?.emailAddress,
            organizationUuid: metadata?.organizationUuid,
            organizationId: metadata?.organizationId,
            workspaceUuid: metadata?.workspaceUuid,
            workspaceId: metadata?.workspaceId
        ) ?? key
    }

    var scopeKey: String {
        ClaudeAccount.makeScopeKey(
            organizationUuid: metadata?.organizationUuid,
            organizationId: metadata?.organizationId,
            workspaceUuid: metadata?.workspaceUuid,
            workspaceId: metadata?.workspaceId
        ) ?? "scope:none"
    }

    var displayName: String {
        metadata?.emailAddress ?? key
    }

    var fiveHourUsed: Double {
        usageSnapshot?.five_hour?.effectiveUtilization ?? 0
    }

    var sevenDayUsed: Double {
        usageSnapshot?.seven_day?.effectiveUtilization ?? 0
    }

    // True when the stored window already reset: the displayed 0% is an
    // estimate, not fetched data.
    var fiveHourIsStale: Bool {
        usageSnapshot?.five_hour?.hasResetInPast == true
    }

    var sevenDayIsStale: Bool {
        usageSnapshot?.seven_day?.hasResetInPast == true
    }

    var resetSummary: String? {
        usageSnapshot?.resetSummary
    }

    // True when the stored snapshot is missing a fetch time or older than
    // STALE_THRESHOLD: the displayed metrics may be hours-old cached data.
    var usageIsStale: Bool {
        usageSnapshot?.isStale ?? true
    }

    // "12m ago" / "3h ago" when the snapshot is stale, otherwise nil.
    var snapshotAgeText: String? {
        usageSnapshot?.ageText
    }

    var lowestRemainingPercent: Double? {
        let values = [fiveHourRemainingPercent, sevenDayRemainingPercent].compactMap { $0 }
        return values.min()
    }

    private var fiveHourRemainingPercent: Double? {
        remainingPercent(fromUsed: usageSnapshot?.five_hour?.effectiveUtilization)
    }

    private var sevenDayRemainingPercent: Double? {
        remainingPercent(fromUsed: usageSnapshot?.seven_day?.effectiveUtilization)
    }
}

struct ClaudeMetadata: Codable {
    let emailAddress: String?
    let accountUuid: String?
    let organizationUuid: String?
    let organizationId: String?
    let organizationName: String?
    let workspaceUuid: String?
    let workspaceId: String?
    let planType: String?
}

struct ClaudeCredentials: Codable {
    let claudeAiOauth: ClaudeOAuthCredentials?
}

struct ClaudeOAuthCredentials: Codable {
    let accessToken: String?
    let refreshToken: String?
    let expiresAt: Double?

    // True when expiresAt is set and still in the future: the access token is
    // valid right now. Claude stores expiresAt as epoch milliseconds.
    var isValidNow: Bool {
        guard let expiresAt else { return false }
        return expiresAt > Date().timeIntervalSince1970 * 1000
    }

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

extension ClaudeAccount {
    static func makeCanonicalKey(
        accountUuid: String?,
        emailAddress: String?,
        organizationUuid: String?,
        organizationId: String?,
        workspaceUuid: String?,
        workspaceId: String?
    ) -> String? {
        let baseKey: String?
        if let accountUuid = normalized(accountUuid) {
            baseKey = "uuid:\(accountUuid)"
        } else if let emailAddress = normalized(emailAddress) {
            baseKey = "email:\(emailAddress)"
        } else {
            baseKey = nil
        }

        guard let baseKey else { return nil }
        guard let scope = makeScopeKey(
            organizationUuid: organizationUuid,
            organizationId: organizationId,
            workspaceUuid: workspaceUuid,
            workspaceId: workspaceId
        ) else {
            return baseKey
        }
        return "\(baseKey):\(scope)"
    }

    static func makeScopeKey(
        organizationUuid: String?,
        organizationId: String?,
        workspaceUuid: String?,
        workspaceId: String?
    ) -> String? {
        if let workspaceUuid = normalized(workspaceUuid ?? workspaceId) {
            return "workspace:\(workspaceUuid)"
        }
        if let organizationUuid = normalized(organizationUuid ?? organizationId) {
            return "org:\(organizationUuid)"
        }
        return nil
    }

    private static func normalized(_ value: String?) -> String? {
        guard let value else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return trimmed.isEmpty ? nil : trimmed
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
    let workspaceId: String?
    let workspaceTitle: String?
    let switchable: Bool?
    let disabled: Bool?

    var id: String { key }

    var isDisabled: Bool {
        disabled == true
    }

    var label: String {
        guard let workspaceTitle, !workspaceTitle.isEmpty else {
            return displayName ?? key
        }
        let baseName = displayName ?? key
        return "\(baseName) [\(workspaceTitle)]"
    }

    var credentialFingerprint: String? {
        auth?.credentialFingerprint
    }

    var canonicalKey: String {
        CodexAccount.makeCanonicalKey(auth: auth, workspaceId: workspaceId) ?? key
    }

    var scopeKey: String {
        CodexAccount.makeScopeKey(auth: auth, workspaceId: workspaceId) ?? "scope:none"
    }

    var fiveHourUsed: Double? {
        usageSnapshot?.five_hour?.effectiveUtilization
    }

    var sevenDayUsed: Double? {
        usageSnapshot?.seven_day?.effectiveUtilization
    }

    // True when the stored window already reset: the displayed 0% is an
    // estimate, not fetched data.
    var fiveHourIsStale: Bool {
        usageSnapshot?.five_hour?.hasResetInPast == true
    }

    var sevenDayIsStale: Bool {
        usageSnapshot?.seven_day?.hasResetInPast == true
    }

    var resetSummary: String? {
        usageSnapshot?.resetSummary
    }

    // True when the stored snapshot is missing a fetch time or older than
    // STALE_THRESHOLD: the displayed metrics may be hours-old cached data.
    var usageIsStale: Bool {
        usageSnapshot?.isStale ?? true
    }

    // "12m ago" / "3h ago" when the snapshot is stale, otherwise nil.
    var snapshotAgeText: String? {
        usageSnapshot?.ageText
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
        guard let date = parseISODate(isoString) else { return nil }
        // A reset time in the past is no longer informative: the window
        // already reset, so don't show "resets <yesterday>".
        guard date >= Date() else { return nil }
        return "\(label) resets \(formatMenuDateTime(date))"
    }
}

struct CodexAuth: Codable {
    let OPENAI_API_KEY: String?
    let auth_mode: String?
    let tokens: CodexTokens?

    var credentialFingerprint: String? {
        let normalizedAccessToken = tokens?.access_token?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let normalizedIdToken = tokens?.id_token?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !normalizedAccessToken.isEmpty || !normalizedIdToken.isEmpty else {
            return nil
        }
        guard let data = try? JSONEncoder().encode([normalizedAccessToken, normalizedIdToken]),
              let fingerprint = String(data: data, encoding: .utf8) else {
            return nil
        }
        return fingerprint
    }
}

struct CodexTokens: Codable {
    let access_token: String?
    let id_token: String?
    let account_id: String?
}

struct CodexStore: Codable {
    let version: String?
    var accounts: [CodexAccount]
    let updatedAt: String?
}

extension CodexAccount {
    static func makeCanonicalKey(auth: CodexAuth?, workspaceId: String? = nil) -> String? {
        let info = decodeAuthInfo(auth: auth)
        let baseKey: String?
        if let accountId = normalized(auth?.tokens?.account_id ?? info.accountId) {
            baseKey = "account:\(accountId)"
        } else if let email = normalized(info.email) {
            baseKey = "email:\(email)"
        } else if let apiKey = auth?.OPENAI_API_KEY, !apiKey.isEmpty {
            return "key:\(String(apiKey.prefix(12)))"
        } else {
            baseKey = nil
        }

        guard let baseKey else { return nil }
        guard let scope = makeScopeKey(auth: auth, workspaceId: workspaceId) else { return baseKey }
        return "\(baseKey):\(scope)"
    }

    static func makeScopeKey(auth: CodexAuth?, workspaceId: String? = nil) -> String? {
        if let workspaceId = normalized(workspaceId) {
            return "org:\(workspaceId)"
        }
        let info = decodeAuthInfo(auth: auth)
        guard let orgId = normalized(info.defaultOrgId) else { return nil }
        return "org:\(orgId)"
    }

    var workspaceVariants: [CodexAccount] {
        let workspaces = Self.decodeWorkspaces(auth: auth)
        guard !workspaces.isEmpty else { return [self] }
        return workspaces.map { workspace in
            let scopedKey = Self.makeCanonicalKey(auth: auth, workspaceId: workspace.id) ?? key
            return CodexAccount(
                key: scopedKey,
                auth: auth,
                displayName: displayName,
                capturedAt: capturedAt,
                lastUsedAt: lastUsedAt,
                usageSnapshot: usageSnapshot,
                workspaceId: workspace.id,
                workspaceTitle: workspace.title,
                switchable: workspace.isDefault,
                disabled: disabled
            )
        }
    }

    private static func decodeWorkspaces(auth: CodexAuth?) -> [(id: String?, title: String?, isDefault: Bool)] {
        guard let token = auth?.tokens?.id_token ?? auth?.tokens?.access_token,
              let payload = decodeJwtPayload(token),
              let authInfo = payload["https://api.openai.com/auth"] as? [String: Any] else {
            return []
        }
        let orgs = authInfo["organizations"] as? [[String: Any]] ?? []
        return orgs.map { org in
            (
                org["id"] as? String,
                org["title"] as? String,
                (org["is_default"] as? Bool) == true
            )
        }
    }

    private static func decodeAuthInfo(auth: CodexAuth?) -> (email: String?, accountId: String?, defaultOrgId: String?) {
        guard let token = auth?.tokens?.id_token ?? auth?.tokens?.access_token,
              let payload = decodeJwtPayload(token),
              let authInfo = payload["https://api.openai.com/auth"] as? [String: Any] else {
            return (nil, nil, nil)
        }

        let orgs = authInfo["organizations"] as? [[String: Any]] ?? []
        let defaultOrg = orgs.first(where: { ($0["is_default"] as? Bool) == true }) ?? orgs.first
        return (
            payload["email"] as? String,
            authInfo["chatgpt_account_id"] as? String,
            defaultOrg?["id"] as? String
        )
    }

    private static func decodeJwtPayload(_ token: String) -> [String: Any]? {
        let parts = token.split(separator: ".")
        guard parts.count >= 2 else { return nil }
        var base64 = String(parts[1])
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        let padding = base64.count % 4
        if padding > 0 {
            base64 += String(repeating: "=", count: 4 - padding)
        }
        guard let data = Data(base64Encoded: base64),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return nil
        }
        return json
    }

    private static func normalized(_ value: String?) -> String? {
        guard let value else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return trimmed.isEmpty ? nil : trimmed
    }
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
        guard let date = parseISODate(auth?.expiresAt) else { return false }
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

private func parseISODate(_ isoString: String?) -> Date? {
    guard let isoString else { return nil }

    // Fast path: exactly 3 fractional digits (milliseconds), the only
    // precision ISO8601DateFormatter.withFractionalSeconds accepts.
    let fractional = ISO8601DateFormatter()
    fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let date = fractional.date(from: isoString) {
        return date
    }

    // Plain path: no fractional seconds at all.
    let plain = ISO8601DateFormatter()
    plain.formatOptions = [.withInternetDateTime]
    if let date = plain.date(from: isoString) {
        return date
    }

    // The usage API emits microsecond precision (6 digits) plus a `+00:00`
    // offset, e.g. "2026-06-14T08:49:59.285061+00:00". Neither formatter above
    // accepts arbitrary fractional precision, so strip the fractional part and
    // retry with the plain (non-fractional) formatter. The truncation loses
    // sub-second precision, which is irrelevant for reset-time comparisons.
    let normalized = isoString.replacingOccurrences(
        of: #"\.\d+"#,
        with: "",
        options: .regularExpression
    )
    if normalized != isoString, let date = plain.date(from: normalized) {
        return date
    }
    return nil
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
