import XCTest
@testable import OAuthSwitch

final class BrowserCookieServiceTests: XCTestCase {
    private var tempHome: String!

    override func setUpWithError() throws {
        try super.setUpWithError()
        tempHome = NSTemporaryDirectory() + "oauthswitch-test-home-" + UUID().uuidString
        try FileManager.default.createDirectory(atPath: tempHome, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        if let tempHome {
            try? FileManager.default.removeItem(atPath: tempHome)
        }
        try super.tearDownWithError()
    }

    // Creates a Firefox profile cookies.sqlite under the temp home and seeds it
    // with the given rows via the real sqlite3 CLI.
    @discardableResult
    private func makeFirefoxCookieDB(rows: [(host: String, name: String, value: String)]) throws -> String {
        let profileDir = tempHome + "/Library/Application Support/Firefox/Profiles/test.default"
        try FileManager.default.createDirectory(atPath: profileDir, withIntermediateDirectories: true)
        let dbPath = profileDir + "/cookies.sqlite"

        var sql = "CREATE TABLE moz_cookies (host TEXT, name TEXT, value TEXT);"
        for row in rows {
            let host = row.host.replacingOccurrences(of: "'", with: "''")
            let name = row.name.replacingOccurrences(of: "'", with: "''")
            let value = row.value.replacingOccurrences(of: "'", with: "''")
            sql += "INSERT INTO moz_cookies (host, name, value) VALUES ('\(host)', '\(name)', '\(value)');"
        }
        try runSQLite(dbPath: dbPath, sql: sql)
        return dbPath
    }

    private func runSQLite(dbPath: String, sql: String) throws {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/sqlite3")
        process.arguments = [dbPath, sql]
        try process.run()
        process.waitUntilExit()
        guard process.terminationStatus == 0 else {
            throw XCTSkip("sqlite3 CLI unavailable or failed; cannot build fixture DB")
        }
    }

    func testReadsClaudeSessionKeyFromFirefox() throws {
        try makeFirefoxCookieDB(rows: [
            (host: ".other.example", name: "sessionKey", value: "unrelated"),
            (host: ".claude.ai", name: "sessionKey", value: "sk-ant-sid01-livetoken"),
        ])

        let service = BrowserCookieService(homeDirectory: tempHome)
        XCTAssertEqual(service.readClaudeSessionKey(), "sk-ant-sid01-livetoken")
    }

    func testRejectsNonSkAntValue() throws {
        try makeFirefoxCookieDB(rows: [
            (host: ".claude.ai", name: "sessionKey", value: "not-a-real-key"),
        ])

        let service = BrowserCookieService(homeDirectory: tempHome)
        XCTAssertNil(service.readClaudeSessionKey())
    }

    func testReturnsNilWhenNoProfile() {
        // Empty temp home: no Firefox profile at all.
        let service = BrowserCookieService(homeDirectory: tempHome)
        XCTAssertNil(service.readClaudeSessionKey())
    }

    func testReturnsNilWhenNoMatchingCookie() throws {
        try makeFirefoxCookieDB(rows: [
            (host: ".claude.ai", name: "someOtherCookie", value: "x"),
        ])

        let service = BrowserCookieService(homeDirectory: tempHome)
        XCTAssertNil(service.readClaudeSessionKey())
    }
}
