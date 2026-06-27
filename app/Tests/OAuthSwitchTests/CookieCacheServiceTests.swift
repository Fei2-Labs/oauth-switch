import XCTest
@testable import OAuthSwitch

final class CookieCacheServiceTests: XCTestCase {
    private var tempHome: String!

    override func setUpWithError() throws {
        try super.setUpWithError()
        tempHome = NSTemporaryDirectory() + "oauthswitch-cookiecache-" + UUID().uuidString
        try FileManager.default.createDirectory(atPath: tempHome, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        if let tempHome {
            try? FileManager.default.removeItem(atPath: tempHome)
        }
        try super.tearDownWithError()
    }

    private func makeCookie(_ key: String = "sk-ant-test") -> CachedCookie {
        CachedCookie(
            sessionKey: key,
            email: "user@example.com",
            orgId: "00000000-0000-4000-8000-0000000000ff",
            capturedAt: "2026-06-27T00:00:00Z"
        )
    }

    func testSetGetRemoveRoundTrip() {
        let cache = CookieCacheService(homeDirectory: tempHome)
        let cookie = makeCookie()

        XCTAssertNil(cache.get(accountKey: "acct-1"))
        XCTAssertTrue(cache.set(accountKey: "acct-1", cookie))
        XCTAssertEqual(cache.get(accountKey: "acct-1"), cookie)

        // A second account coexists.
        let other = makeCookie("sk-ant-other")
        XCTAssertTrue(cache.set(accountKey: "acct-2", other))
        XCTAssertEqual(cache.get(accountKey: "acct-1"), cookie)
        XCTAssertEqual(cache.get(accountKey: "acct-2"), other)

        XCTAssertTrue(cache.remove(accountKey: "acct-1"))
        XCTAssertNil(cache.get(accountKey: "acct-1"))
        XCTAssertEqual(cache.get(accountKey: "acct-2"), other)
    }

    func testReadBacksWithFreshInstance() {
        let writer = CookieCacheService(homeDirectory: tempHome)
        XCTAssertTrue(writer.set(accountKey: "acct-1", makeCookie()))

        // A separate instance pointed at the same home reads the persisted file.
        let reader = CookieCacheService(homeDirectory: tempHome)
        XCTAssertEqual(reader.get(accountKey: "acct-1"), makeCookie())
    }

    func testFileModeIs0600AfterWrite() throws {
        let cache = CookieCacheService(homeDirectory: tempHome)
        XCTAssertTrue(cache.set(accountKey: "acct-1", makeCookie()))

        let filePath = tempHome + "/.oauth-switch/cookies.json"
        let attrs = try FileManager.default.attributesOfItem(atPath: filePath)
        let mode = (attrs[.posixPermissions] as? NSNumber)?.intValue
        XCTAssertEqual(mode, 0o600, "cookie file holds secrets and must be 0600")

        let dirAttrs = try FileManager.default.attributesOfItem(atPath: tempHome + "/.oauth-switch")
        let dirMode = (dirAttrs[.posixPermissions] as? NSNumber)?.intValue
        XCTAssertEqual(dirMode, 0o700)
    }

    func testMissingFileReturnsEmpty() {
        let cache = CookieCacheService(homeDirectory: tempHome)
        XCTAssertTrue(cache.load().isEmpty)
        XCTAssertNil(cache.get(accountKey: "anything"))
    }

    func testCorruptJSONReturnsEmptyWithoutThrowing() throws {
        let dir = tempHome + "/.oauth-switch"
        try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        try "not json {{{".data(using: .utf8)!.write(to: URL(fileURLWithPath: dir + "/cookies.json"))

        let cache = CookieCacheService(homeDirectory: tempHome)
        XCTAssertTrue(cache.load().isEmpty)
        // A subsequent write still succeeds (overwrites the corrupt file).
        XCTAssertTrue(cache.set(accountKey: "acct-1", makeCookie()))
        XCTAssertEqual(cache.get(accountKey: "acct-1"), makeCookie())
    }
}
