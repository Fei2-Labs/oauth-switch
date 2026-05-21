import Foundation

struct StoreService {
    private let claudeStorePath: String = {
        NSHomeDirectory() + "/.ClaudeCodeMultiAccounts.json"
    }()

    private let codexStorePath: String = {
        NSHomeDirectory() + "/.CodexMultiAccounts.json"
    }()

    private let claudeConfigPath: String = {
        NSHomeDirectory() + "/.claude.json"
    }()

    private let codexAuthPath: String = {
        NSHomeDirectory() + "/.codex/auth.json"
    }()

    func loadClaudeStore() -> ClaudeStore {
        guard let data = try? Data(contentsOf: URL(fileURLWithPath: claudeStorePath)),
              let store = try? JSONDecoder().decode(ClaudeStore.self, from: data) else {
            return ClaudeStore(version: nil, accounts: [], updatedAt: nil)
        }
        return store
    }

    func loadCodexStore() -> CodexStore {
        guard let data = try? Data(contentsOf: URL(fileURLWithPath: codexStorePath)),
              let store = try? JSONDecoder().decode(CodexStore.self, from: data) else {
            return CodexStore(version: nil, accounts: [], updatedAt: nil)
        }
        return store
    }

    func detectActiveClaudeKey() -> String? {
        guard let data = try? Data(contentsOf: URL(fileURLWithPath: claudeConfigPath)),
              let config = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let oauth = config["oauthAccount"] as? [String: Any] else {
            return nil
        }
        if let uuid = oauth["accountUuid"] as? String, !uuid.isEmpty {
            return "uuid:\(uuid.lowercased())"
        }
        if let email = oauth["emailAddress"] as? String, !email.isEmpty {
            return "email:\(email.lowercased())"
        }
        return nil
    }

    func detectActiveCodexKey() -> String? {
        guard let data = try? Data(contentsOf: URL(fileURLWithPath: codexAuthPath)),
              let auth = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let tokens = auth["tokens"] as? [String: Any],
              let accountId = tokens["account_id"] as? String else {
            return nil
        }
        return "account:\(accountId)"
    }
}
