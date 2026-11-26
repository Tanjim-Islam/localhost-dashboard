import AppKit
import CoreGraphics
import Foundation

struct SmokeFailure: Error, CustomStringConvertible {
    let description: String
    init(_ message: String) { description = message }
}

func windowIsVisible(_ pid: pid_t) -> Bool {
    let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
        as? [[String: Any]] ?? []
    return windows.contains { row in
        guard (row[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == pid,
              (row[kCGWindowLayer as String] as? NSNumber)?.intValue == 0,
              let bounds = row[kCGWindowBounds as String] as? [String: NSNumber] else { return false }
        return (bounds["Width"]?.intValue ?? 0) >= 900 && (bounds["Height"]?.intValue ?? 0) >= 600
    }
}

func waitFor(_ timeout: TimeInterval, until predicate: () -> Bool) -> Bool {
    let deadline = Date().addingTimeInterval(timeout)
    repeat {
        if predicate() { return true }
        RunLoop.current.run(until: Date().addingTimeInterval(0.15))
    } while Date() < deadline
    return predicate()
}

func checkLaunch() throws {
    guard CommandLine.arguments.count == 2,
          let bundle = Bundle(url: URL(fileURLWithPath: CommandLine.arguments[1])),
          bundle.bundleIdentifier == "com.localdashboard.app",
          let binary = bundle.executableURL else { throw SmokeFailure("Expected a built dashboard app bundle.") }
    let files = FileManager.default
    let profile = files.temporaryDirectory.appendingPathComponent("dashboard-macos-\(UUID().uuidString)")
    try files.createDirectory(at: profile, withIntermediateDirectories: false)
    defer { try? files.removeItem(at: profile) }

    let child = Process()
    child.executableURL = binary
    child.environment = ProcessInfo.processInfo.environment.merging(
        ["LOCAL_DASHBOARD_CLIS_TEST_ROOT": profile.path], uniquingKeysWith: { _, fixture in fixture }
    )
    try child.run()
    defer {
        if child.isRunning {
            child.terminate()
            if !waitFor(3, until: { !child.isRunning }) { kill(child.processIdentifier, SIGKILL) }
            child.waitUntilExit()
        }
    }
    guard waitFor(40, until: { !child.isRunning || windowIsVisible(child.processIdentifier) }),
          child.isRunning, let app = NSRunningApplication(processIdentifier: child.processIdentifier),
          app.bundleIdentifier == bundle.bundleIdentifier else {
        throw SmokeFailure("The bundled app did not show its dashboard window.")
    }
    guard app.terminate(), waitFor(15, until: { !child.isRunning }),
          child.terminationReason == .exit, child.terminationStatus == 0 else {
        throw SmokeFailure("The app failed its native quit request.")
    }
    let store = profile.appendingPathComponent("tauri-app-data/projects.json")
    let document = try JSONSerialization.jsonObject(with: Data(contentsOf: store)) as? [String: Any]
    let state = document?["state"] as? [String: Any]
    guard (state?["schemaVersion"] as? NSNumber)?.intValue == 2 else {
        throw SmokeFailure("The app did not flush the disposable project store on quit.")
    }
    print("Verified the packaged macOS window, native quit, exit status, and persisted project store.")
}

do {
    try checkLaunch()
} catch {
    FileHandle.standardError.write(Data("\(error)\n".utf8))
    exit(1)
}
