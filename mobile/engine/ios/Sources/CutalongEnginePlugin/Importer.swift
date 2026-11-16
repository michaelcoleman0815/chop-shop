import Foundation
import PhotosUI
import UIKit
import UniformTypeIdentifiers

/// A file the person picked, copied into the app's own storage.
public struct PickedFile {
    public let path: String
    public let name: String
    public let bytes: Int64

    var json: [String: Any] { ["path": path, "name": name, "bytes": bytes] }
}

/// Copies picked files into Documents/Imported. Copies stream (APFS clones
/// them where it can), so a 4K recording never sits whole in memory.
public enum Importer {
    public static var folder: URL {
        FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Imported", isDirectory: true)
    }

    /// Copies (or moves) the file at `url` in, as `name`; returns what was kept.
    public static func copyIn(_ url: URL, name: String, move: Bool = false) throws -> PickedFile {
        let manager = FileManager.default
        try manager.createDirectory(at: folder, withIntermediateDirectories: true)
        let kept = safeName(name)
        let dest = unique(kept)
        if move {
            try manager.moveItem(at: url, to: dest)
        } else {
            try manager.copyItem(at: url, to: dest)
        }
        let bytes = (try? manager.attributesOfItem(atPath: dest.path)[.size] as? NSNumber)?.int64Value ?? 0
        return PickedFile(path: dest.path, name: kept, bytes: bytes)
    }

    static func safeName(_ name: String) -> String {
        var s = name.replacingOccurrences(of: "/", with: "-").replacingOccurrences(of: ":", with: "-")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        while s.hasPrefix(".") { s.removeFirst() }
        return s.isEmpty ? "Imported" : s
    }

    /// name, or "name (2)", "name (3)" when it is taken.
    static func unique(_ name: String) -> URL {
        let manager = FileManager.default
        var url = folder.appendingPathComponent(name)
        guard manager.fileExists(atPath: url.path) else { return url }
        let base = (name as NSString).deletingPathExtension
        let ext = (name as NSString).pathExtension
        var n = 2
        repeat {
            url = folder.appendingPathComponent(ext.isEmpty ? "\(base) (\(n))" : "\(base) (\(n)).\(ext)")
            n += 1
        } while manager.fileExists(atPath: url.path)
        return url
    }
}

/// Shows the photo picker (videos and pictures) or the document picker
/// (sound, and anything else asked for with it), and copies what comes back.
final class Picker: NSObject, PHPickerViewControllerDelegate, UIDocumentPickerDelegate {
    private let finished: (Result<[PickedFile], Error>) -> Void

    init(finished: @escaping (Result<[PickedFile], Error>) -> Void) {
        self.finished = finished
    }

    func present(on host: UIViewController, multiple: Bool, kinds: Set<String>) {
        if kinds.contains("audio") {
            var types: [UTType] = [.audio]
            if kinds.contains("video") { types.append(.movie) }
            if kinds.contains("image") { types.append(.image) }
            let picker = UIDocumentPickerViewController(forOpeningContentTypes: types, asCopy: true)
            picker.allowsMultipleSelection = multiple
            picker.delegate = self
            host.present(picker, animated: true)
            return
        }
        var config = PHPickerConfiguration()
        config.selectionLimit = multiple ? 0 : 1
        // The file as it was recorded: no conversion to a more compatible format.
        config.preferredAssetRepresentationMode = .current
        var filters: [PHPickerFilter] = []
        if kinds.contains("video") || kinds.isEmpty { filters.append(.videos) }
        if kinds.contains("image") || kinds.isEmpty { filters.append(.images) }
        config.filter = .any(of: filters)
        let picker = PHPickerViewController(configuration: config)
        picker.delegate = self
        host.present(picker, animated: true)
    }

    func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
        picker.dismiss(animated: true)
        let group = DispatchGroup()
        let lock = NSLock()
        var files = [PickedFile?](repeating: nil, count: results.count)
        var failure: Error?
        for (i, result) in results.enumerated() {
            let provider = result.itemProvider
            let type: UTType = provider.hasItemConformingToTypeIdentifier(UTType.movie.identifier) ? .movie : .image
            group.enter()
            // The file is only there until this block returns, so it is copied here.
            provider.loadFileRepresentation(forTypeIdentifier: type.identifier) { url, error in
                defer { group.leave() }
                do {
                    guard let url else { throw error ?? CocoaError(.fileReadUnknown) }
                    let ext = url.pathExtension
                    let base = provider.suggestedName ?? url.deletingPathExtension().lastPathComponent
                    let name = ext.isEmpty || base.lowercased().hasSuffix(".\(ext.lowercased())") ? base : "\(base).\(ext)"
                    let file = try Importer.copyIn(url, name: name)
                    lock.lock()
                    files[i] = file
                    lock.unlock()
                } catch {
                    lock.lock()
                    failure = failure ?? error
                    lock.unlock()
                }
            }
        }
        group.notify(queue: .main) {
            if let failure {
                self.finished(.failure(failure))
            } else {
                self.finished(.success(files.compactMap { $0 }))
            }
        }
    }

    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        DispatchQueue.global(qos: .userInitiated).async {
            do {
                // asCopy: these are the app's own copies already, so they move.
                let files = try urls.map { try Importer.copyIn($0, name: $0.lastPathComponent, move: true) }
                DispatchQueue.main.async { self.finished(.success(files)) }
            } catch {
                DispatchQueue.main.async { self.finished(.failure(error)) }
            }
        }
    }

    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        finished(.success([]))
    }
}
