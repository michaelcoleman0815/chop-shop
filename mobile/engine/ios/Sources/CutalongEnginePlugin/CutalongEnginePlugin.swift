import Capacitor
import CoreMedia
import Foundation
import UIKit
import VideoToolbox

/// Cutalong's engines on iOS: ffmpeg, ffprobe and whisper in-process (see
/// src/definitions.ts for the contract), the photo and document pickers, and
/// saving to Photos.
@objc(CutalongEnginePlugin)
public class CutalongEnginePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "CutalongEnginePlugin"
    public let jsName = "CutalongEngine"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "run", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancel", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pick", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "saveToPhotos", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "info", returnType: CAPPluginReturnPromise)
    ]

    /// The picker on screen, kept while it is shown.
    private var picker: Picker?

    @objc func run(_ call: CAPPluginCall) {
        guard let id = call.getString("id"), !id.isEmpty else {
            call.reject("A run needs an id.")
            return
        }
        guard let tool = call.getString("tool") else {
            call.reject("A run needs a tool: ffmpeg, ffprobe or whisper.")
            return
        }
        let args = call.getArray("args", String.self) ?? []
        let started = Engine.run(
            id: id,
            tool: tool,
            args: args,
            onLine: { [weak self] runId, stream, line in
                self?.notifyListeners("line", data: [
                    "id": runId,
                    "stream": stream == 0 ? "stdout" : "stderr",
                    "line": line
                ])
            },
            onExit: { code, stdout, stderr in
                call.resolve(["code": Int(code), "stdout": stdout, "stderr": stderr])
            }
        )
        switch started {
        case 0:
            break
        case -1: // CE_ERR_BUSY
            call.reject("A run named \(id) is still going.", "BUSY")
        case -2: // CE_ERR_TOOL
            call.reject("There is no tool named \(tool): ffmpeg, ffprobe or whisper.", "TOOL")
        default:
            call.reject("The run could not start.", "START")
        }
    }

    @objc func cancel(_ call: CAPPluginCall) {
        guard let id = call.getString("id") else {
            call.reject("cancel needs the run's id.")
            return
        }
        Engine.cancel(id)
        call.resolve()
    }

    @objc func info(_ call: CAPPluginCall) {
        let manager = FileManager.default
        let documents = manager.urls(for: .documentDirectory, in: .userDomainMask)[0]
        let cache = manager.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        let encoders = Engine.videoEncoders.filter { name in
            // A VideoToolbox encoder is only there if this iPhone can start one.
            switch name {
            case "h264_videotoolbox": return Self.canEncode(kCMVideoCodecType_H264)
            case "hevc_videotoolbox": return Self.canEncode(kCMVideoCodecType_HEVC)
            case "prores_videotoolbox": return Self.canEncode(kCMVideoCodecType_AppleProRes422)
            default: return true
            }
        }
        call.resolve([
            "platform": "ios",
            "documents": documents.path,
            "cache": cache.path,
            "ffmpegVersion": Engine.ffmpegVersion,
            "whisperVersion": Engine.whisperVersion,
            "encoders": encoders
        ])
    }

    private static func canEncode(_ codec: CMVideoCodecType) -> Bool {
        var session: VTCompressionSession?
        let status = VTCompressionSessionCreate(
            allocator: nil,
            width: 1280,
            height: 720,
            codecType: codec,
            encoderSpecification: nil,
            imageBufferAttributes: nil,
            compressedDataAllocator: nil,
            outputCallback: nil,
            refcon: nil,
            compressionSessionOut: &session
        )
        if let session {
            VTCompressionSessionInvalidate(session)
        }
        return status == noErr
    }

    @objc func pick(_ call: CAPPluginCall) {
        let multiple = call.getBool("multiple") ?? false
        let kinds = Set(call.getArray("kinds", String.self) ?? [])
        DispatchQueue.main.async {
            guard let host = self.bridge?.viewController else {
                call.reject("There is nothing to show the picker on.")
                return
            }
            let picker = Picker { [weak self] result in
                self?.picker = nil
                switch result {
                case .success(let files):
                    call.resolve(["files": files.map { $0.json }])
                case .failure(let error):
                    call.reject("Could not copy what was picked: \(error.localizedDescription)", "COPY", error)
                }
            }
            self.picker = picker
            picker.present(on: host, multiple: multiple, kinds: kinds)
        }
    }

    @objc func saveToPhotos(_ call: CAPPluginCall) {
        guard let path = call.getString("path") else {
            call.resolve(["saved": false, "message": "saveToPhotos needs a path."])
            return
        }
        PhotoSaver.save(URL(fileURLWithPath: path)) { saved, message in
            var result: [String: Any] = ["saved": saved]
            if let message { result["message"] = message }
            call.resolve(result)
        }
    }
}
