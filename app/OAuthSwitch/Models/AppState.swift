import Foundation
import Combine

class AppState: ObservableObject {
    private enum PreferenceKey {
        static let refreshIntervalSeconds = "settings.refreshIntervalSeconds"
        static let autoSyncClaudeUsage = "settings.autoSyncClaudeUsage"
        static let autoSyncCodexUsage = "settings.autoSyncCodexUsage"
        static let autoSyncKiroAccounts = "settings.autoSyncKiroAccounts"
        static let autoRefreshExpiredKiro = "settings.autoRefreshExpiredKiro"
        static let showResetTimes = "settings.showResetTimes"
        static let showInactiveAccounts = "settings.showInactiveAccounts"
        static let menuBarBalanceSource = "settings.menuBarBalanceSource"
    }

    @Published var claudeAccounts: [ClaudeAccount] = []
    @Published var codexAccounts: [CodexAccount] = []
    @Published var activeClaudeKey: String?
    @Published var activeCodexKey: String?
    @Published var kiroAccounts: [KiroAccount] = []
    @Published var activeKiroKey: String?
    @Published var windsurfAccounts: [WindsurfAccount] = []
    @Published var activeWindsurfKey: String?
    @Published var trigger5h: Double = 80
    @Published var trigger7d: Double = 90
    @Published var lastCheckTime: Date?
    @Published var lastSwitchMessage: String?
    // Status line for the "Capture current browser Claude session" action.
    @Published var cookieCaptureMessage: String?
    @Published var isCapturingCookie: Bool = false
    // Store keys of non-active Claude accounts whose cached cookie was rejected
    // (401/403) on the last web-usage refresh. Surfaced as a DISTINCT
    // "Cookie expired — re-import" row state, never the OAuth "Re-login" state.
    @Published var cookieExpiredClaudeKeys: Set<String> = []
    @Published var loadingProviders: Set<ProviderID> = Set(ProviderID.allCases)
    // Default 15 minutes: the timer-driven refresh shells out to `usage` /
    // `codex sync-usage`, and anything more frequent risks usage-API 429
    // endpoint throttling. Existing user-chosen values are preserved.
    @Published var refreshIntervalSeconds: Int = UserDefaults.standard.integer(forKey: PreferenceKey.refreshIntervalSeconds) == 0 ? 900 : UserDefaults.standard.integer(forKey: PreferenceKey.refreshIntervalSeconds) {
        didSet {
            UserDefaults.standard.set(refreshIntervalSeconds, forKey: PreferenceKey.refreshIntervalSeconds)
            startPolling()
        }
    }
    @Published var autoSyncClaudeUsage: Bool = UserDefaults.standard.object(forKey: PreferenceKey.autoSyncClaudeUsage) as? Bool ?? true {
        didSet {
            UserDefaults.standard.set(autoSyncClaudeUsage, forKey: PreferenceKey.autoSyncClaudeUsage)
        }
    }
    @Published var autoSyncCodexUsage: Bool = UserDefaults.standard.object(forKey: PreferenceKey.autoSyncCodexUsage) as? Bool ?? true {
        didSet {
            UserDefaults.standard.set(autoSyncCodexUsage, forKey: PreferenceKey.autoSyncCodexUsage)
        }
    }
    @Published var autoSyncKiroAccounts: Bool = UserDefaults.standard.object(forKey: PreferenceKey.autoSyncKiroAccounts) as? Bool ?? true {
        didSet {
            UserDefaults.standard.set(autoSyncKiroAccounts, forKey: PreferenceKey.autoSyncKiroAccounts)
        }
    }
    @Published var autoRefreshExpiredKiro: Bool = UserDefaults.standard.object(forKey: PreferenceKey.autoRefreshExpiredKiro) as? Bool ?? true {
        didSet {
            UserDefaults.standard.set(autoRefreshExpiredKiro, forKey: PreferenceKey.autoRefreshExpiredKiro)
        }
    }
    @Published var showResetTimes: Bool = UserDefaults.standard.object(forKey: PreferenceKey.showResetTimes) as? Bool ?? true {
        didSet {
            UserDefaults.standard.set(showResetTimes, forKey: PreferenceKey.showResetTimes)
        }
    }
    @Published var showInactiveAccounts: Bool = UserDefaults.standard.object(forKey: PreferenceKey.showInactiveAccounts) as? Bool ?? true {
        didSet {
            UserDefaults.standard.set(showInactiveAccounts, forKey: PreferenceKey.showInactiveAccounts)
        }
    }
    @Published var menuBarBalanceSourceRawValue: String = UserDefaults.standard.string(forKey: PreferenceKey.menuBarBalanceSource) ?? MenuBarBalanceSource.off.rawValue {
        didSet {
            UserDefaults.standard.set(menuBarBalanceSourceRawValue, forKey: PreferenceKey.menuBarBalanceSource)
        }
    }

    private var timer: Timer?
    private var codexLoginPollingTimer: Timer?
    private var windsurfLoadGeneration = 0
    private let storeService = StoreService()
    private let switchService = SwitchService()
    private let cookieUsageRefresher = CookieUsageRefreshService()
    // Cookie-based web usage for non-active accounts is refreshed at most once
    // per this interval (mirrors the daemon's conservative non-current cadence),
    // so frequent reloads/switches don't hammer claude.ai. A forced refresh
    // ("Refresh All") bypasses it.
    private static let cookieRefreshMinInterval: TimeInterval = 15 * 60
    private var lastCookieUsageRefreshAt: Date?

    var providerSections: [ProviderSectionSnapshot] {
        [
            buildClaudeSection(),
            buildCodexSection(),
            buildKiroSection(),
            buildWindsurfSection(),
        ]
    }

    var menuBarIcon: String {
        let claudeHigh = claudeAccounts
            .first { $0.matchesActiveKey(activeClaudeKey) }
            .map { $0.fiveHourUsed >= trigger5h || $0.sevenDayUsed >= trigger7d } ?? false
        return claudeHigh ? "exclamationmark.arrow.trianglehead.2.clockwise.rotate.90" : "arrow.trianglehead.2.clockwise.rotate.90"
    }

    var menuBarProviderIcon: ProviderID? {
        menuBarBalanceSource.providerID
    }

    var menuBarTitle: String {
        if let balanceText = menuBarBalanceText {
            return balanceText
        }
        return "OAuth Switch"
    }

    var menuBarBalanceSource: MenuBarBalanceSource {
        MenuBarBalanceSource(rawValue: menuBarBalanceSourceRawValue) ?? .off
    }

    var menuBarBalanceText: String? {
        let percent: Double?
        // Windsurf has no usage-API snapshot timestamp, so it is never marked stale.
        var isStale = false
        switch menuBarBalanceSource {
        case .off:
            return nil
        case .claude:
            let account = claudeAccounts.first(where: { $0.matchesActiveKey(activeClaudeKey) })
            percent = account?.lowestRemainingPercent
            isStale = account?.usageIsStale ?? false
        case .codex:
            let account = codexAccounts.first(where: { $0.matchesActiveKey(activeCodexKey) })
            percent = account?.lowestRemainingPercent
            isStale = account?.usageIsStale ?? false
        case .windsurf:
            percent = windsurfAccounts.first(where: { $0.key == activeWindsurfKey })?.lowestRemainingPercent
        }

        guard let percent, !percent.isNaN else { return nil }
        // Stale snapshot: append a compact marker so the number is not trusted
        // as the live balance (e.g. "100% left ·?").
        let suffix = isStale ? " ·?" : ""
        return "\(Int(percent.rounded()))% left\(suffix)"
    }

    var isLoading: Bool {
        !loadingProviders.isEmpty
    }

    var isInitialLoading: Bool {
        lastCheckTime == nil && isLoading
    }

    init() {
        loadAll()
        startPolling()
    }

    // force: true bypasses the usage-API throttle gate (passes --force to the
    // `usage` / `codex sync-usage` CLI paths). Only the explicit "Refresh All"
    // button forces; the 5-minute timer and post-switch reloads do NOT, so they
    // keep respecting the daemon's 429 backoff.
    func loadAll(force: Bool = false) {
        let providers = Set(ProviderID.allCases)
        DispatchQueue.main.async {
            self.loadingProviders = providers
        }

        loadClaude(force: force)
        loadCodex(force: force)
        loadKiro()
        loadWindsurf()
    }

    func switchClaude(to account: ClaudeAccount) {
        let index = claudeAccounts.firstIndex(where: { $0.id == account.id }) ?? 0
        runSwitch(args: [String(index)])
    }

    func switchCodex(to account: CodexAccount) {
        runSwitch(args: ["codex", account.key])
    }

    func switchKiro(to index: Int) {
        runSwitch(args: ["kiro", String(index)])
    }

    func addManagedCodexAccount() {
        let result = switchService.openCodexManagedLogin()
        lastSwitchMessage = result
        startCodexLoginPolling()
    }

    // Imports the browser's current claude.ai sessionKey and caches it under the
    // matching stored account (by email). Cookie-only: never touches OAuth.
    func captureClaudeBrowserSession() {
        guard !isCapturingCookie else { return }
        isCapturingCookie = true
        cookieCaptureMessage = nil
        let accounts = claudeAccounts
        let service = CookieCaptureService()
        Task { @MainActor [weak self] in
            let result = await service.capture(accounts: accounts)
            guard let self else { return }
            self.cookieCaptureMessage = result.message
            self.isCapturingCookie = false
        }
    }

    func perform(_ action: ProviderRowAction) {
        switch action {
        case let .switchClaude(key):
            guard let account = claudeAccounts.first(where: { $0.key == key }) else { return }
            switchClaude(to: account)
        case let .switchCodex(key):
            guard let account = codexAccounts.first(where: { $0.key == key }) else { return }
            switchCodex(to: account)
        case let .switchKiro(index):
            switchKiro(to: index)
        case let .toggleDisabled(provider, key, disabled):
            setAccountDisabled(provider: provider, key: key, disabled: disabled)
        case .refresh:
            // Explicit user refresh forces a fetch even while throttled.
            loadAll(force: true)
        }
    }

    private func setAccountDisabled(provider: ProviderID, key: String, disabled: Bool) {
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self else { return }
            let changed: Bool
            switch provider {
            case .claude:
                changed = self.storeService.setClaudeAccountDisabled(key: key, disabled: disabled)
            case .codex:
                changed = self.storeService.setCodexAccountDisabled(key: key, disabled: disabled)
            default:
                changed = false
            }
            DispatchQueue.main.async {
                if changed {
                    self.lastSwitchMessage = disabled
                        ? "Disabled account. Auto-switch will skip it."
                        : "Enabled account. Auto-switch can pick it again."
                } else {
                    self.lastSwitchMessage = "Could not update the stored account."
                }
                self.loadAll()
            }
        }
    }

    func startPolling() {
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: TimeInterval(refreshIntervalSeconds), repeats: true) { [weak self] _ in
            self?.loadAll()
        }
    }

    private func startCodexLoginPolling() {
        codexLoginPollingTimer?.invalidate()
        var remainingTicks = 24
        codexLoginPollingTimer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] timer in
            guard let self else {
                timer.invalidate()
                return
            }
            remainingTicks -= 1
            self.loadCodex()
            if remainingTicks <= 0 {
                timer.invalidate()
                self.codexLoginPollingTimer = nil
            }
        }
        loadCodex()
    }

    var refreshIntervalLabel: String {
        "\(refreshIntervalSeconds)s"
    }

    private func runSwitch(args: [String]) {
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self else { return }
            let result = self.switchService.run(args: args)
            DispatchQueue.main.async {
                self.lastSwitchMessage = Self.condensedSwitchMessage(from: result)
                self.loadAll()
            }
        }
    }

    /// Reduces raw CLI output (which may include the full "Stored account list:"
    /// dump and restart hints) to a concise footer status of at most two lines.
    /// Errors are preserved: SwitchService merges stderr into the same output and
    /// returns single-line "Error: ..." strings on launch failure, both of which
    /// are matched by the keyword scan or the first-non-empty-line fallback.
    private static func condensedSwitchMessage(from raw: String) -> String {
        // Drop the multi-line account dump and everything after it.
        var actionText = raw
        if let dumpRange = raw.range(of: "Stored account list:") {
            actionText = String(raw[..<dumpRange.lowerBound])
        }

        let lines = actionText
            .components(separatedBy: .newlines)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }

        let keywords = ["Switched", "Disabled", "Enabled", "Usage API throttled", "Error"]
        let summary = lines.first { line in keywords.contains { line.contains($0) } }
            ?? lines.first
            ?? ""

        guard raw.contains("Restart Claude Code"), !summary.contains("Restart Claude Code") else {
            return summary
        }
        return summary.isEmpty
            ? "Restart Claude Code to apply."
            : summary + "\nRestart Claude Code to apply."
    }

    /// Sorts account rows for display: active first, then healthy accounts by
    /// remaining quota descending (nil/unknown after known values), then
    /// needs-reauth accounts, then disabled accounts last. Ties keep store order.
    private static func sortedForDisplay<T>(
        _ accounts: [T],
        isActive: (T) -> Bool,
        remaining: (T) -> Double?,
        needsReauth: (T) -> Bool,
        isDisabled: (T) -> Bool
    ) -> [T] {
        func tier(_ account: T) -> Int {
            if isActive(account) { return 0 }
            if isDisabled(account) { return 3 }
            if needsReauth(account) { return 2 }
            return 1
        }
        return accounts.enumerated().sorted { lhs, rhs in
            let lt = tier(lhs.element)
            let rt = tier(rhs.element)
            if lt != rt { return lt < rt }
            if lt == 1 {
                let lr = remaining(lhs.element)
                let rr = remaining(rhs.element)
                switch (lr, rr) {
                case let (l?, r?) where l != r:
                    return l > r
                case (.some, .none):
                    return true
                case (.none, .some):
                    return false
                default:
                    break
                }
            }
            return lhs.offset < rhs.offset
        }.map(\.element)
    }

    // Appends a stale-data age marker ("· data 3h ago") to a row's detail text.
    private static func appendingAge(_ base: String?, _ ageText: String?) -> String? {
        guard let ageText else { return base }
        let marker = "data \(ageText)"
        guard let base, !base.isEmpty else { return marker }
        return "\(base) · \(marker)"
    }

    private func buildClaudeSection() -> ProviderSectionSnapshot {
        let visibleAccounts = showInactiveAccounts ? claudeAccounts : claudeAccounts.filter { $0.matchesActiveKey(activeClaudeKey) }
        let accounts = Self.sortedForDisplay(
            visibleAccounts,
            isActive: { $0.matchesActiveKey(self.activeClaudeKey) },
            remaining: { $0.lowestRemainingPercent },
            needsReauth: { $0.needsReauth },
            isDisabled: { $0.isDisabled }
        )
        return ProviderSectionSnapshot(
            id: .claude,
            rows: accounts.map { account in
                // Cookie expiry is a COOKIE failure, not an OAuth failure: it
                // shows a distinct orange "Cookie expired — re-import" status
                // (vs the red "Re-login" reauth state) and KEEPS the last
                // snapshot's metrics. needsReauth takes precedence if both set.
                let cookieExpired = !account.needsReauth && cookieExpiredClaudeKeys.contains(account.key)
                return ProviderRowSnapshot(
                    id: account.id,
                    title: account.displayName,
                    secondaryTexts: [account.metadata?.planType].compactMap { $0 },
                    detailText: Self.appendingAge(showResetTimes ? account.resetSummary : nil, account.usageIsStale ? account.snapshotAgeText : nil),
                    detailLines: [],
                    statusText: account.needsReauth ? "Re-login" : (cookieExpired ? "Cookie expired — re-import" : (account.isDisabled ? "Disabled" : nil)),
                    statusColorName: account.needsReauth ? "red" : (cookieExpired ? "orange" : nil),
                    metrics: account.needsReauth ? [] : [
                        ProviderMetric(id: "\(account.id)-5h", label: "5h", value: account.fiveHourUsed, style: .utilization, isStale: account.usageIsStale),
                        ProviderMetric(id: "\(account.id)-7d", label: "7d", value: account.sevenDayUsed, style: .utilization, isStale: account.usageIsStale),
                    ],
                    isActive: account.matchesActiveKey(activeClaudeKey),
                    isDisabled: account.isDisabled,
                    action: account.matchesActiveKey(activeClaudeKey) ? nil : .switchClaude(key: account.key),
                    secondaryAction: .toggleDisabled(provider: .claude, key: account.key, disabled: !account.isDisabled)
                )
            },
            emptyMessage: "No accounts",
            isLoading: loadingProviders.contains(.claude)
        )
    }

    private func buildCodexSection() -> ProviderSectionSnapshot {
        let accounts = Self.sortedForDisplay(
            codexAccounts,
            isActive: { $0.matchesActiveKey(self.activeCodexKey) },
            remaining: { $0.lowestRemainingPercent },
            needsReauth: { _ in false },
            isDisabled: { $0.isDisabled }
        )
        return ProviderSectionSnapshot(
            id: .codex,
            rows: accounts.map { account in
                return ProviderRowSnapshot(
                    id: account.id,
                    title: account.label,
                    secondaryTexts: [],
                    detailText: Self.appendingAge(showResetTimes ? account.resetSummary : nil, account.usageIsStale ? account.snapshotAgeText : nil),
                    detailLines: account.switchable == false
                        ? ["Auto-detected workspace from saved Codex token"]
                        : [],
                    statusText: account.isDisabled ? "Disabled" : nil,
                    statusColorName: nil,
                    metrics: [
                        account.fiveHourUsed.map {
                            ProviderMetric(id: "\(account.id)-5h", label: "5h", value: $0, style: .utilization, isStale: account.usageIsStale)
                        },
                        account.sevenDayUsed.map {
                            ProviderMetric(id: "\(account.id)-7d", label: "7d", value: $0, style: .utilization, isStale: account.usageIsStale)
                        },
                    ].compactMap { $0 },
                    isActive: account.matchesActiveKey(activeCodexKey),
                    isDisabled: account.isDisabled,
                    action: account.matchesActiveKey(activeCodexKey) || account.switchable == false ? nil : .switchCodex(key: account.key),
                    secondaryAction: .toggleDisabled(provider: .codex, key: account.key, disabled: !account.isDisabled)
                )
            },
            emptyMessage: "No saved Codex token. Run codex login, then refresh.",
            isLoading: loadingProviders.contains(.codex)
        )
    }

    private func buildKiroSection() -> ProviderSectionSnapshot {
        let accounts = showInactiveAccounts ? kiroAccounts : kiroAccounts.filter { $0.key == activeKiroKey }
        return ProviderSectionSnapshot(
            id: .kiro,
            rows: accounts.enumerated().map { offset, account in
                let index = kiroAccounts.firstIndex(where: { $0.id == account.id }) ?? offset
                return ProviderRowSnapshot(
                    id: account.id,
                    title: account.label,
                    secondaryTexts: [account.auth?.provider].compactMap { $0 },
                    detailText: nil,
                    detailLines: [],
                    statusText: account.isExpired ? "expired" : nil,
                    statusColorName: account.isExpired ? "red" : nil,
                    metrics: [],
                    isActive: account.key == activeKiroKey,
                    action: account.key == activeKiroKey ? nil : .switchKiro(index: index)
                )
            },
            emptyMessage: "No accounts",
            isLoading: loadingProviders.contains(.kiro)
        )
    }

    private func buildWindsurfSection() -> ProviderSectionSnapshot {
        ProviderSectionSnapshot(
            id: .windsurf,
            rows: windsurfAccounts.map { account in
                ProviderRowSnapshot(
                    id: account.id,
                    title: account.displayName,
                    secondaryTexts: [account.planLabel, account.billingLabel].compactMap { $0 },
                    detailText: nil,
                    detailLines: showResetTimes
                        ? [account.resetSummary].compactMap { $0 }
                        : [],
                    statusText: nil,
                    statusColorName: nil,
                    metrics: [
                        account.dailyUsagePercent.map {
                            ProviderMetric(id: "\(account.id)-day", label: "day", value: $0, style: .utilization)
                        },
                        account.weeklyUsagePercent.map {
                            ProviderMetric(id: "\(account.id)-wk", label: "wk", value: $0, style: .utilization)
                        },
                    ].compactMap { $0 },
                    isActive: account.key == activeWindsurfKey,
                    action: .refresh
                )
            },
            emptyMessage: "No quota data",
            isLoading: false
        )
    }

    private func loadClaude(force: Bool = false) {
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self else { return }
            if self.autoSyncClaudeUsage {
                // The Node `usage` refresh now SKIPS cookie-backed non-active
                // accounts (it won't touch their rotating OAuth token); the
                // cookie pass below populates their usage via the web API.
                _ = self.switchService.run(args: force ? ["usage", "--force"] : ["usage"])
            }
            let store = self.storeService.loadClaudeStore()
            let activeKey = self.storeService.detectActiveClaudeKey()
            var accounts = Self.deduplicatedClaudeAccounts(store.accounts, preferredKey: activeKey)

            // Cookie/web-usage pass for non-active accounts (macOS Firefox path).
            // Rate-limited to once per cookieRefreshMinInterval unless forced.
            let runCookieRefresh = self.autoSyncClaudeUsage && (force || self.shouldRunCookieRefresh())
            var cookieOutcome = CookieUsageRefreshService.Outcome.empty
            if runCookieRefresh {
                let snapshotAccounts = accounts
                let refresher = self.cookieUsageRefresher
                let semaphore = DispatchSemaphore(value: 0)
                Task {
                    cookieOutcome = await refresher.refresh(accounts: snapshotAccounts, activeKey: activeKey)
                    semaphore.signal()
                }
                semaphore.wait()
                accounts = Self.applyingCookieSnapshots(accounts, cookieOutcome.updated)
            }

            DispatchQueue.main.async {
                self.claudeAccounts = accounts
                self.activeClaudeKey = activeKey
                if runCookieRefresh {
                    self.lastCookieUsageRefreshAt = Date()
                    var expired = self.cookieExpiredClaudeKeys
                    // A successful refresh clears any prior expired flag; a fresh
                    // 401/403 sets it. Both keep the last snapshot on screen.
                    for item in cookieOutcome.updated { expired.remove(item.key) }
                    expired.formUnion(cookieOutcome.cookieExpiredKeys)
                    // Drop flags for accounts that no longer exist.
                    let liveKeys = Set(accounts.map(\.key))
                    self.cookieExpiredClaudeKeys = expired.intersection(liveKeys)
                }
                self.finishLoading(.claude)
            }
        }
    }

    private func shouldRunCookieRefresh(now: Date = Date()) -> Bool {
        guard let last = lastCookieUsageRefreshAt else { return true }
        return now.timeIntervalSince(last) >= Self.cookieRefreshMinInterval
    }

    private func loadCodex(force: Bool = false) {
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self else { return }
            if self.autoSyncCodexUsage {
                _ = self.switchService.run(args: force ? ["codex", "sync-usage", "--force"] : ["codex", "sync-usage"])
            }
            let store = self.storeService.loadCodexStore()
            let activeKey = self.storeService.detectActiveCodexKey()
            let expandedAccounts = store.accounts.flatMap { $0.workspaceVariants }
            let deduplicatedAccounts = Self.deduplicatedCodexAccounts(expandedAccounts, preferredKey: activeKey)
            DispatchQueue.main.async {
                self.codexAccounts = deduplicatedAccounts
                self.activeCodexKey = activeKey
                self.finishLoading(.codex)
            }
        }
    }

    private func loadKiro() {
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self else { return }
            if self.autoSyncKiroAccounts {
                _ = self.switchService.run(args: ["kiro", "sync"])
            }
            if self.autoRefreshExpiredKiro {
                _ = self.switchService.run(args: ["kiro", "refresh-expired"])
            }
            let store = self.storeService.loadKiroStore()
            DispatchQueue.main.async {
                self.kiroAccounts = store.accounts
                self.activeKiroKey = store.activeKey
                self.finishLoading(.kiro)
            }
        }
    }

    private func loadWindsurf() {
        windsurfLoadGeneration += 1
        let generation = windsurfLoadGeneration

        DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) { [weak self] in
            guard let self else { return }
            guard generation == self.windsurfLoadGeneration else { return }
            guard self.loadingProviders.contains(.windsurf) else { return }
            self.windsurfAccounts = []
            self.activeWindsurfKey = nil
            self.finishLoading(.windsurf)
        }

        DispatchQueue.global(qos: .utility).async { [weak self] in
            guard let self else { return }
            let store = self.storeService.loadWindsurfStore()
            DispatchQueue.main.async {
                guard generation == self.windsurfLoadGeneration else { return }
                self.windsurfAccounts = store.accounts
                self.activeWindsurfKey = store.activeKey ?? store.accounts.first?.key
                self.finishLoading(.windsurf)
            }
        }
    }

    private func finishLoading(_ provider: ProviderID) {
        loadingProviders.remove(provider)
        lastCheckTime = Date()
    }
}

private extension AppState {
    // Overlays cookie-sourced snapshots onto the matching in-memory accounts so
    // the menu shows the fresh web-API usage immediately (the Node store write
    // happens in parallel via the CLI seam).
    static func applyingCookieSnapshots(
        _ accounts: [ClaudeAccount],
        _ updates: [(key: String, snapshot: UsageSnapshot)]
    ) -> [ClaudeAccount] {
        guard !updates.isEmpty else { return accounts }
        let snapshotsByKey = Dictionary(updates.map { ($0.key, $0.snapshot) }, uniquingKeysWith: { _, new in new })
        return accounts.map { account in
            guard let snapshot = snapshotsByKey[account.key] else { return account }
            return account.withUsageSnapshot(snapshot)
        }
    }

    static func deduplicatedClaudeAccounts(_ accounts: [ClaudeAccount], preferredKey: String?) -> [ClaudeAccount] {
        var groupedAccounts: [String: [ClaudeAccount]] = [:]
        var groupOrder: [String] = []

        for account in accounts {
            let groupKey = account.credentialFingerprint.map { "\($0):\(account.scopeKey)" } ?? "key:\(account.canonicalKey)"
            if groupedAccounts[groupKey] == nil {
                groupOrder.append(groupKey)
                groupedAccounts[groupKey] = []
            }
            groupedAccounts[groupKey, default: []].append(account)
        }

        return groupOrder.compactMap { groupKey in
            guard let group = groupedAccounts[groupKey], let first = group.first else {
                return nil
            }
            if let preferredKey, let preferred = group.first(where: { $0.matchesActiveKey(preferredKey) }) {
                return preferred
            }
            return first
        }
    }

    static func deduplicatedCodexAccounts(_ accounts: [CodexAccount], preferredKey: String?) -> [CodexAccount] {
        var groupedAccounts: [String: [CodexAccount]] = [:]
        var groupOrder: [String] = []

        for account in accounts {
            let groupKey = account.credentialFingerprint.map { "\($0):\(account.scopeKey)" } ?? "key:\(account.canonicalKey)"
            if groupedAccounts[groupKey] == nil {
                groupOrder.append(groupKey)
                groupedAccounts[groupKey] = []
            }
            groupedAccounts[groupKey, default: []].append(account)
        }

        return groupOrder.compactMap { groupKey in
            guard let group = groupedAccounts[groupKey], let first = group.first else {
                return nil
            }
            if let preferredKey, let preferred = group.first(where: { $0.matchesActiveKey(preferredKey) }) {
                return preferred
            }
            return first
        }
    }
}

private extension ClaudeAccount {
    func matchesActiveKey(_ activeKey: String?) -> Bool {
        guard let activeKey else { return false }
        return key == activeKey || canonicalKey == activeKey
    }

    // Returns a copy with a replaced usage snapshot (ClaudeAccount's stored
    // properties are immutable, so the cookie pass rebuilds the value).
    func withUsageSnapshot(_ snapshot: UsageSnapshot) -> ClaudeAccount {
        ClaudeAccount(
            key: key,
            metadata: metadata,
            credentials: credentials,
            capturedAt: capturedAt,
            lastUsedAt: lastUsedAt,
            usageSnapshot: snapshot,
            disabled: disabled,
            credentialStatus: credentialStatus
        )
    }
}

private extension CodexAccount {
    func matchesActiveKey(_ activeKey: String?) -> Bool {
        guard let activeKey else { return false }
        return key == activeKey || canonicalKey == activeKey
    }
}
