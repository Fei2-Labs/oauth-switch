import Foundation

// Minimal HTTP seam so tests can inject canned responses without hitting the
// network. URLSession conforms out of the box.
protocol ClaudeWebHTTPClient {
    func data(for request: URLRequest) async throws -> (Data, URLResponse)
}

extension URLSession: ClaudeWebHTTPClient {}

// Outcome of a claude.ai web request.
//
// `.cookieExpired` (HTTP 401/403) maps to the future "cookie expired /
// re-import" UI state. It is a COOKIE failure, never an OAuth failure: callers
// MUST NOT translate it into a `reauth_required` marking on the OAuth
// credential (PRD requirement 6).
enum ClaudeWebResult<Value> {
    case ok(Value)
    case cookieExpired
    case throttled(retryAfter: TimeInterval?)
    case failed(statusCode: Int)
}

// Organization entry from GET /api/organizations.
struct ClaudeWebOrganization: Decodable, Equatable {
    let uuid: String
    let name: String?
    let capabilities: [String]?
}

// Account info from GET /api/account (for cookie -> store-account attribution).
struct ClaudeWebAccount: Decodable, Equatable {
    let email_address: String?
    let memberships: [Membership]?

    struct Membership: Decodable, Equatable {
        let organization: Organization?

        struct Organization: Decodable, Equatable {
            let uuid: String?
        }
    }
}

// Reads claude.ai account usage via the cookie/session web API.
//
// Validated live (2026-06-27): claude.ai sits behind Cloudflare's
// TLS/JS-fingerprint wall — plain Node/curl get 403, but macOS URLSession with
// its DEFAULT User-Agent passes. So this lives in the Swift app, not the Node
// CLI. The only request headers are `Cookie: sessionKey=<value>` (single cookie
// only — sending the full jar yields account_session_invalid) and
// `Accept: application/json`.
struct ClaudeWebUsageService {
    private let client: ClaudeWebHTTPClient
    private let baseURL: String

    init(
        client: ClaudeWebHTTPClient = URLSession.shared,
        baseURL: String = "https://claude.ai/api"
    ) {
        self.client = client
        self.baseURL = baseURL
    }

    // GET /organizations/{orgId}/usage -> UsageSnapshot (five_hour / seven_day).
    func fetchUsage(sessionKey: String, orgId: String) async -> ClaudeWebResult<UsageSnapshot> {
        await request(path: "/organizations/\(orgId)/usage", sessionKey: sessionKey) { data in
            ClaudeWebUsageService.parseUsage(data)
        }
    }

    // GET /organizations -> [ClaudeWebOrganization].
    func fetchOrganizations(sessionKey: String) async -> ClaudeWebResult<[ClaudeWebOrganization]> {
        await request(path: "/organizations", sessionKey: sessionKey) { data in
            try? JSONDecoder().decode([ClaudeWebOrganization].self, from: data)
        }
    }

    // GET /account -> ClaudeWebAccount.
    func fetchAccount(sessionKey: String) async -> ClaudeWebResult<ClaudeWebAccount> {
        await request(path: "/account", sessionKey: sessionKey) { data in
            try? JSONDecoder().decode(ClaudeWebAccount.self, from: data)
        }
    }

    // Maps the /usage JSON to the app's existing UsageSnapshot.
    //
    // - `utilization` is a Float in the wild (e.g. 62.0); decode as a Number.
    // - `resets_at` is kept as the raw ISO string (Account.swift parses it,
    //   tolerating the microsecond + `+00:00` form).
    // - A null/absent window is omitted (nil), not an error.
    // - Model windows / extra_usage / limits / spend are ignored (no model split).
    static func parseUsage(_ data: Data) -> UsageSnapshot? {
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return nil
        }

        func window(_ key: String) -> UsageSnapshot.Window? {
            // A JSON null decodes to NSNull (not [String: Any]) -> omitted.
            guard let object = json[key] as? [String: Any] else { return nil }
            let utilization = (object["utilization"] as? NSNumber)?.doubleValue
            let resetsAt = object["resets_at"] as? String
            return UsageSnapshot.Window(utilization: utilization, resets_at: resetsAt)
        }

        return UsageSnapshot(
            five_hour: window("five_hour"),
            seven_day: window("seven_day"),
            fetchedAt: ISO8601DateFormatter().string(from: Date())
        )
    }

    private func request<Value>(
        path: String,
        sessionKey: String,
        parse: @escaping (Data) -> Value?
    ) async -> ClaudeWebResult<Value> {
        guard let url = URL(string: baseURL + path) else {
            return .failed(statusCode: -1)
        }

        var urlRequest = URLRequest(url: url)
        urlRequest.httpMethod = "GET"
        // Single cookie ONLY — sending the full browser jar is rejected
        // (validated: full jar -> account_session_invalid). Disable URLSession's
        // automatic cookie handling so it can't merge any claude.ai cookies
        // already in the process HTTPCookieStorage (e.g. cf_clearance/__cf_bm)
        // into this request alongside the manual header.
        urlRequest.httpShouldHandleCookies = false
        urlRequest.setValue("sessionKey=\(sessionKey)", forHTTPHeaderField: "Cookie")
        urlRequest.setValue("application/json", forHTTPHeaderField: "Accept")

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await client.data(for: urlRequest)
        } catch {
            return .failed(statusCode: -1)
        }

        guard let http = response as? HTTPURLResponse else {
            return .failed(statusCode: -1)
        }

        switch http.statusCode {
        case 200 ... 299:
            guard let value = parse(data) else {
                return .failed(statusCode: http.statusCode)
            }
            return .ok(value)
        case 401, 403:
            return .cookieExpired
        case 429:
            let retryAfter = http.value(forHTTPHeaderField: "Retry-After").flatMap(TimeInterval.init)
            return .throttled(retryAfter: retryAfter)
        default:
            return .failed(statusCode: http.statusCode)
        }
    }
}
