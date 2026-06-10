import Foundation

struct SwitchService {
    private static let repoRoot: String = {
        let home = NSHomeDirectory()
        let candidates = [
            home + "/Dropbox/My Apps/oauth-switch",
            home + "/My Apps/oauth-switch",
        ]
        return candidates.first {
            FileManager.default.fileExists(atPath: $0 + "/bin/oauth-switch.cjs")
        } ?? candidates[1]
    }()

    private let cliPath = SwitchService.repoRoot + "/bin/oauth-switch.cjs"

    private let nodePath = "/opt/homebrew/bin/node"

    func run(args: [String]) -> String {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: nodePath)
        process.arguments = [cliPath] + args
        process.environment = ProcessInfo.processInfo.environment

        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe

        do {
            try process.run()
            process.waitUntilExit()
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            return String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        } catch {
            return "Error: \(error.localizedDescription)"
        }
    }

    func openCodexManagedLogin() -> String {
        let repoPath = Self.repoRoot
        let command = "cd \(Self.shellQuoted(repoPath)); \(Self.shellQuoted(nodePath)) \(Self.shellQuoted(cliPath)) codex add; echo; echo OAuth Switch Codex login finished. Close this window after the menu refreshes."
        let script = """
        tell application "Terminal"
            activate
            do script \(Self.appleScriptString(command))
        end tell
        """

        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
        process.arguments = ["-e", script]

        do {
            try process.run()
            process.waitUntilExit()
            return process.terminationStatus == 0
                ? "Started managed Codex login in Terminal."
                : "Failed to open Terminal for managed Codex login."
        } catch {
            return "Error: \(error.localizedDescription)"
        }
    }

    private static func shellQuoted(_ value: String) -> String {
        "'\(value.replacingOccurrences(of: "'", with: "'\\''"))'"
    }

    private static func appleScriptString(_ value: String) -> String {
        let escaped = value
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
        return "\"\(escaped)\""
    }
}
