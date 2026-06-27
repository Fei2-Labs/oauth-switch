import XCTest
@testable import OAuthSwitch

final class CookieCaptureServiceTests: XCTestCase {
    private var tempHome: String!

    override func setUpWithError() throws {
        try super.setUpWithError()
        tempHome = NSTemporaryDirectory() + "oauthswitch-capture-" + UUID().uuidString
        try FileManager.default.createDirectory(atPath: tempHome, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        if let tempHome {
            try? FileManager.default.removeItem(atPath: tempHome)
        }
        try super.tearDownWithError()
    }

    // MARK: - Fixtures (sanitized — public repo, no real PII)

    private func makeAccount(key: String, email: String?, orgUuid: String?) -> ClaudeAccount {
        ClaudeAccount(
            key: key,
            metadata: ClaudeMetadata(
                emailAddress: email,
                accountUuid: nil,
                organizationUuid: orgUuid,
                organizationId: nil,
                organizationName: nil,
                workspaceUuid: nil,
                workspaceId: nil,
                planType: nil
            ),
            credentials: nil,
            capturedAt: nil,
            lastUsedAt: nil,
            usageSnapshot: nil,
            disabled: nil,
            credentialStatus: nil
        )
    }

    private func webAccount(email: String?, orgUuids: [String]) -> ClaudeWebAccount {
        ClaudeWebAccount(
            email_address: email,
            memberships: orgUuids.map {
                ClaudeWebAccount.Membership(organization: ClaudeWebAccount.Membership.Organization(uuid: $0))
            }
        )
    }

    private func makeService(
        sessionKey: String?,
        accountResult: ClaudeWebResult<ClaudeWebAccount>
    ) -> CookieCaptureService {
        CookieCaptureService(
            readSessionKey: { sessionKey },
            fetchAccount: { _ in accountResult },
            cache: CookieCacheService(homeDirectory: tempHome),
            now: { Date(timeIntervalSince1970: 0) }
        )
    }

    // MARK: - Tests

    func testMatchByEmailCachesUnderRightAccountKey() async {
        let accounts = [
            makeAccount(key: "acct-a", email: "other@example.com", orgUuid: "00000000-0000-4000-8000-00000000000a"),
            makeAccount(key: "acct-b", email: "User@Example.com", orgUuid: "00000000-0000-4000-8000-0000000000ff"),
        ]
        let service = makeService(
            sessionKey: "sk-ant-livetoken",
            accountResult: .ok(webAccount(email: "user@example.com", orgUuids: ["00000000-0000-4000-8000-0000000000ff"]))
        )

        let result = await service.capture(accounts: accounts)
        guard case let .captured(email, accountKey) = result else {
            return XCTFail("Expected .captured, got \(result)")
        }
        XCTAssertEqual(email, "user@example.com")
        XCTAssertEqual(accountKey, "acct-b")

        let cached = CookieCacheService(homeDirectory: tempHome).get(accountKey: "acct-b")
        XCTAssertEqual(cached?.sessionKey, "sk-ant-livetoken")
        XCTAssertEqual(cached?.orgId, "00000000-0000-4000-8000-0000000000ff")
        // Nothing cached under the non-matching account.
        XCTAssertNil(CookieCacheService(homeDirectory: tempHome).get(accountKey: "acct-a"))
    }

    func testPrefersOrgMatchingStoredOrganizationUuid() async {
        let accounts = [
            makeAccount(key: "acct-b", email: "user@example.com", orgUuid: "00000000-0000-4000-8000-0000000000ff"),
        ]
        // Multiple memberships; first is NOT the account's known org.
        let service = makeService(
            sessionKey: "sk-ant-livetoken",
            accountResult: .ok(webAccount(
                email: "user@example.com",
                orgUuids: [
                    "00000000-0000-4000-8000-00000000000a",
                    "00000000-0000-4000-8000-0000000000ff",
                ]
            ))
        )

        let result = await service.capture(accounts: accounts)
        guard case .captured = result else {
            return XCTFail("Expected .captured, got \(result)")
        }
        let cached = CookieCacheService(homeDirectory: tempHome).get(accountKey: "acct-b")
        XCTAssertEqual(cached?.orgId, "00000000-0000-4000-8000-0000000000ff")
    }

    func testNoMatchReturnsUnmatchedAndCachesNothing() async {
        let accounts = [
            makeAccount(key: "acct-a", email: "someone@example.com", orgUuid: nil),
        ]
        let service = makeService(
            sessionKey: "sk-ant-livetoken",
            accountResult: .ok(webAccount(email: "stranger@example.com", orgUuids: ["00000000-0000-4000-8000-0000000000ff"]))
        )

        let result = await service.capture(accounts: accounts)
        guard case let .unmatched(email) = result else {
            return XCTFail("Expected .unmatched, got \(result)")
        }
        XCTAssertEqual(email, "stranger@example.com")
        XCTAssertTrue(CookieCacheService(homeDirectory: tempHome).load().isEmpty)
    }

    func testCookieExpiredReturnsSessionExpiredAndCachesNothing() async {
        let accounts = [makeAccount(key: "acct-a", email: "user@example.com", orgUuid: nil)]
        let service = makeService(sessionKey: "sk-ant-livetoken", accountResult: .cookieExpired)

        let result = await service.capture(accounts: accounts)
        XCTAssertEqual(result, .sessionExpired)
        XCTAssertTrue(CookieCacheService(homeDirectory: tempHome).load().isEmpty)
    }

    func testNoBrowserSessionWhenSessionKeyMissing() async {
        let accounts = [makeAccount(key: "acct-a", email: "user@example.com", orgUuid: nil)]
        let service = makeService(sessionKey: nil, accountResult: .ok(webAccount(email: "user@example.com", orgUuids: [])))

        let result = await service.capture(accounts: accounts)
        XCTAssertEqual(result, .noBrowserSession)
        XCTAssertTrue(CookieCacheService(homeDirectory: tempHome).load().isEmpty)
    }

    func testThrottledAndFailedPropagate() async {
        let accounts = [makeAccount(key: "acct-a", email: "user@example.com", orgUuid: nil)]

        let throttled = makeService(sessionKey: "sk-ant-x", accountResult: .throttled(retryAfter: 60))
        let throttledResult = await throttled.capture(accounts: accounts)
        XCTAssertEqual(throttledResult, .throttled)

        let failed = makeService(sessionKey: "sk-ant-x", accountResult: .failed(statusCode: 500))
        let failedResult = await failed.capture(accounts: accounts)
        XCTAssertEqual(failedResult, .fetchFailed(statusCode: 500))

        XCTAssertTrue(CookieCacheService(homeDirectory: tempHome).load().isEmpty)
    }

    func testCacheWriteFailureReturnsCacheWriteFailed() async {
        // Point the cache at a path that cannot be created (a regular file sits
        // where the ~/.oauth-switch directory would need to be), forcing save to
        // fail. The match still happens, but persistence does not.
        let blocker = tempHome + "/.oauth-switch"
        try? "i am a file, not a dir".data(using: .utf8)!.write(to: URL(fileURLWithPath: blocker))

        let accounts = [makeAccount(key: "acct-a", email: "user@example.com", orgUuid: nil)]
        let service = CookieCaptureService(
            readSessionKey: { "sk-ant-livetoken" },
            fetchAccount: { _ in .ok(self.webAccount(email: "user@example.com", orgUuids: [])) },
            cache: CookieCacheService(homeDirectory: tempHome),
            now: { Date(timeIntervalSince1970: 0) }
        )

        let result = await service.capture(accounts: accounts)
        XCTAssertEqual(result, .cacheWriteFailed(email: "user@example.com"))
    }

    func testMissingEmailReturnsMissingAccountInfo() async {
        let accounts = [makeAccount(key: "acct-a", email: "user@example.com", orgUuid: nil)]
        let service = makeService(sessionKey: "sk-ant-x", accountResult: .ok(webAccount(email: nil, orgUuids: [])))

        let result = await service.capture(accounts: accounts)
        XCTAssertEqual(result, .missingAccountInfo)
        XCTAssertTrue(CookieCacheService(homeDirectory: tempHome).load().isEmpty)
    }
}
