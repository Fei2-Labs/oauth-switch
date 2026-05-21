import Foundation
import Combine

class AppState: ObservableObject {
    @Published var claudeAccounts: [ClaudeAccount] = []
    @Published var codexAccounts: [CodexAccount] = []
    @Published var activeClaudeKey: String?
    @Published var activeCodexKey: String?
    @Published var autoSwitchEnabled: Bool = true
    @Published var trigger5h: Double = 80
    @Published var trigger7d: Double = 90
    @Published var lastCheckTime: Date?
    @Published var lastSwitchMessage: String?

    private var timer: Timer?
    private let storeService = StoreService()
    private let switchService = SwitchService()

    var menuBarIcon: String {
        let claudeHigh = claudeAccounts
            .first { $0.key == activeClaudeKey }
            .map { $0.fiveHourUsed >= trigger5h || $0.sevenDayUsed >= trigger7d } ?? false
        return claudeHigh ? "exclamationmark.arrow.trianglehead.2.clockwise.rotate.90" : "arrow.trianglehead.2.clockwise.rotate.90"
    }

    init() {
        loadAll()
        startPolling()
    }

    func loadAll() {
        let claude = storeService.loadClaudeStore()
        claudeAccounts = claude.accounts
        activeClaudeKey = storeService.detectActiveClaudeKey()

        let codex = storeService.loadCodexStore()
        codexAccounts = codex.accounts
        activeCodexKey = storeService.detectActiveCodexKey()

        lastCheckTime = Date()
    }

    func switchClaude(to account: ClaudeAccount) {
        let result = switchService.run(args: [account.key.contains("uuid:")
            ? String(claudeAccounts.firstIndex(where: { $0.key == account.key }) ?? 0)
            : String(claudeAccounts.firstIndex(where: { $0.key == account.key }) ?? 0)])
        lastSwitchMessage = result
        loadAll()
    }

    func switchCodex(to index: Int) {
        let result = switchService.run(args: ["codex", String(index)])
        lastSwitchMessage = result
        loadAll()
    }

    func runAutoCheck() {
        let result = switchService.run(args: ["auto"])
        lastSwitchMessage = result
        loadAll()
    }

    func startPolling() {
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] _ in
            self?.loadAll()
        }
    }
}
