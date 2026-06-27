import XCTest
@testable import OAuthSwitch

final class ClaudeWebUsageServiceTests: XCTestCase {
    // MARK: - Helpers

    private func loadFixture(_ name: String) throws -> Data {
        guard let url = Bundle.module.url(forResource: name, withExtension: "json", subdirectory: "Fixtures")
            ?? Bundle.module.url(forResource: name, withExtension: "json") else {
            throw XCTSkip("Missing fixture \(name).json")
        }
        return try Data(contentsOf: url)
    }

    private func makeService(stub: StubHTTPClient) -> ClaudeWebUsageService {
        ClaudeWebUsageService(client: stub, baseURL: "https://example.test/api")
    }

    // MARK: - Usage mapping

    func testUsageMappingFromLiveFixture() async throws {
        let data = try loadFixture("usage")
        let stub = StubHTTPClient(statusCode: 200, data: data)
        let service = makeService(stub: stub)

        let result = await service.fetchUsage(sessionKey: "sk-ant-test", orgId: "org-123")

        guard case let .ok(snapshot) = result else {
            return XCTFail("Expected .ok, got \(result)")
        }
        XCTAssertEqual(snapshot.five_hour?.utilization, 62.0)
        XCTAssertEqual(snapshot.five_hour?.resets_at, "2026-06-27T17:30:00.363776+00:00")
        XCTAssertEqual(snapshot.seven_day?.utilization, 33.0)
        XCTAssertEqual(snapshot.seven_day?.resets_at, "2026-07-01T03:00:00.363799+00:00")
        XCTAssertNotNil(snapshot.fetchedAt)
        // Sent ONLY the single sessionKey cookie + Accept header.
        XCTAssertEqual(stub.lastRequest?.value(forHTTPHeaderField: "Cookie"), "sessionKey=sk-ant-test")
        XCTAssertEqual(stub.lastRequest?.value(forHTTPHeaderField: "Accept"), "application/json")
        // Automatic cookie handling MUST be off so URLSession can't merge stored
        // claude.ai cookies (cf_clearance/__cf_bm) into the full-jar form that
        // claude.ai rejects with account_session_invalid.
        XCTAssertEqual(stub.lastRequest?.httpShouldHandleCookies, false)
        XCTAssertEqual(stub.lastRequest?.url?.absoluteString, "https://example.test/api/organizations/org-123/usage")
    }

    func testUsageMappingOmitsNullFiveHourWindow() async throws {
        let data = try loadFixture("usage-null-five-hour")
        let stub = StubHTTPClient(statusCode: 200, data: data)
        let service = makeService(stub: stub)

        let result = await service.fetchUsage(sessionKey: "sk-ant-test", orgId: "org-123")

        guard case let .ok(snapshot) = result else {
            return XCTFail("Expected .ok, got \(result)")
        }
        XCTAssertNil(snapshot.five_hour, "null five_hour must be omitted, not an error")
        XCTAssertEqual(snapshot.seven_day?.utilization, 33.0)
    }

    func testUsageIgnoresModelWindows() async throws {
        let data = try loadFixture("usage")
        let snapshot = ClaudeWebUsageService.parseUsage(data)
        XCTAssertNotNil(snapshot)
        // UsageSnapshot has no storage for model windows by construction; this
        // documents that only five_hour/seven_day survive the mapping.
        XCTAssertEqual(snapshot?.five_hour?.utilization, 62.0)
        XCTAssertEqual(snapshot?.seven_day?.utilization, 33.0)
    }

    // MARK: - Status-code handling

    func testUnauthorizedMapsToCookieExpired() async {
        for status in [401, 403] {
            let stub = StubHTTPClient(statusCode: status, data: Data())
            let service = makeService(stub: stub)
            let result = await service.fetchUsage(sessionKey: "sk-ant-test", orgId: "org-123")
            guard case .cookieExpired = result else {
                XCTFail("status \(status) should map to .cookieExpired, got \(result)")
                continue
            }
        }
    }

    func testTooManyRequestsMapsToThrottled() async {
        let stub = StubHTTPClient(statusCode: 429, data: Data(), headers: ["Retry-After": "120"])
        let service = makeService(stub: stub)
        let result = await service.fetchUsage(sessionKey: "sk-ant-test", orgId: "org-123")
        guard case let .throttled(retryAfter) = result else {
            return XCTFail("Expected .throttled, got \(result)")
        }
        XCTAssertEqual(retryAfter, 120)
    }

    func testServerErrorMapsToFailed() async {
        let stub = StubHTTPClient(statusCode: 500, data: Data())
        let service = makeService(stub: stub)
        let result = await service.fetchUsage(sessionKey: "sk-ant-test", orgId: "org-123")
        guard case let .failed(statusCode) = result else {
            return XCTFail("Expected .failed, got \(result)")
        }
        XCTAssertEqual(statusCode, 500)
    }

    // MARK: - Organizations / account

    func testOrganizationsParsing() async throws {
        let data = try loadFixture("organizations")
        let stub = StubHTTPClient(statusCode: 200, data: data)
        let service = makeService(stub: stub)

        let result = await service.fetchOrganizations(sessionKey: "sk-ant-test")
        guard case let .ok(orgs) = result else {
            return XCTFail("Expected .ok, got \(result)")
        }
        XCTAssertEqual(orgs.first?.uuid, "00000000-0000-4000-8000-0000000000ff")
        XCTAssertEqual(orgs.first?.name, "Example Team")
    }

    func testAccountParsing() async throws {
        let data = try loadFixture("account")
        let stub = StubHTTPClient(statusCode: 200, data: data)
        let service = makeService(stub: stub)

        let result = await service.fetchAccount(sessionKey: "sk-ant-test")
        guard case let .ok(account) = result else {
            return XCTFail("Expected .ok, got \(result)")
        }
        XCTAssertEqual(account.email_address, "user@example.com")
        XCTAssertEqual(account.memberships?.first?.organization?.uuid, "00000000-0000-4000-8000-0000000000ff")
    }
}

// MARK: - Stub HTTP client

final class StubHTTPClient: ClaudeWebHTTPClient {
    let statusCode: Int
    let data: Data
    let headers: [String: String]
    private(set) var lastRequest: URLRequest?

    init(statusCode: Int, data: Data, headers: [String: String] = [:]) {
        self.statusCode = statusCode
        self.data = data
        self.headers = headers
    }

    func data(for request: URLRequest) async throws -> (Data, URLResponse) {
        lastRequest = request
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: statusCode,
            httpVersion: "HTTP/1.1",
            headerFields: headers
        )!
        return (data, response)
    }
}
