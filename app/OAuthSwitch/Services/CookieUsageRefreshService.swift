import Foundation

// Refreshes NON-active Claude accounts' usage via the claude.ai cookie/web API
// (URLSession) instead of refreshing their ROTATING OAuth token. For each
// non-active account that has a cached browser cookie, it fetches usage and:
//
// - .ok        -> records the fresh snapshot (for immediate in-memory display)
//                 and persists it to the store via the Node CLI single-writer
//                 seam (`oas claude set-usage-snapshot`). Clears any prior
//                 cookie-expired flag.
// - .cookieExpired (401/403) -> flags the account so the menu can show a
//                 DISTINCT "Cookie expired — re-import" state. The last stored
//                 snapshot is kept. NEVER marks the OAuth credential
//                 reauth_required and never touches OAuth at all (PRD req 6).
// - .throttled / .failed -> keep the last snapshot, skip this cycle.
//
// Fetches are serialized (one claude.ai request at a time) by the sequential
// await loop; the >=15min cadence gate lives in AppState.
struct CookieUsageRefreshService {
    typealias CookieLoader = () -> [String: CachedCookie]
    typealias UsageFetcher = (_ sessionKey: String, _ orgId: String) async -> ClaudeWebResult<UsageSnapshot>
    typealias SnapshotPersister = (_ accountKey: String, _ snapshot: UsageSnapshot) -> Void

    // Result of one refresh pass. `updated` carries the fresh snapshots keyed by
    // store account key (for immediate display); `cookieExpiredKeys` are the
    // accounts whose cookie was rejected this pass.
    struct Outcome {
        var updated: [(key: String, snapshot: UsageSnapshot)]
        var cookieExpiredKeys: Set<String>

        static let empty = Outcome(updated: [], cookieExpiredKeys: [])
    }

    private let loadCookies: CookieLoader
    private let fetchUsage: UsageFetcher
    private let persist: SnapshotPersister

    init(
        loadCookies: @escaping CookieLoader = { CookieCacheService().load() },
        fetchUsage: @escaping UsageFetcher = { sessionKey, orgId in
            await ClaudeWebUsageService().fetchUsage(sessionKey: sessionKey, orgId: orgId)
        },
        persist: @escaping SnapshotPersister = CookieUsageRefreshService.persistViaCLI
    ) {
        self.loadCookies = loadCookies
        self.fetchUsage = fetchUsage
        self.persist = persist
    }

    func refresh(accounts: [ClaudeAccount], activeKey: String?) async -> Outcome {
        let cookies = loadCookies()
        guard !cookies.isEmpty else { return .empty }

        var updated: [(key: String, snapshot: UsageSnapshot)] = []
        var expired: Set<String> = []

        for account in accounts {
            // The active account keeps the OAuth path (synced from live every
            // cycle); never serve it from the cookie cache.
            if isActive(account, activeKey: activeKey) { continue }
            guard let cookie = cookies[account.key] else { continue }
            // Prefer the org captured with the cookie; fall back to the store
            // account's known organization UUID.
            guard let orgId = nonEmpty(cookie.orgId) ?? nonEmpty(account.metadata?.organizationUuid) else {
                continue
            }

            switch await fetchUsage(cookie.sessionKey, orgId) {
            case let .ok(snapshot):
                updated.append((account.key, snapshot))
                persist(account.key, snapshot)
            case .cookieExpired:
                expired.insert(account.key)
            case .throttled, .failed:
                continue
            }
        }

        return Outcome(updated: updated, cookieExpiredKeys: expired)
    }

    private func isActive(_ account: ClaudeAccount, activeKey: String?) -> Bool {
        guard let activeKey else { return false }
        return account.key == activeKey || account.canonicalKey == activeKey
    }

    private func nonEmpty(_ value: String?) -> String? {
        guard let value else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    // SINGLE WRITER: the app never writes the store JSON directly. It writes the
    // snapshot to a temp file (avoids arg-escaping) and shells the Node CLI,
    // which performs the store mutation under withStoreLock('claude-store').
    static func persistViaCLI(accountKey: String, snapshot: UsageSnapshot) {
        guard let data = try? JSONEncoder().encode(snapshot) else { return }
        let tempPath = NSTemporaryDirectory() + "oauthswitch-usage-" + UUID().uuidString + ".json"
        let url = URL(fileURLWithPath: tempPath)
        guard (try? data.write(to: url)) != nil else { return }
        defer { try? FileManager.default.removeItem(at: url) }
        _ = SwitchService().run(args: [
            "claude", "set-usage-snapshot",
            "--key", accountKey,
            "--snapshot-file", tempPath,
        ])
    }
}
