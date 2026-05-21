import Foundation

struct SwitchService {
    private let cliPath: String = {
        let home = NSHomeDirectory()
        return home + "/Dropbox/My Apps/oauth-switch/bin/oauth-switch.cjs"
    }()

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
}
