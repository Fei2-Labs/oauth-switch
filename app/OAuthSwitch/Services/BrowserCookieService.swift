import Foundation

// Reads the claude.ai `sessionKey` cookie from local browsers.
//
// MVP scope (PR1): Firefox + Zen only. Firefox stores cookies in a plaintext
// SQLite table (`moz_cookies`) with no Keychain, no Full Disk Access, and no
// decryption required. We mirror StoreService's "copy the DB then shell to
// /usr/bin/sqlite3" pattern to dodge the WAL lock while the browser is running.
//
// The sqlite runner and home directory are injectable so tests can point at a
// fixture profile without touching the real environment.
struct BrowserCookieService {
    // (dbPath, query) -> stdout (nil on any failure / non-zero exit).
    typealias SQLiteRunner = (_ dbPath: String, _ query: String) -> String?

    private let homeDirectory: String
    private let sqliteRunner: SQLiteRunner

    init(
        homeDirectory: String = NSHomeDirectory(),
        sqliteRunner: @escaping SQLiteRunner = BrowserCookieService.defaultSQLiteRunner
    ) {
        self.homeDirectory = homeDirectory
        self.sqliteRunner = sqliteRunner
    }

    // Returns the first claude.ai `sessionKey` cookie value that looks like a
    // real Claude session token (`sk-ant-` prefix), or nil when no usable
    // cookie is found. Never throws: a missing profile / missing sqlite3 /
    // missing row all degrade to nil.
    func readClaudeSessionKey() -> String? {
        for dbPath in cookieDatabasePaths() {
            guard let value = readSessionKey(fromCookieDB: dbPath) else { continue }
            if value.hasPrefix("sk-ant-") {
                return value
            }
        }
        return nil
    }

    // Locates every Firefox/Zen profile `cookies.sqlite` under the home dir.
    private func cookieDatabasePaths() -> [String] {
        let fileManager = FileManager.default
        let profileRoots = [
            homeDirectory + "/Library/Application Support/Firefox/Profiles",
            homeDirectory + "/Library/Application Support/Zen/Profiles",
        ]

        var dbPaths: [String] = []
        for root in profileRoots {
            guard let entries = try? fileManager.contentsOfDirectory(atPath: root) else { continue }
            for entry in entries.sorted() {
                let dbPath = root + "/" + entry + "/cookies.sqlite"
                if fileManager.fileExists(atPath: dbPath) {
                    dbPaths.append(dbPath)
                }
            }
        }
        return dbPaths
    }

    private func readSessionKey(fromCookieDB dbPath: String) -> String? {
        guard let copyPath = copyDatabase(at: dbPath) else { return nil }
        defer { cleanupCopy(at: copyPath) }

        let query = "SELECT value FROM moz_cookies WHERE host LIKE '%claude.ai' AND name='sessionKey';"
        guard let output = sqliteRunner(copyPath, query) else { return nil }

        let value = output
            .split(separator: "\n", omittingEmptySubsequences: true)
            .first
            .map(String.init)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard let value, !value.isEmpty else { return nil }
        return value
    }

    // Copies the DB (plus any -wal / -shm siblings) into a private temp dir so
    // a read-only sqlite3 query doesn't fight the browser's live WAL lock.
    private func copyDatabase(at dbPath: String) -> String? {
        let fileManager = FileManager.default
        guard fileManager.fileExists(atPath: dbPath) else { return nil }

        let tempDir = NSTemporaryDirectory() + "oauthswitch-cookies-" + UUID().uuidString
        guard (try? fileManager.createDirectory(atPath: tempDir, withIntermediateDirectories: true)) != nil else {
            return nil
        }

        let copyPath = tempDir + "/cookies.sqlite"
        for suffix in ["", "-wal", "-shm"] {
            let source = dbPath + suffix
            let destination = copyPath + suffix
            if fileManager.fileExists(atPath: source) {
                try? fileManager.copyItem(atPath: source, toPath: destination)
            }
        }
        return fileManager.fileExists(atPath: copyPath) ? copyPath : nil
    }

    private func cleanupCopy(at copyPath: String) {
        let directory = (copyPath as NSString).deletingLastPathComponent
        try? FileManager.default.removeItem(atPath: directory)
    }

    static func defaultSQLiteRunner(dbPath: String, query: String) -> String? {
        let sqlitePath = "/usr/bin/sqlite3"
        guard FileManager.default.fileExists(atPath: sqlitePath) else { return nil }

        let process = Process()
        process.executableURL = URL(fileURLWithPath: sqlitePath)
        process.arguments = [dbPath, query]

        let output = Pipe()
        process.standardOutput = output
        process.standardError = Pipe()

        do {
            try process.run()
            let data = output.fileHandleForReading.readDataToEndOfFile()
            process.waitUntilExit()
            guard process.terminationStatus == 0 else { return nil }
            return String(data: data, encoding: .utf8)
        } catch {
            return nil
        }
    }
}
