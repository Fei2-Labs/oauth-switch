import XCTest
@testable import OAuthSwitch

final class CookieUsageRefreshServiceTests: XCTestCase {
    // MARK: - Fixtures (sanitized — public repo, no real PII)

    private func makeAccount(key: String, orgUuid: String?) -> ClaudeAccount {
        ClaudeAccount(
            key: key,
            metadata: ClaudeMetadata(
                emailAddress: "\(key)@example.com",
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

    private func cookie(_ sessionKey: String, orgId: String?) -> CachedCookie {
        CachedCookie(sessionKey: sessionKey, email: nil, orgId: orgId, capturedAt: "2026-06-27T00:00:00Z")
    }

    private func snapshot(fiveHour: Double) -> UsageSnapshot {
        UsageSnapshot(
            five_hour: UsageSnapshot.Window(utilization: fiveHour, resets_at: nil),
            seven_day: nil,
            fetchedAt: "2026-06-27T12:00:00.000Z"
        )
    }

    // MARK: - Tests

    func testOkUpdatesSnapshotAndPersists() async {
        let accounts = [makeAccount(key: "acct-b", orgUuid: "00000000-0000-4000-8000-0000000000ff")]
        var persisted: [(String, Double?)] = []

        let service = CookieUsageRefreshService(
            loadCookies: { ["acct-b": self.cookie("sk-ant-b", orgId: "00000000-0000-4000-8000-0000000000ff")] },
            fetchUsage: { _, _ in .ok(self.snapshot(fiveHour: 62)) },
            persist: { key, snap in persisted.append((key, snap.five_hour?.utilization)) }
        )

        let outcome = await service.refresh(accounts: accounts, activeKey: nil)

        XCTAssertEqual(outcome.updated.count, 1)
        XCTAssertEqual(outcome.updated.first?.key, "acct-b")
        XCTAssertEqual(outcome.updated.first?.snapshot.five_hour?.utilization, 62)
        XCTAssertTrue(outcome.cookieExpiredKeys.isEmpty)
        // Persisted via the (stubbed) Node single-writer seam.
        XCTAssertEqual(persisted.count, 1)
        XCTAssertEqual(persisted.first?.0, "acct-b")
        XCTAssertEqual(persisted.first?.1, 62)
    }

    func testCookieExpiredFlagsKeyKeepsLastSnapshotNoPersistNoOAuth() async {
        let accounts = [makeAccount(key: "acct-b", orgUuid: "org-b")]
        var persistCalled = false

        let service = CookieUsageRefreshService(
            loadCookies: { ["acct-b": self.cookie("sk-ant-b", orgId: "org-b")] },
            fetchUsage: { _, _ in .cookieExpired },
            persist: { _, _ in persistCalled = true }
        )

        let outcome = await service.refresh(accounts: accounts, activeKey: nil)

        XCTAssertTrue(outcome.updated.isEmpty, "expired cookie must not produce a new snapshot")
        XCTAssertEqual(outcome.cookieExpiredKeys, ["acct-b"])
        XCTAssertFalse(persistCalled, "expired cookie must not write the store")
    }

    func testActiveAccountIsNotCookieRefreshed() async {
        let accounts = [
            makeAccount(key: "acct-active", orgUuid: "org-a"),
            makeAccount(key: "acct-b", orgUuid: "org-b"),
        ]
        var fetchedOrgs: [String] = []

        let service = CookieUsageRefreshService(
            loadCookies: {
                [
                    "acct-active": self.cookie("sk-ant-a", orgId: "org-a"),
                    "acct-b": self.cookie("sk-ant-b", orgId: "org-b"),
                ]
            },
            fetchUsage: { _, orgId in
                fetchedOrgs.append(orgId)
                return .ok(self.snapshot(fiveHour: 10))
            },
            persist: { _, _ in }
        )

        let outcome = await service.refresh(accounts: accounts, activeKey: "acct-active")

        // Only the non-active account is fetched, even though both have cookies.
        XCTAssertEqual(fetchedOrgs, ["org-b"])
        XCTAssertEqual(outcome.updated.map(\.key), ["acct-b"])
    }

    func testAccountWithoutCookieIsSkipped() async {
        let accounts = [
            makeAccount(key: "acct-b", orgUuid: "org-b"),
            makeAccount(key: "acct-c", orgUuid: "org-c"),
        ]
        var fetchCount = 0

        let service = CookieUsageRefreshService(
            loadCookies: { ["acct-b": self.cookie("sk-ant-b", orgId: "org-b")] },
            fetchUsage: { _, _ in
                fetchCount += 1
                return .ok(self.snapshot(fiveHour: 5))
            },
            persist: { _, _ in }
        )

        let outcome = await service.refresh(accounts: accounts, activeKey: nil)

        XCTAssertEqual(fetchCount, 1, "only the cookie-backed account is fetched")
        XCTAssertEqual(outcome.updated.map(\.key), ["acct-b"])
    }

    func testThrottledKeepsSnapshotNoFlagNoPersist() async {
        let accounts = [makeAccount(key: "acct-b", orgUuid: "org-b")]
        var persistCalled = false

        let service = CookieUsageRefreshService(
            loadCookies: { ["acct-b": self.cookie("sk-ant-b", orgId: "org-b")] },
            fetchUsage: { _, _ in .throttled(retryAfter: 60) },
            persist: { _, _ in persistCalled = true }
        )

        let outcome = await service.refresh(accounts: accounts, activeKey: nil)

        XCTAssertTrue(outcome.updated.isEmpty)
        XCTAssertTrue(outcome.cookieExpiredKeys.isEmpty)
        XCTAssertFalse(persistCalled)
    }

    func testEmptyCacheDoesNothing() async {
        let accounts = [makeAccount(key: "acct-b", orgUuid: "org-b")]
        var fetchCalled = false

        let service = CookieUsageRefreshService(
            loadCookies: { [:] },
            fetchUsage: { _, _ in
                fetchCalled = true
                return .ok(self.snapshot(fiveHour: 5))
            },
            persist: { _, _ in }
        )

        let outcome = await service.refresh(accounts: accounts, activeKey: nil)

        XCTAssertFalse(fetchCalled)
        XCTAssertTrue(outcome.updated.isEmpty)
    }

    func testFallsBackToStoreOrgUuidWhenCookieHasNoOrg() async {
        let accounts = [makeAccount(key: "acct-b", orgUuid: "org-from-store")]
        var fetchedOrgs: [String] = []

        let service = CookieUsageRefreshService(
            loadCookies: { ["acct-b": self.cookie("sk-ant-b", orgId: nil)] },
            fetchUsage: { _, orgId in
                fetchedOrgs.append(orgId)
                return .ok(self.snapshot(fiveHour: 5))
            },
            persist: { _, _ in }
        )

        _ = await service.refresh(accounts: accounts, activeKey: nil)
        XCTAssertEqual(fetchedOrgs, ["org-from-store"])
    }
}
