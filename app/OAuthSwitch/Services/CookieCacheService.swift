import Foundation

// A captured claude.ai web session for one OAuth-Switch account.
//
// The `sessionKey` is a secret (it authenticates the claude.ai web API on its
// own), so the cache file holding these is written 0600 and kept OUT of any
// synced store (see CookieCacheService).
struct CachedCookie: Codable, Equatable {
    let sessionKey: String
    let email: String?
    let orgId: String?
    let capturedAt: String
}

// Per-account claude.ai `sessionKey` cache, persisted to
// `~/.oauth-switch/cookies.json` (the same private, NON-synced directory the
// Node CLI already uses for state.json / switch.log — deliberately not the
// Dropbox-synced account store, to keep secrets out of sync and avoid bloat).
//
// The file is keyed by `ClaudeAccount.key` (the stable store key). Reads never
// throw: a missing or corrupt file degrades to an empty cache. Every write is
// atomic and re-asserts 0600 on the file (0700 on the directory) because the
// payload is secret.
struct CookieCacheService {
    private let directory: String
    private let filePath: String

    init(homeDirectory: String = NSHomeDirectory()) {
        self.directory = homeDirectory + "/.oauth-switch"
        self.filePath = directory + "/cookies.json"
    }

    // Loads the whole cache. Missing file -> empty; corrupt JSON -> empty.
    func load() -> [String: CachedCookie] {
        guard let data = try? Data(contentsOf: URL(fileURLWithPath: filePath)),
              let cookies = try? JSONDecoder().decode([String: CachedCookie].self, from: data) else {
            return [:]
        }
        return cookies
    }

    func get(accountKey: String) -> CachedCookie? {
        load()[accountKey]
    }

    // Upserts one account's cookie and persists. Returns false if the write fails.
    @discardableResult
    func set(accountKey: String, _ cookie: CachedCookie) -> Bool {
        var cookies = load()
        cookies[accountKey] = cookie
        return save(cookies)
    }

    // Removes one account's cookie and persists. Returns false if the write fails.
    @discardableResult
    func remove(accountKey: String) -> Bool {
        var cookies = load()
        guard cookies.removeValue(forKey: accountKey) != nil else { return true }
        return save(cookies)
    }

    // Atomically writes the whole cache and enforces secret-safe permissions
    // (dir 0700, file 0600). Returns false on any IO failure.
    @discardableResult
    func save(_ cookies: [String: CachedCookie]) -> Bool {
        let fileManager = FileManager.default
        if !fileManager.fileExists(atPath: directory) {
            guard (try? fileManager.createDirectory(
                atPath: directory,
                withIntermediateDirectories: true,
                attributes: [.posixPermissions: 0o700]
            )) != nil else {
                return false
            }
        }
        try? fileManager.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directory)

        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        guard let data = try? encoder.encode(cookies),
              (try? data.write(to: URL(fileURLWithPath: filePath), options: .atomic)) != nil else {
            return false
        }
        // Re-assert 0600 after the atomic write (a replace can reset the mode).
        try? fileManager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: filePath)
        return true
    }
}
