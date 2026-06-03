import Foundation

struct StoreService {
    private let claudeStorePath: String = {
        NSHomeDirectory() + "/.ClaudeCodeMultiAccounts.json"
    }()

    private let codexStorePath: String = {
        NSHomeDirectory() + "/.CodexMultiAccounts.json"
    }()

    private let claudeConfigPath: String = {
        NSHomeDirectory() + "/.claude.json"
    }()

    private let codexAuthPath: String = {
        NSHomeDirectory() + "/.codex/auth.json"
    }()

    private let kiroStorePath: String = {
        NSHomeDirectory() + "/.KiroMultiAccounts.json"
    }()

    private let windsurfStatePaths: [String] = [
        NSHomeDirectory() + "/Library/Application Support/Windsurf - Next/User/globalStorage/state.vscdb",
        NSHomeDirectory() + "/Library/Application Support/Windsurf/User/globalStorage/state.vscdb",
    ]

    func loadClaudeStore() -> ClaudeStore {
        guard let data = try? Data(contentsOf: URL(fileURLWithPath: claudeStorePath)),
              let store = try? JSONDecoder().decode(ClaudeStore.self, from: data) else {
            return ClaudeStore(version: nil, accounts: [], updatedAt: nil)
        }
        return store
    }

    func loadCodexStore() -> CodexStore {
        guard let data = try? Data(contentsOf: URL(fileURLWithPath: codexStorePath)),
              let store = try? JSONDecoder().decode(CodexStore.self, from: data) else {
            return CodexStore(version: nil, accounts: [], updatedAt: nil)
        }
        return store
    }

    func detectActiveClaudeKey() -> String? {
        guard let data = try? Data(contentsOf: URL(fileURLWithPath: claudeConfigPath)),
              let config = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let oauth = config["oauthAccount"] as? [String: Any] else {
            return nil
        }
        if let uuid = oauth["accountUuid"] as? String, !uuid.isEmpty {
            return "uuid:\(uuid.lowercased())"
        }
        if let email = oauth["emailAddress"] as? String, !email.isEmpty {
            return "email:\(email.lowercased())"
        }
        return nil
    }

    func detectActiveCodexKey() -> String? {
        guard let data = try? Data(contentsOf: URL(fileURLWithPath: codexAuthPath)),
              let auth = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let tokens = auth["tokens"] as? [String: Any],
              let accountId = tokens["account_id"] as? String else {
            return nil
        }
        return "account:\(accountId)"
    }

    func loadKiroStore() -> KiroStore {
        guard let data = try? Data(contentsOf: URL(fileURLWithPath: kiroStorePath)),
              let store = try? JSONDecoder().decode(KiroStore.self, from: data) else {
            return KiroStore(version: nil, accounts: [], updatedAt: nil, activeKey: nil)
        }
        return store
    }

    func loadWindsurfStore() -> WindsurfStore {
        for path in windsurfStatePaths {
            guard let planInfo = loadWindsurfPlanInfo(from: path) else { continue }
            let account = WindsurfAccount(
                key: "windsurf:current",
                planInfo: planInfo,
                capturedAt: Date().ISO8601Format(),
                sourcePath: path
            )
            return WindsurfStore(version: nil, accounts: [account], updatedAt: Date().ISO8601Format(), activeKey: account.key)
        }
        return WindsurfStore(version: nil, accounts: [], updatedAt: nil, activeKey: nil)
    }

    private func loadWindsurfPlanInfo(from dbPath: String) -> WindsurfPlanInfo? {
        let cachedPlanInfo = loadCachedWindsurfPlanInfo(from: dbPath)
        let livePlanInfo = loadLiveWindsurfPlanInfo(from: dbPath)

        switch (cachedPlanInfo, livePlanInfo) {
        case let (cached?, live?):
            return cached.merging(with: live)
        case let (nil, live?):
            return live
        case let (cached?, nil):
            return cached
        default:
            return nil
        }
    }

    private func loadCachedWindsurfPlanInfo(from dbPath: String) -> WindsurfPlanInfo? {
        guard let json = readSQLiteValue(from: dbPath, key: "windsurf.settings.cachedPlanInfo"),
              let data = json.data(using: .utf8),
              let planInfo = try? JSONDecoder().decode(WindsurfPlanInfo.self, from: data) else {
            return nil
        }
        return planInfo
    }

    private func loadLiveWindsurfPlanInfo(from dbPath: String) -> WindsurfPlanInfo? {
        guard let json = readSQLiteValue(from: dbPath, key: "windsurfAuthStatus"),
              let data = json.data(using: .utf8),
              let payload = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let base64 = payload["userStatusProtoBinaryBase64"] as? String,
              let blob = Data(base64Encoded: base64),
              let parsed = parseWindsurfUserStatus(blob) else {
            return nil
        }

        return parsed
    }

    private func readSQLiteValue(from dbPath: String, key: String) -> String? {
        guard FileManager.default.fileExists(atPath: dbPath) else { return nil }

        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/sqlite3")
        let escapedKey = key.replacingOccurrences(of: "'", with: "''")
        process.arguments = [dbPath, "select value from ItemTable where key='\(escapedKey)' limit 1;"]

        let output = Pipe()
        process.standardOutput = output
        process.standardError = Pipe()

        do {
            try process.run()
            let data = output.fileHandleForReading.readDataToEndOfFile()
            process.waitUntilExit()
            guard process.terminationStatus == 0 else { return nil }
            guard let value = String(data: data, encoding: .utf8)?
                .trimmingCharacters(in: .whitespacesAndNewlines),
                !value.isEmpty else {
                return nil
            }
            return value
        } catch {
            return nil
        }
    }
}

private extension WindsurfPlanInfo {
    func merging(with live: WindsurfPlanInfo) -> WindsurfPlanInfo {
        WindsurfPlanInfo(
            planName: live.planName ?? planName,
            startTimestamp: live.startTimestamp ?? startTimestamp,
            endTimestamp: live.endTimestamp ?? endTimestamp,
            usage: live.usage ?? usage,
            hasBillingWritePermissions: live.hasBillingWritePermissions ?? hasBillingWritePermissions,
            gracePeriodStatus: live.gracePeriodStatus ?? gracePeriodStatus,
            billingStrategy: billingStrategy ?? live.billingStrategy,
            quotaUsage: quotaUsage?.merging(with: live.quotaUsage) ?? live.quotaUsage,
            teamsTier: live.teamsTier ?? teamsTier,
            hideDailyQuota: live.hideDailyQuota ?? hideDailyQuota,
            hideWeeklyQuota: live.hideWeeklyQuota ?? hideWeeklyQuota
        )
    }
}

private extension WindsurfQuotaUsage {
    func merging(with live: WindsurfQuotaUsage?) -> WindsurfQuotaUsage {
        guard let live else { return self }
        return WindsurfQuotaUsage(
            dailyRemainingPercent: live.dailyRemainingPercent ?? dailyRemainingPercent,
            weeklyRemainingPercent: live.weeklyRemainingPercent ?? weeklyRemainingPercent,
            overageBalanceMicros: live.overageBalanceMicros ?? overageBalanceMicros,
            dailyResetAtUnix: live.dailyResetAtUnix ?? dailyResetAtUnix,
            weeklyResetAtUnix: live.weeklyResetAtUnix ?? weeklyResetAtUnix
        )
    }
}

private struct ProtoField {
    let number: Int
    let wireType: Int
    let value: ProtoValue
}

private enum ProtoValue {
    case varint(UInt64)
    case lengthDelimited(Data)
    case fixed32(UInt32)
    case fixed64(UInt64)
}

private struct ProtoReader {
    let bytes: [UInt8]
    var index: Int = 0

    init(_ data: Data) {
        self.bytes = Array(data)
    }

    mutating func nextField() -> ProtoField? {
        guard let tag = readVarint() else { return nil }
        let number = Int(tag >> 3)
        let wireType = Int(tag & 0x7)

        switch wireType {
        case 0:
            guard let value = readVarint() else { return nil }
            return ProtoField(number: number, wireType: wireType, value: .varint(value))
        case 1:
            guard let value = readFixed64() else { return nil }
            return ProtoField(number: number, wireType: wireType, value: .fixed64(value))
        case 2:
            guard let length = readVarint(), let data = readData(Int(length)) else { return nil }
            return ProtoField(number: number, wireType: wireType, value: .lengthDelimited(data))
        case 5:
            guard let value = readFixed32() else { return nil }
            return ProtoField(number: number, wireType: wireType, value: .fixed32(value))
        default:
            return nil
        }
    }

    private mutating func readVarint() -> UInt64? {
        var shift: UInt64 = 0
        var result: UInt64 = 0

        while index < bytes.count {
            let byte = bytes[index]
            index += 1
            result |= UInt64(byte & 0x7F) << shift
            if byte & 0x80 == 0 {
                return result
            }
            shift += 7
            if shift >= 64 {
                return nil
            }
        }

        return nil
    }

    private mutating func readData(_ length: Int) -> Data? {
        guard length >= 0, index + length <= bytes.count else { return nil }
        defer { index += length }
        return Data(bytes[index ..< index + length])
    }

    private mutating func readFixed32() -> UInt32? {
        guard index + 4 <= bytes.count else { return nil }
        let value = UInt32(bytes[index])
            | (UInt32(bytes[index + 1]) << 8)
            | (UInt32(bytes[index + 2]) << 16)
            | (UInt32(bytes[index + 3]) << 24)
        index += 4
        return value
    }

    private mutating func readFixed64() -> UInt64? {
        guard index + 8 <= bytes.count else { return nil }
        var value: UInt64 = 0
        for offset in 0..<8 {
            value |= UInt64(bytes[index + offset]) << (UInt64(offset) * 8)
        }
        index += 8
        return value
    }
}

private struct ParsedWindsurfPlanStatus {
    let planName: String?
    let startTimestamp: Double?
    let endTimestamp: Double?
    let quotaUsage: WindsurfQuotaUsage?
    let teamsTier: Int?
    let hideDailyQuota: Bool?
    let hideWeeklyQuota: Bool?
}

private func parseWindsurfUserStatus(_ data: Data) -> WindsurfPlanInfo? {
    var reader = ProtoReader(data)
    while let field = reader.nextField() {
        if field.number == 13, case let .lengthDelimited(planStatusData) = field.value {
            let parsed = parseWindsurfPlanStatus(planStatusData)
            return WindsurfPlanInfo(
                planName: parsed?.planName,
                startTimestamp: parsed?.startTimestamp,
                endTimestamp: parsed?.endTimestamp,
                usage: nil,
                hasBillingWritePermissions: nil,
                gracePeriodStatus: nil,
                billingStrategy: nil,
                quotaUsage: parsed?.quotaUsage,
                teamsTier: parsed?.teamsTier,
                hideDailyQuota: parsed?.hideDailyQuota,
                hideWeeklyQuota: parsed?.hideWeeklyQuota
            )
        }
    }
    return nil
}

private func parseWindsurfPlanStatus(_ data: Data) -> ParsedWindsurfPlanStatus? {
    var reader = ProtoReader(data)
    var planName: String?
    var startTimestamp: Double?
    var endTimestamp: Double?
    var dailyRemainingPercent: Double?
    var weeklyRemainingPercent: Double?
    var overageBalanceMicros: Int64?
    var dailyResetAtUnix: Int64?
    var weeklyResetAtUnix: Int64?
    var teamsTier: Int?
    var hideDailyQuota: Bool?
    var hideWeeklyQuota: Bool?

    while let field = reader.nextField() {
        switch field.number {
        case 1:
            if case let .lengthDelimited(planInfoData) = field.value {
                let parsedPlanInfo = parseWindsurfPlanInfoBlob(planInfoData)
                planName = parsedPlanInfo.planName ?? planName
                teamsTier = parsedPlanInfo.teamsTier ?? teamsTier
                hideDailyQuota = parsedPlanInfo.hideDailyQuota ?? hideDailyQuota
                hideWeeklyQuota = parsedPlanInfo.hideWeeklyQuota ?? hideWeeklyQuota
            }
        case 2:
            if case let .lengthDelimited(timestampData) = field.value {
                startTimestamp = parseProtoTimestamp(timestampData)
            }
        case 3:
            if case let .lengthDelimited(timestampData) = field.value {
                endTimestamp = parseProtoTimestamp(timestampData)
            }
        case 14:
            dailyRemainingPercent = doubleFromVarint(field.value)
        case 15:
            weeklyRemainingPercent = doubleFromVarint(field.value)
        case 16:
            overageBalanceMicros = int64FromVarint(field.value)
        case 17:
            dailyResetAtUnix = int64FromVarint(field.value)
        case 18:
            weeklyResetAtUnix = int64FromVarint(field.value)
        default:
            continue
        }
    }

    let quotaUsage: WindsurfQuotaUsage?
    if dailyRemainingPercent != nil || weeklyRemainingPercent != nil || overageBalanceMicros != nil || dailyResetAtUnix != nil || weeklyResetAtUnix != nil {
        quotaUsage = WindsurfQuotaUsage(
            dailyRemainingPercent: dailyRemainingPercent,
            weeklyRemainingPercent: weeklyRemainingPercent,
            overageBalanceMicros: overageBalanceMicros,
            dailyResetAtUnix: dailyResetAtUnix,
            weeklyResetAtUnix: weeklyResetAtUnix
        )
    } else {
        quotaUsage = nil
    }

    return ParsedWindsurfPlanStatus(
        planName: planName,
        startTimestamp: startTimestamp,
        endTimestamp: endTimestamp,
        quotaUsage: quotaUsage,
        teamsTier: teamsTier,
        hideDailyQuota: hideDailyQuota,
        hideWeeklyQuota: hideWeeklyQuota
    )
}

private func parseWindsurfPlanInfoBlob(_ data: Data) -> (planName: String?, teamsTier: Int?, hideDailyQuota: Bool?, hideWeeklyQuota: Bool?) {
    var reader = ProtoReader(data)
    var planName: String?
    var teamsTier: Int?
    var hideDailyQuota: Bool?
    var hideWeeklyQuota: Bool?

    while let field = reader.nextField() {
        switch field.number {
        case 2:
            if case let .lengthDelimited(nameData) = field.value {
                planName = String(data: nameData, encoding: .utf8)
            }
        case 1:
            teamsTier = intFromVarint(field.value)
        case 36:
            hideDailyQuota = boolFromVarint(field.value)
        case 37:
            hideWeeklyQuota = boolFromVarint(field.value)
        default:
            continue
        }
    }

    return (planName, teamsTier, hideDailyQuota, hideWeeklyQuota)
}

private func parseProtoTimestamp(_ data: Data) -> Double? {
    var reader = ProtoReader(data)
    var seconds: Int64?
    var nanos: Int64?

    while let field = reader.nextField() {
        switch field.number {
        case 1:
            seconds = int64FromVarint(field.value)
        case 2:
            nanos = int64FromVarint(field.value)
        default:
            continue
        }
    }

    guard let seconds else { return nil }
    let fractional = Double(nanos ?? 0) / 1_000_000_000
    return Double(seconds) + fractional
}

private func intFromVarint(_ value: ProtoValue) -> Int? {
    guard case let .varint(raw) = value else { return nil }
    return Int(bitPattern: UInt(raw))
}

private func int64FromVarint(_ value: ProtoValue) -> Int64? {
    guard case let .varint(raw) = value else { return nil }
    return Int64(bitPattern: raw)
}

private func boolFromVarint(_ value: ProtoValue) -> Bool? {
    guard case let .varint(raw) = value else { return nil }
    return raw != 0
}

private func doubleFromVarint(_ value: ProtoValue) -> Double? {
    guard case let .varint(raw) = value else { return nil }
    return Double(raw)
}
