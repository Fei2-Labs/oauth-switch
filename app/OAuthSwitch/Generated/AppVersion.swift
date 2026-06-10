// Generated at build time by `make version` (see app/Makefile).
// This committed fallback keeps a plain `swift build` working; make overwrites
// it with the real version, git hash, and build date. Do not edit by hand.
enum AppVersion {
    static let version = "dev"
    static let gitHash = "unknown"
    static let buildDate = ""
    static var display: String { "v\(version) (\(gitHash)) \(buildDate)" }
}
