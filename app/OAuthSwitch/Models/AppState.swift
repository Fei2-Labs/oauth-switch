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
        switch menuBarBalanceSource {
        case .off:
            return nil
        case .claude:
            percent = claudeAccounts.first(where: { $0.matchesActiveKey(activeClaudeKey) })?.lowestRemainingPercent
        case .codex:
            percent = codexAccounts.first(where: { $0.matchesActiveKey(activeCodexKey) })?.lowestRemainingPercent
        case .windsurf:
            percent = windsurfAccounts.first(where: { $0.key == activeWindsurfKey })?.lowestRemainingPercent
        }

        guard let percent, !percent.isNaN else { return nil }
        return "\(Int(percent.rounded()))%"
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

    func loadAll() {
        let providers = Set(ProviderID.allCases)
        DispatchQueue.main.async {
            self.loadingProviders = providers
        }

        loadClaude()
        loadCodex()
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
            loadAll()
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
                self.lastSwitchMessage = result
                self.loadAll()
            }
        }
    }

    private func buildClaudeSection() -> ProviderSectionSnapshot {
        let accounts = showInactiveAccounts ? claudeAccounts : claudeAccounts.filter { $0.matchesActiveKey(activeClaudeKey) }
        return ProviderSectionSnapshot(
            id: .claude,
            rows: accounts.map { account in
                ProviderRowSnapshot(
                    id: account.id,
                    title: account.displayName,
                    secondaryTexts: [account.metadata?.planType].compactMap { $0 },
                    detailText: showResetTimes ? account.resetSummary : nil,
                    detailLines: [],
                    statusText: account.isDisabled ? "Disabled" : nil,
                    statusColorName: nil,
                    metrics: [
                        ProviderMetric(id: "\(account.id)-5h", label: "5h", value: account.fiveHourUsed, style: .utilization),
                        ProviderMetric(id: "\(account.id)-7d", label: "7d", value: account.sevenDayUsed, style: .utilization),
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
        return ProviderSectionSnapshot(
            id: .codex,
            rows: codexAccounts.map { account in
                return ProviderRowSnapshot(
                    id: account.id,
                    title: account.label,
                    secondaryTexts: [],
                    detailText: showResetTimes ? account.resetSummary : nil,
                    detailLines: account.switchable == false
                        ? ["Auto-detected workspace from saved Codex token"]
                        : [],
                    statusText: account.isDisabled ? "Disabled" : nil,
                    statusColorName: nil,
                    metrics: [
                        account.fiveHourUsed.map {
                            ProviderMetric(id: "\(account.id)-5h", label: "5h", value: $0, style: .utilization)
                        },
                        account.sevenDayUsed.map {
                            ProviderMetric(id: "\(account.id)-7d", label: "7d", value: $0, style: .utilization)
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

    private func loadClaude() {
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self else { return }
            if self.autoSyncClaudeUsage {
                _ = self.switchService.run(args: ["usage"])
            }
            let store = self.storeService.loadClaudeStore()
            let activeKey = self.storeService.detectActiveClaudeKey()
            let deduplicatedAccounts = Self.deduplicatedClaudeAccounts(store.accounts, preferredKey: activeKey)
            DispatchQueue.main.async {
                self.claudeAccounts = deduplicatedAccounts
                self.activeClaudeKey = activeKey
                self.finishLoading(.claude)
            }
        }
    }

    private func loadCodex() {
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self else { return }
            if self.autoSyncCodexUsage {
                _ = self.switchService.run(args: ["codex", "sync-usage"])
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
}

private extension CodexAccount {
    func matchesActiveKey(_ activeKey: String?) -> Bool {
        guard let activeKey else { return false }
        return key == activeKey || canonicalKey == activeKey
    }
}
