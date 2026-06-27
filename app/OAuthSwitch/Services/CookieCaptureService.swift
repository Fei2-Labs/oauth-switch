import Foundation

// Outcome of a "capture current browser Claude session" attempt. Every case is
// safe to show verbatim in the Settings footer via `message`.
//
// CRITICAL: none of these failures is an OAuth failure. A cookie/browser problem
// here NEVER marks an OAuth credential `reauth_required` (PRD requirement 6) —
// the capture path only ever touches the cookie cache, never the OAuth store.
enum CookieCaptureResult: Equatable {
    // Imported, attributed to a store account, and cached.
    case captured(email: String, accountKey: String)
    // No claude.ai sessionKey in the browser at all (not logged in).
    case noBrowserSession
    // The browser sessionKey is present but rejected by claude.ai (401/403).
    case sessionExpired
    // claude.ai is rate-limiting (429).
    case throttled
    // Any other non-success HTTP status from /account.
    case fetchFailed(statusCode: Int)
    // 200 but no usable email to attribute the session.
    case missingAccountInfo
    // Imported a valid session, but its email matches no stored account.
    case unmatched(email: String)
    // Attributed to an account, but persisting the cookie cache failed.
    case cacheWriteFailed(email: String)

    var isSuccess: Bool {
        if case .captured = self { return true }
        return false
    }

    var message: String {
        switch self {
        case let .captured(email, _):
            return "Captured claude.ai session for \(email)."
        case .noBrowserSession:
            return "No claude.ai session found in Firefox — log in to claude.ai first."
        case .sessionExpired:
            return "Browser session expired — re-login to claude.ai in your browser."
        case .throttled:
            return "claude.ai is rate-limiting requests — try again in a few minutes."
        case let .fetchFailed(statusCode):
            return "Could not read the claude.ai account (HTTP \(statusCode))."
        case .missingAccountInfo:
            return "claude.ai returned no account email; cannot attribute the session."
        case let .unmatched(email):
            return "Captured session for \(email) doesn't match any stored account; not saved."
        case let .cacheWriteFailed(email):
            return "Matched \(email) but could not write the cookie cache; not saved."
        }
    }
}

// Imports the browser's current claude.ai `sessionKey`, attributes it to a
// stored OAuth-Switch account by email, and caches it per account.
//
// The browser reader and the /account fetch are injected so the attribution
// logic is unit-testable without a browser or the network.
struct CookieCaptureService {
    typealias SessionKeyReader = () -> String?
    typealias AccountFetcher = (_ sessionKey: String) async -> ClaudeWebResult<ClaudeWebAccount>

    private let readSessionKey: SessionKeyReader
    private let fetchAccount: AccountFetcher
    private let cache: CookieCacheService
    private let now: () -> Date

    init(
        readSessionKey: @escaping SessionKeyReader = { BrowserCookieService().readClaudeSessionKey() },
        fetchAccount: @escaping AccountFetcher = { sessionKey in
            await ClaudeWebUsageService().fetchAccount(sessionKey: sessionKey)
        },
        cache: CookieCacheService = CookieCacheService(),
        now: @escaping () -> Date = Date.init
    ) {
        self.readSessionKey = readSessionKey
        self.fetchAccount = fetchAccount
        self.cache = cache
        self.now = now
    }

    // Reads the browser session, attributes it to one of `accounts`, and caches
    // it on a match. On any failure (no session / expired / throttled / no match)
    // nothing is cached and the OAuth store is untouched.
    func capture(accounts: [ClaudeAccount]) async -> CookieCaptureResult {
        guard let sessionKey = readSessionKey() else {
            return .noBrowserSession
        }

        let account: ClaudeWebAccount
        switch await fetchAccount(sessionKey) {
        case let .ok(value):
            account = value
        case .cookieExpired:
            return .sessionExpired
        case .throttled:
            return .throttled
        case let .failed(statusCode):
            return .fetchFailed(statusCode: statusCode)
        }

        guard let email = normalized(account.email_address) else {
            return .missingAccountInfo
        }

        guard let matched = accounts.first(where: { normalized($0.metadata?.emailAddress) == email }) else {
            return .unmatched(email: account.email_address ?? email)
        }

        let cookie = CachedCookie(
            sessionKey: sessionKey,
            email: account.email_address ?? email,
            orgId: resolveOrgId(for: matched, from: account),
            capturedAt: ISO8601DateFormatter().string(from: now())
        )
        guard cache.set(accountKey: matched.key, cookie) else {
            return .cacheWriteFailed(email: cookie.email ?? email)
        }
        return .captured(email: cookie.email ?? email, accountKey: matched.key)
    }

    // Prefer the membership org that matches the store account's known
    // organizationUuid; otherwise fall back to the first membership org uuid.
    private func resolveOrgId(for storeAccount: ClaudeAccount, from account: ClaudeWebAccount) -> String? {
        let orgUuids = (account.memberships ?? []).compactMap { $0.organization?.uuid }
        if let preferred = normalized(storeAccount.metadata?.organizationUuid),
           let match = orgUuids.first(where: { normalized($0) == preferred }) {
            return match
        }
        return orgUuids.first
    }

    private func normalized(_ value: String?) -> String? {
        guard let value else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return trimmed.isEmpty ? nil : trimmed
    }
}
