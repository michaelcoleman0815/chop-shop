// Samples a video and reports where the faces are, as JSON on stdout.
//
// Vision runs on-device and needs no model download or network. Output is one
// record per sampled instant, with face rectangles in normalised coordinates
// whose origin is top-left, matching how the crop filter thinks.

import AVFoundation
import CoreImage
import Foundation
import Vision

struct Face: Codable {
    let x: Double
    let y: Double
    let w: Double
    let h: Double
}

struct Sample: Codable {
    let t: Double
    let faces: [Face]
}

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(("chopshop-vision: " + message + "\n").data(using: .utf8)!)
    exit(1)
}

let args = CommandLine.arguments
guard args.count >= 2 else { fail("usage: chopshop-vision <video> [startSec] [durationSec] [samplesPerSec]") }

let url = URL(fileURLWithPath: args[1])
let startSec = args.count > 2 ? Double(args[2]) ?? 0 : 0
let requestedDuration = args.count > 3 ? Double(args[3]) ?? 0 : 0
let samplesPerSec = args.count > 4 ? Double(args[4]) ?? 2 : 2

let asset = AVURLAsset(url: url)
let totalSeconds = CMTimeGetSeconds(asset.duration)
guard totalSeconds.isFinite, totalSeconds > 0 else { fail("could not read duration") }

let duration = requestedDuration > 0 ? min(requestedDuration, totalSeconds - startSec) : totalSeconds - startSec
guard duration > 0 else { fail("range is outside the video") }

let generator = AVAssetImageGenerator(asset: asset)
generator.appliesPreferredTrackTransform = true
// Exact frames are far slower than the nearest one, and a tenth of a second of
// slack makes no difference to where a face is.
generator.requestedTimeToleranceBefore = CMTime(seconds: 0.1, preferredTimescale: 600)
generator.requestedTimeToleranceAfter = CMTime(seconds: 0.1, preferredTimescale: 600)
// Faces are found just as well on a small image, and decoding is the cost here.
generator.maximumSize = CGSize(width: 640, height: 640)

let step = 1.0 / max(0.25, samplesPerSec)
var samples: [Sample] = []
var t = 0.0

while t < duration {
    let time = CMTime(seconds: startSec + t, preferredTimescale: 600)
    guard let cgImage = try? generator.copyCGImage(at: time, actualTime: nil) else {
        t += step
        continue
    }

    let request = VNDetectFaceRectanglesRequest()
    let handler = VNImageRequestHandler(cgImage: cgImage, orientation: .up, options: [:])
    try? handler.perform([request])

    let faces: [Face] = (request.results ?? []).map { observation in
        let box = observation.boundingBox
        // Vision's origin is bottom-left; flip so y grows downward.
        return Face(x: Double(box.origin.x),
                    y: Double(1.0 - box.origin.y - box.height),
                    w: Double(box.width),
                    h: Double(box.height))
    }

    samples.append(Sample(t: t, faces: faces))
    t += step
}

let encoder = JSONEncoder()
guard let data = try? encoder.encode(samples), let json = String(data: data, encoding: .utf8) else {
    fail("could not encode results")
}
print(json)
