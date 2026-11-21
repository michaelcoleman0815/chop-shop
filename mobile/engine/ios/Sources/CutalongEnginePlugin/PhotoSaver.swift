import Foundation
import Photos

/// Adds an export to Photos, asking only to add (never to read the library).
/// The app's Info.plist says why: NSPhotoLibraryAddUsageDescription,
/// "Cutalong saves your exports to Photos."
public enum PhotoSaver {
    static let pictureExtensions: Set<String> = ["png", "jpg", "jpeg", "heic", "webp", "gif"]

    public static func save(_ url: URL, finished: @escaping (Bool, String?) -> Void) {
        guard FileManager.default.fileExists(atPath: url.path) else {
            finished(false, "There is no file at \(url.path).")
            return
        }
        PHPhotoLibrary.requestAuthorization(for: .addOnly) { status in
            guard status == .authorized || status == .limited else {
                finished(false, "Cutalong saves your exports to Photos, and is not allowed to. You can allow it in Settings, Privacy, Photos.")
                return
            }
            let picture = pictureExtensions.contains(url.pathExtension.lowercased())
            PHPhotoLibrary.shared().performChanges({
                let request = PHAssetCreationRequest.forAsset()
                request.addResource(with: picture ? .photo : .video, fileURL: url, options: nil)
            }, completionHandler: { saved, error in
                finished(saved, saved ? nil : (error?.localizedDescription ?? "Photos did not take it."))
            })
        }
    }
}
