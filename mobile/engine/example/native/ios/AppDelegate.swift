import Capacitor
import CutalongEnginePlugin
import Darwin
import UIKit

/// The test app. Launched with --selftest (xcrun simctl launch DEVICE
/// app.cutalong.engine.example --selftest), or with CUTALONG_SELFTEST=1 in
/// its environment, the page runs the self-test by itself.
@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // The self-test runs for minutes with nobody touching the screen.
        if SelfTestHostPlugin.selftest {
            application.isIdleTimerDisabled = true
        }
        return true
    }

    func application(_ application: UIApplication, configurationForConnecting connectingSceneSession: UISceneSession, options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        let config = UISceneConfiguration(name: "Default Configuration", sessionRole: connectingSceneSession.role)
        config.delegateClass = SceneDelegate.self
        return config
    }
}

/// Capacitor's view controller, with the test app's own plugin.
class HostViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(SelfTestHostPlugin())
    }
}

/// What only the test app needs (see src/plugins.ts): its launch flag, its
/// media as files, small text files, the process's memory, and the engine
/// plugin's importer without its pickers.
@objc(SelfTestHostPlugin)
public class SelfTestHostPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "SelfTestHostPlugin"
    public let jsName = "SelfTestHost"
    public let pluginMethods: [CAPPluginMethod] = [
        "launch", "prepareMedia", "readText", "writeText", "remove", "fileSize", "memory",
        "resetPeakMemory", "importFile", "galleryRoundTrip", "device"
    ].map { CAPPluginMethod(name: $0, returnType: CAPPluginReturnPromise) }

    static var selftest: Bool {
        ProcessInfo.processInfo.arguments.contains("--selftest")
            || ProcessInfo.processInfo.environment["CUTALONG_SELFTEST"] == "1"
    }

    private let files = FileManager.default

    @objc func launch(_ call: CAPPluginCall) {
        call.resolve(["selftest": Self.selftest])
    }

    /// Copies the media bundled in the app (public/media) into Caches.
    @objc func prepareMedia(_ call: CAPPluginCall) {
        DispatchQueue.global(qos: .userInitiated).async {
            guard let bundled = Bundle.main.resourceURL?.appendingPathComponent("public/media"),
                  self.files.fileExists(atPath: bundled.appendingPathComponent("expect.json").path) else {
                call.reject("Could not copy the media: the app was built without it.")
                return
            }
            let dir = self.files.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("selftest-media")
            do {
                if self.files.fileExists(atPath: dir.path) {
                    try self.files.removeItem(at: dir)
                }
                try self.files.copyItem(at: bundled, to: dir)
                call.resolve(["dir": dir.path])
            } catch {
                call.reject("Could not copy the media: \(error.localizedDescription)")
            }
        }
    }

    @objc func readText(_ call: CAPPluginCall) {
        let path = call.getString("path") ?? ""
        do {
            call.resolve(["text": try String(contentsOfFile: path, encoding: .utf8)])
        } catch {
            call.reject("Could not read \(path): \(error.localizedDescription)")
        }
    }

    @objc func writeText(_ call: CAPPluginCall) {
        let url = URL(fileURLWithPath: call.getString("path") ?? "")
        do {
            try files.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try (call.getString("text") ?? "").write(to: url, atomically: true, encoding: .utf8)
            call.resolve()
        } catch {
            call.reject("Could not write \(url.path): \(error.localizedDescription)")
        }
    }

    @objc func remove(_ call: CAPPluginCall) {
        let path = call.getString("path") ?? ""
        if files.fileExists(atPath: path) {
            try? files.removeItem(atPath: path)
        }
        call.resolve()
    }

    @objc func fileSize(_ call: CAPPluginCall) {
        let path = call.getString("path") ?? ""
        var directory: ObjCBool = false
        let exists = files.fileExists(atPath: path, isDirectory: &directory) && !directory.boolValue
        let bytes = exists ? ((try? files.attributesOfItem(atPath: path)[.size] as? NSNumber)?.int64Value ?? 0) : 0
        call.resolve(["exists": exists, "bytes": bytes])
    }

    /// The memory the system holds against the app (phys_footprint, what
    /// Xcode shows and what the system ends apps over), and its peak since launch.
    @objc func memory(_ call: CAPPluginCall) {
        var info = task_vm_info_data_t()
        var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<integer_t>.size)
        let result = withUnsafeMutablePointer(to: &info) {
            $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
                task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count)
            }
        }
        guard result == KERN_SUCCESS else {
            call.reject("task_info failed: \(result)")
            return
        }
        call.resolve(["residentBytes": Int64(info.phys_footprint), "peakBytes": Int64(info.ledger_phys_footprint_peak)])
    }

    /// iOS keeps the peak since launch and offers no way to start it afresh.
    @objc func resetPeakMemory(_ call: CAPPluginCall) {
        call.resolve(["reset": false])
    }

    /// Copies a file in with the engine plugin's importer, as a picked file is.
    @objc func importFile(_ call: CAPPluginCall) {
        let path = call.getString("path") ?? ""
        DispatchQueue.global(qos: .userInitiated).async {
            do {
                let file = try Importer.copyIn(URL(fileURLWithPath: path), name: (path as NSString).lastPathComponent)
                call.resolve(["path": file.path, "name": file.name, "bytes": file.bytes])
            } catch {
                call.reject("Could not import: \(error.localizedDescription)")
            }
        }
    }

    @objc func galleryRoundTrip(_ call: CAPPluginCall) {
        call.reject("The gallery round trip is Android's; on iOS the self-test imports the file directly.")
    }

    @objc func device(_ call: CAPPluginCall) {
        let process = ProcessInfo.processInfo
        #if targetEnvironment(simulator)
        let model = process.environment["SIMULATOR_MODEL_IDENTIFIER"] ?? "simulator"
        let simulator = true
        #else
        var size = 0
        sysctlbyname("hw.machine", nil, &size, nil, 0)
        var machine = [CChar](repeating: 0, count: max(size, 1))
        sysctlbyname("hw.machine", &machine, &size, nil, 0)
        let model = String(cString: machine)
        let simulator = false
        #endif
        call.resolve([
            "model": model,
            "os": process.operatingSystemVersionString,
            "cpus": process.activeProcessorCount,
            "memoryBytes": Int64(process.physicalMemory),
            "simulator": simulator
        ])
    }
}
