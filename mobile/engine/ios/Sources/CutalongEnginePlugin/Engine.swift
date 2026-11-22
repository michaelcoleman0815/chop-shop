import CutalongEngineCore
import Foundation

/// The engine library (core/include/cutalong_engine.h) in Swift: runs start
/// on threads of the engine's own, and their lines and their end come back
/// on those threads.
enum Engine {
    final class Run {
        let onLine: (String, Int32, String) -> Void
        let onExit: (Int32, String, String) -> Void

        init(onLine: @escaping (String, Int32, String) -> Void, onExit: @escaping (Int32, String, String) -> Void) {
            self.onLine = onLine
            self.onExit = onExit
        }
    }

    /// 0 when the run started; CE_ERR_BUSY, CE_ERR_TOOL or CE_ERR_THREAD otherwise.
    static func run(
        id: String,
        tool: String,
        args: [String],
        onLine: @escaping (String, Int32, String) -> Void,
        onExit: @escaping (Int32, String, String) -> Void
    ) -> Int32 {
        let user = Unmanaged.passRetained(Run(onLine: onLine, onExit: onExit)).toOpaque()
        let cargs: [UnsafePointer<CChar>?] = args.map { UnsafePointer(strdup($0)) }
        defer { cargs.forEach { free(UnsafeMutablePointer(mutating: $0)) } }
        let started = cargs.withUnsafeBufferPointer { buffer in
            ce_run(id, tool, Int32(args.count), buffer.baseAddress, lineArrived, runEnded, user)
        }
        if started != 0 {
            Unmanaged<Run>.fromOpaque(user).release()
        }
        return started
    }

    static func cancel(_ id: String) {
        _ = ce_cancel(id)
    }

    static var ffmpegVersion: String { String(cString: ce_ffmpeg_version()) }
    static var whisperVersion: String { String(cString: ce_whisper_version()) }

    static var videoEncoders: [String] {
        guard let list = ce_video_encoders() else { return [] }
        defer { ce_free(list) }
        return String(cString: list).split(separator: ",").map(String.init)
    }
}

/// Whatever bytes a tool printed, as text: anything that is not UTF-8 (whisper
/// writes tokens that split a character) becomes U+FFFD.
private func text(_ pointer: UnsafePointer<CChar>?, _ count: Int) -> String {
    guard let pointer, count > 0 else { return "" }
    return String(decoding: UnsafeRawBufferPointer(start: pointer, count: count), as: UTF8.self)
}

private let lineArrived: ce_line_fn = { user, id, stream, line, length in
    guard let user, let id else { return }
    let run = Unmanaged<Engine.Run>.fromOpaque(user).takeUnretainedValue()
    run.onLine(String(cString: id), stream, text(line, length))
}

private let runEnded: ce_exit_fn = { user, _, code, out, outLength, err, errLength in
    guard let user else { return }
    let run = Unmanaged<Engine.Run>.fromOpaque(user).takeRetainedValue()
    run.onExit(code, text(out, outLength), text(err, errLength))
}
