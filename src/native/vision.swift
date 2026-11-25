// Samples a video and reports where the faces are, as JSON on stdout.
//
// Vision runs on-device and needs no model download or network. Output is one
// record per sampled instant, with face rectangles in normalised coordinates
// whose origin is top-left, matching how the crop filter thinks.
//
// With --masks it cuts things out instead (see runMasks below): the person, by
// person segmentation, or each object in the picture, by the foreground
// instance masks that "lift subject" uses. --masks-check says which this Mac
// can do. An older helper fails both, and the app then has no cut-outs.

import AVFoundation
import CoreImage
import Foundation
import ImageIO
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
    /**
     * Everyone Vision sees, faced or not, upper bodies: a person seen from behind has a body here and no face
     * among the faces, which is how a shot over the congregation's shoulders is known.
     */
    let people: [Face]
}

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(("chopshop-vision: " + message + "\n").data(using: .utf8)!)
    exit(1)
}

let args = CommandLine.arguments
if args.count >= 2 && (args[1] == "--masks" || args[1] == "--masks-check") {
    runMasks(Array(args.dropFirst()))
}
if args.count >= 2 && args[1] == "--track" {
    runTrack(Array(args.dropFirst()))
}
if args.count >= 2 && args[1] == "--screen" {
    runScreen(Array(args.dropFirst()))
}
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
    let humans = VNDetectHumanRectanglesRequest()
    let handler = VNImageRequestHandler(cgImage: cgImage, orientation: .up, options: [:])
    try? handler.perform([request, humans])

    // Vision's origin is bottom-left; flip so y grows downward.
    func flipped(_ box: CGRect) -> Face {
        return Face(x: Double(box.origin.x),
                    y: Double(1.0 - box.origin.y - box.height),
                    w: Double(box.width),
                    h: Double(box.height))
    }
    let faces: [Face] = (request.results ?? []).map { flipped($0.boundingBox) }
    let people: [Face] = (humans.results ?? []).map { flipped($0.boundingBox) }

    samples.append(Sample(t: t, faces: faces, people: people))
    t += step
}

let encoder = JSONEncoder()
guard let data = try? encoder.encode(samples), let json = String(data: data, encoding: .utf8) else {
    fail("could not encode results")
}
print(json)

// MARK: - Cut-outs
//
// chopshop-vision --masks-check
//     {"person": true, "objects": true}: what this Mac can cut out.
// chopshop-vision --masks <person|objects> <video> <outDir> <startSec> <durationSec> <samplesPerSec> <longSide>
//     One grey PNG per mask in outDir (white where the person or object is),
//     longSide pixels on its long side, and on stdout:
//     {"width": w, "height": h, "samples": [{"t": seconds into the video,
//      "masks": [{"id": n, "file": path, "box": [x, y, w, h]}]}]}
//     with boxes as fractions of the picture, origin top-left. Objects are
//     numbered as Vision found them in each picture; the app follows them.

struct MaskOut: Codable {
    let id: Int
    let file: String
    let box: [Double]
}

struct MaskSample: Codable {
    let t: Double
    let masks: [MaskOut]
}

struct MaskTrack: Codable {
    let width: Int
    let height: Int
    let samples: [MaskSample]
}

struct MaskAbility: Codable {
    let person: Bool
    let objects: Bool
}

func emit<T: Encodable>(_ value: T) -> Never {
    guard let data = try? JSONEncoder().encode(value), let json = String(data: data, encoding: .utf8) else {
        fail("could not encode results")
    }
    print(json)
    exit(0)
}

/// A mask as 8-bit grey, one byte per pixel, top row first.
struct Grey {
    let width: Int
    let height: Int
    var bytes: [UInt8]
}

/// A Vision mask (one 8-bit or 32-bit float component) as 8-bit grey at its own size.
func grey(from buffer: CVPixelBuffer) -> Grey? {
    CVPixelBufferLockBaseAddress(buffer, .readOnly)
    defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
    let w = CVPixelBufferGetWidth(buffer)
    let h = CVPixelBufferGetHeight(buffer)
    let row = CVPixelBufferGetBytesPerRow(buffer)
    guard let base = CVPixelBufferGetBaseAddress(buffer), w > 0, h > 0 else { return nil }
    var out = [UInt8](repeating: 0, count: w * h)
    switch CVPixelBufferGetPixelFormatType(buffer) {
    case kCVPixelFormatType_OneComponent8:
        for y in 0..<h {
            let p = base.advanced(by: y * row).assumingMemoryBound(to: UInt8.self)
            for x in 0..<w { out[y * w + x] = p[x] }
        }
    case kCVPixelFormatType_OneComponent32Float:
        for y in 0..<h {
            let p = base.advanced(by: y * row).assumingMemoryBound(to: Float32.self)
            for x in 0..<w { out[y * w + x] = UInt8(max(0, min(255, (p[x] * 255).rounded()))) }
        }
    default:
        return nil
    }
    return Grey(width: w, height: h, bytes: out)
}

func cgImage(_ g: Grey) -> CGImage? {
    guard let provider = CGDataProvider(data: Data(g.bytes) as CFData) else { return nil }
    return CGImage(width: g.width, height: g.height, bitsPerComponent: 8, bitsPerPixel: 8, bytesPerRow: g.width,
                   space: CGColorSpaceCreateDeviceGray(),
                   bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.none.rawValue),
                   provider: provider, decode: nil, shouldInterpolate: true, intent: .defaultIntent)
}

/// A mask made smaller, so its long side is `long` pixels; never larger.
func scaled(_ g: Grey, long: Int) -> Grey {
    let k = Double(long) / Double(max(g.width, g.height))
    if k >= 1 { return g }
    let w = max(1, Int((Double(g.width) * k).rounded()))
    let h = max(1, Int((Double(g.height) * k).rounded()))
    guard let src = cgImage(g),
          let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
                              space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue)
    else { return g }
    ctx.interpolationQuality = .high
    ctx.draw(src, in: CGRect(x: 0, y: 0, width: w, height: h))
    guard let data = ctx.data else { return g }
    let row = ctx.bytesPerRow
    let p = data.assumingMemoryBound(to: UInt8.self)
    var out = [UInt8](repeating: 0, count: w * h)
    for y in 0..<h { for x in 0..<w { out[y * w + x] = p[y * row + x] } }
    return Grey(width: w, height: h, bytes: out)
}

/// Where a mask is more there than not, as fractions of it; nil when it is empty.
func box(_ g: Grey) -> [Double]? {
    var x0 = g.width, y0 = g.height, x1 = -1, y1 = -1
    for y in 0..<g.height {
        for x in 0..<g.width where g.bytes[y * g.width + x] > 127 {
            x0 = min(x0, x); x1 = max(x1, x); y0 = min(y0, y); y1 = max(y1, y)
        }
    }
    if x1 < 0 { return nil }
    let w = Double(g.width), h = Double(g.height)
    return [Double(x0) / w, Double(y0) / h, Double(x1 - x0 + 1) / w, Double(y1 - y0 + 1) / h]
}

func writePNG(_ g: Grey, to url: URL) -> Bool {
    guard let image = cgImage(g),
          let dest = CGImageDestinationCreateWithURL(url as CFURL, "public.png" as CFString, 1, nil)
    else { return false }
    CGImageDestinationAddImage(dest, image, nil)
    return CGImageDestinationFinalize(dest)
}

func runMasks(_ a: [String]) -> Never {
    if a[0] == "--masks-check" {
        var person = false
        var objects = false
        if #available(macOS 12.0, *) { person = true }
        if #available(macOS 14.0, *) { objects = true }
        emit(MaskAbility(person: person, objects: objects))
    }
    guard a.count >= 8 else {
        fail("usage: chopshop-vision --masks <person|objects> <video> <outDir> <startSec> <durationSec> <samplesPerSec> <longSide>")
    }
    let kind = a[1]
    guard kind == "person" || kind == "objects" else { fail("cut out person or objects, not \(kind)") }
    let url = URL(fileURLWithPath: a[2])
    let outDir = URL(fileURLWithPath: a[3], isDirectory: true)
    let start = Double(a[4]) ?? 0
    let wanted = Double(a[5]) ?? 0
    let rate = max(0.5, Double(a[6]) ?? 8)
    let long = max(32, Int(a[7]) ?? 512)
    try? FileManager.default.createDirectory(at: outDir, withIntermediateDirectories: true)

    let asset = AVURLAsset(url: url)
    let total = CMTimeGetSeconds(asset.duration)
    guard total.isFinite, total > 0 else { fail("could not read duration") }
    let duration = wanted > 0 ? min(wanted, total - start) : total - start
    guard duration > 0 else { fail("range is outside the video") }

    let generator = AVAssetImageGenerator(asset: asset)
    generator.appliesPreferredTrackTransform = true
    // A mask has to line up with the frame it is of, so the frame read is the one asked for.
    generator.requestedTimeToleranceBefore = CMTime(value: 1, timescale: 120)
    generator.requestedTimeToleranceAfter = CMTime(value: 1, timescale: 120)
    // Vision cuts out as well from a picture this size, and decoding is most of the cost.
    generator.maximumSize = CGSize(width: 1280, height: 1280)

    var samples: [MaskSample] = []
    var width = 0
    var height = 0
    var n = 0
    while Double(n) / rate <= duration + 1e-6 {
        let at = start + Double(n) / rate
        // Named by the moment, so a later stretch of the same recording never writes over an earlier one's masks.
        let ms = Int((at * 1000).rounded())
        n += 1
        guard let image = try? generator.copyCGImage(at: CMTime(seconds: at, preferredTimescale: 600), actualTime: nil) else {
            continue
        }
        let handler = VNImageRequestHandler(cgImage: image, orientation: .up, options: [:])
        var outs: [MaskOut] = []
        func keep(_ buffer: CVPixelBuffer, id: Int, name: String) {
            guard let g = grey(from: buffer) else { return }
            let s = scaled(g, long: long)
            width = s.width
            height = s.height
            let file = outDir.appendingPathComponent(name)
            if let b = box(s), writePNG(s, to: file) { outs.append(MaskOut(id: id, file: file.path, box: b)) }
        }
        if kind == "person" {
            guard #available(macOS 12.0, *) else { fail("cutting out a person needs macOS 12") }
            let request = VNGeneratePersonSegmentationRequest()
            request.qualityLevel = .balanced
            request.outputPixelFormat = kCVPixelFormatType_OneComponent8
            try? handler.perform([request])
            if let buffer = request.results?.first?.pixelBuffer {
                keep(buffer, id: 1, name: String(format: "person-%08d.png", ms))
            }
        } else {
            guard #available(macOS 14.0, *) else { fail("cutting out objects needs macOS 14") }
            let request = VNGenerateForegroundInstanceMaskRequest()
            try? handler.perform([request])
            if let observation = request.results?.first {
                for instance in observation.allInstances {
                    guard let buffer = try? observation.generateScaledMaskForImage(
                        forInstances: IndexSet(integer: instance), from: handler)
                    else { continue }
                    keep(buffer, id: instance, name: String(format: "object-%08d-%d.png", ms, instance))
                }
            }
        }
        samples.append(MaskSample(t: at, masks: outs))
    }
    emit(MaskTrack(width: width, height: height, samples: samples))
}

// MARK: - Following an object
//
// --track follows one object through a stretch of a video, for a graphic to
// stay on it: a phone held up, a product turned in the hand. Given no box, it
// picks the object itself on the first frame: of what objectness saliency
// says stands out, not a face and not most of the picture, the one nearest a
// hand when a hand is in shot, else the biggest. Then Vision's object tracker
// follows it frame by frame, and each frame its box is measured again, so
// its size follows the object as it nears or goes (below). Boxes are
// fractions of the picture, top-left origin; a frame where it is lost has
// none.

struct TrackSample: Codable {
    let t: Double
    let box: [Double]?
    let c: Double
    /** Its size against the box it started in: 2 is twice as wide and tall. Absent where it was lost. */
    let s: Double?
}

struct TrackResult: Codable {
    /** How the object was chosen: given, hand (nearest a hand) or salient (the biggest that stands out). */
    let found: String
    let start: [Double]
    let width: Int
    let height: Int
    /** The boxes' sizes are measured, frame by frame; a helper from before kept the first box's size throughout. */
    let sized: Bool
    let samples: [TrackSample]
}

// MARK: - Measuring its size
//
// Vision's tracker follows where an object goes but keeps the box it was
// given: an object brought nearer the camera outgrows it and the tracker loses
// it. So each frame the box is measured again by matching the object's own
// picture (a small grey patch taken on the first frame, and slowly updated
// while the match is good) over a few sizes and places around where the
// tracker and the frame before put it. The best match is the box, and its
// size against the first box is the scale.

/** A frame in grey, 0 to 1, top row first. */
struct Luma {
    let w: Int
    let h: Int
    let px: [Float]
}

func lumaOf(_ image: CGImage) -> Luma? {
    let w = image.width
    let h = image.height
    guard w > 0, h > 0 else { return nil }
    var bytes = [UInt8](repeating: 0, count: w * h)
    let drawn = bytes.withUnsafeMutableBytes { buf -> Bool in
        guard let ctx = CGContext(
            data: buf.baseAddress, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w,
            space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue)
        else { return false }
        ctx.interpolationQuality = .low
        ctx.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
        return true
    }
    guard drawn else { return nil }
    return Luma(w: w, h: h, px: bytes.map { (b: UInt8) -> Float in Float(b) / 255 })
}

/** The measuring's constants. Statics, since top-level lets are not set yet when --track runs (it runs before them). */
enum Measure {
    /** Samples across a patch, each way. */
    static let patch = 24
    /** Below this the patch is not the object any more. */
    static let same: Float = 0.55
}

func sampleGrey(_ g: Luma, _ x: Double, _ y: Double) -> Float {
    let fx = min(max(x, 0), Double(g.w - 1))
    let fy = min(max(y, 0), Double(g.h - 1))
    let x0 = Int(fx)
    let y0 = Int(fy)
    let x1 = min(x0 + 1, g.w - 1)
    let y1 = min(y0 + 1, g.h - 1)
    let ax = Float(fx - Double(x0))
    let ay = Float(fy - Double(y0))
    let a: Float = g.px[y0 * g.w + x0]
    let b: Float = g.px[y0 * g.w + x1]
    let c: Float = g.px[y1 * g.w + x0]
    let d: Float = g.px[y1 * g.w + x1]
    let top: Float = a + (b - a) * ax
    let bottom: Float = c + (d - c) * ax
    return top + (bottom - top) * ay
}

/** The picture inside a box (fractions, top-left origin) as a patch with its mean taken off and its length 1; nil when flat or tiny. */
func patchOf(_ g: Luma, _ box: [Double]) -> [Float]? {
    let bx = box[0] * Double(g.w)
    let by = box[1] * Double(g.h)
    let bw = box[2] * Double(g.w)
    let bh = box[3] * Double(g.h)
    if bw < 6 || bh < 6 { return nil }
    var out = [Float](repeating: 0, count: Measure.patch * Measure.patch)
    var sum: Float = 0
    let n = Double(Measure.patch)
    for j in 0..<Measure.patch {
        let y: Double = by + (Double(j) + 0.5) / n * bh - 0.5
        for i in 0..<Measure.patch {
            let x: Double = bx + (Double(i) + 0.5) / n * bw - 0.5
            let v = sampleGrey(g, x, y)
            out[j * Measure.patch + i] = v
            sum += v
        }
    }
    return unit(out, mean: sum / Float(out.count))
}

func unit(_ v: [Float], mean: Float) -> [Float]? {
    var c = v
    var norm: Float = 0
    for i in 0..<c.count {
        c[i] -= mean
        norm += c[i] * c[i]
    }
    norm = norm.squareRoot()
    if norm < 1e-3 { return nil }
    for i in 0..<c.count { c[i] /= norm }
    return c
}

/** How alike two patches are: 1 the same, 0 unrelated. */
func likeness(_ a: [Float], _ b: [Float]) -> Float {
    var d: Float = 0
    for i in 0..<a.count { d += a[i] * b[i] }
    return d
}

/**
 * The box that best matches the object's patch near each of `seeds`: the
 * same shape, a little bigger or smaller, a little to any side, searched
 * coarsely and then finely around the best. Its likeness comes with it.
 */
func measure(_ g: Luma, _ template: [Float], seeds: [[Double]]) -> ([Double], Float)? {
    var best: ([Double], Float)? = nil
    func trial(_ box: [Double]) {
        guard box[2] > 0.004, box[3] > 0.004, box[2] < 1.5, box[3] < 1.5, let p = patchOf(g, box) else { return }
        let score = likeness(template, p)
        if best == nil || score > best!.1 { best = (box, score) }
    }
    for (pass, step) in [0.06, 0.02].enumerated() {
        let around: [[Double]] = pass == 0 ? seeds : (best.map { [$0.0] } ?? [])
        for seed in around {
            let cx = seed[0] + seed[2] / 2
            let cy = seed[1] + seed[3] / 2
            for si in -3...3 {
                let k = 1 + Double(si) * step
                let w = seed[2] * k
                let h = seed[3] * k
                for dy in -3...3 {
                    for dx in -3...3 {
                        let x: Double = cx + Double(dx) * step * seed[2] - w / 2
                        let y: Double = cy + Double(dy) * step * seed[3] - h / 2
                        trial([x, y, w, h])
                    }
                }
            }
        }
    }
    return best
}


/** A box with its origin flipped from Vision's bottom-left to the top-left. */
func topLeft(_ r: CGRect) -> [Double] {
    return [Double(r.origin.x), Double(1 - r.origin.y - r.height), Double(r.width), Double(r.height)]
}

func area(_ r: CGRect) -> CGFloat { return max(0, r.width) * max(0, r.height) }

/** The object to follow on this frame, in Vision's coordinates, and how it was chosen. */
func findObject(_ image: CGImage) -> (CGRect, String)? {
    let saliency = VNGenerateObjectnessBasedSaliencyImageRequest()
    let faces = VNDetectFaceRectanglesRequest()
    let hands = VNDetectHumanHandPoseRequest()
    hands.maximumHandCount = 2
    let handler = VNImageRequestHandler(cgImage: image, orientation: .up, options: [:])
    try? handler.perform([saliency, faces, hands])
    let objects = (saliency.results?.first)?.salientObjects?.map { $0.boundingBox } ?? []
    let faceBoxes = faces.results?.map { $0.boundingBox } ?? []
    // Not a face, not the whole person or most of the picture, and big enough to put something on.
    let candidates = objects.filter { box in
        let a = area(box)
        if a > 0.6 || a < 0.004 { return false }
        return !faceBoxes.contains { f in area(box.intersection(f)) > 0.4 * a }
    }
    guard !candidates.isEmpty else { return nil }
    // Where the hands are: the middle of each hand's points Vision is sure of.
    var handPoints: [CGPoint] = []
    for observation in hands.results ?? [] {
        guard let points = try? observation.recognizedPoints(.all) else { continue }
        let sure = points.values.filter { $0.confidence > 0.3 }
        guard !sure.isEmpty else { continue }
        let x = sure.map { $0.location.x }.reduce(0, +) / CGFloat(sure.count)
        let y = sure.map { $0.location.y }.reduce(0, +) / CGFloat(sure.count)
        handPoints.append(CGPoint(x: x, y: y))
    }
    if !handPoints.isEmpty {
        let near = candidates.min { a, b in
            let da = handPoints.map { hypot($0.x - a.midX, $0.y - a.midY) }.min() ?? 9
            let db = handPoints.map { hypot($0.x - b.midX, $0.y - b.midY) }.min() ?? 9
            return da < db
        }
        if let near = near { return (near, "hand") }
    }
    let biggest = candidates.max { area($0) < area($1) }!
    return (biggest, "salient")
}

func runTrack(_ a: [String]) -> Never {
    guard a.count >= 5 else {
        fail("usage: chopshop-vision --track <video> <startSec> <durationSec> <samplesPerSec> [x y w h]")
    }
    let url = URL(fileURLWithPath: a[1])
    let start = Double(a[2]) ?? 0
    let wanted = Double(a[3]) ?? 0
    let rate = max(1, min(30, Double(a[4]) ?? 15))
    let given: [Double]? = a.count >= 9 ? [a[5], a[6], a[7], a[8]].compactMap { Double($0) } : nil

    let asset = AVURLAsset(url: url)
    let total = CMTimeGetSeconds(asset.duration)
    guard total.isFinite, total > 0 else { fail("could not read duration") }
    let duration = wanted > 0 ? min(wanted, total - start) : total - start
    guard duration > 0 else { fail("range is outside the video") }

    let generator = AVAssetImageGenerator(asset: asset)
    generator.appliesPreferredTrackTransform = true
    // Each frame read as asked: the tracker compares one with the next.
    let slack = CMTime(seconds: 0.5 / rate, preferredTimescale: 600)
    generator.requestedTimeToleranceBefore = slack
    generator.requestedTimeToleranceAfter = slack
    generator.maximumSize = CGSize(width: 960, height: 960)

    var samples: [TrackSample] = []
    var observation: VNDetectedObjectObservation? = nil
    var startBox: [Double] = []
    var found = "given"
    var width = 0
    var height = 0
    let sequence = VNSequenceRequestHandler()
    // The object's own picture, and where it was last measured.
    var template: [Float]? = nil
    var lastBox: [Double]? = nil
    var n = 0
    /** Its size against the box it started in. */
    func scaleOf(_ box: [Double]) -> Double {
        return startBox.count == 4 && startBox[2] > 0 ? box[2] / startBox[2] : 1
    }
    while Double(n) / rate <= duration + 1e-6 {
        let t = Double(n) / rate
        n += 1
        guard let image = try? generator.copyCGImage(at: CMTime(seconds: start + t, preferredTimescale: 600), actualTime: nil)
        else {
            // A frame that will not decode is a moment the object is not seen, so every sample keeps its time.
            if observation != nil { samples.append(TrackSample(t: t, box: nil, c: 0, s: nil)) }
            continue
        }
        width = image.width
        height = image.height
        let frame = lumaOf(image)
        guard let last = observation else {
            // The first frame: the box given, or the object found on it.
            if let g = given, g.count == 4 {
                let r = CGRect(x: g[0], y: 1 - g[1] - g[3], width: g[2], height: g[3])
                observation = VNDetectedObjectObservation(boundingBox: r)
                startBox = g
            } else if let (r, how) = findObject(image) {
                observation = VNDetectedObjectObservation(boundingBox: r)
                startBox = topLeft(r)
                found = how
            } else {
                fail("there is nothing in the picture to follow")
            }
            if let f = frame { template = patchOf(f, startBox) }
            lastBox = startBox
            samples.append(TrackSample(t: t, box: startBox, c: 1, s: 1))
            continue
        }
        let request = VNTrackObjectRequest(detectedObjectObservation: last)
        request.trackingLevel = .accurate
        try? sequence.perform([request], on: image)
        let next = request.results?.first as? VNDetectedObjectObservation
        if let next = next { observation = next }
        // Below this the tracker is guessing: the frame says it lost the object.
        let trackerSure = next.map { Double($0.confidence) >= 0.3 } ?? false
        let tracked = next.map { topLeft($0.boundingBox) }
        // Measured again around where the tracker puts it and where it was, at the size it last had.
        var seeds: [[Double]] = []
        if let tb = tracked, let lb = lastBox {
            let x: Double = tb[0] + tb[2] / 2 - lb[2] / 2
            let y: Double = tb[1] + tb[3] / 2 - lb[3] / 2
            seeds.append([x, y, lb[2], lb[3]])
        }
        if let lb = lastBox { seeds.append(lb) }
        if let f = frame, let tpl = template, let (box, score) = measure(f, tpl, seeds: seeds), score >= Measure.same {
            lastBox = box
            // The object's picture drifts with the light and its turning: a good match teaches it a little.
            if score > 0.75, let p = patchOf(f, box), let blended = unit(zip(tpl, p).map { (a: Float, b: Float) -> Float in a * 0.85 + b * 0.15 }, mean: 0) {
                template = blended
            }
            if !trackerSure {
                // The tracker lost it where the match did not: it starts again from the match.
                observation = VNDetectedObjectObservation(boundingBox: CGRect(x: box[0], y: 1 - box[1] - box[3], width: box[2], height: box[3]))
            }
            let sure: Double = next.map { Double($0.confidence) } ?? 0
            samples.append(TrackSample(t: t, box: box, c: max(Double(score), sure), s: scaleOf(box)))
            continue
        }
        // No match: the tracker's word for where it is, at the size it last had, when the tracker is sure.
        if trackerSure, let tb = tracked {
            let lb = lastBox ?? tb
            let x: Double = tb[0] + tb[2] / 2 - lb[2] / 2
            let y: Double = tb[1] + tb[3] / 2 - lb[3] / 2
            let box: [Double] = [x, y, lb[2], lb[3]]
            lastBox = box
            samples.append(TrackSample(t: t, box: box, c: Double(next!.confidence), s: scaleOf(box)))
        } else {
            samples.append(TrackSample(t: t, box: nil, c: next.map { Double($0.confidence) } ?? 0, s: nil))
        }
    }
    emit(TrackResult(found: found, start: startBox, width: width, height: height, sized: true, samples: samples))
}


// MARK: - What is on screen
//
// chopshop-vision --screen <video> <startSec> <durationSec> <samplesPerSec>
//     [{"t":0,"lines":[{"text":"...","x":0.02,"y":0.1,"w":0.5,"h":0.03}],"faces":[...],"windows":[...]}]
// The lines of text Vision reads in the picture, each with where it sits (top-left origin, shares of the frame),
// the faces, and the windows a face sits in: a screen recording with the speaker kept in a box in a corner, so
// an edit knows what the picture shows, where its words are, and where the speaker is.

struct ScreenLine: Codable {
    let text: String
    let x: Double
    let y: Double
    let w: Double
    let h: Double
}

struct ScreenSample: Codable {
    let t: Double
    let lines: [ScreenLine]
    let faces: [Face]
    let windows: [Face]
}

func runScreen(_ a: [String]) -> Never {
    guard a.count >= 2 else { fail("usage: chopshop-vision --screen <video> [startSec] [durationSec] [samplesPerSec]") }
    let url = URL(fileURLWithPath: a[1])
    let start = a.count > 2 ? Double(a[2]) ?? 0 : 0
    let wanted = a.count > 3 ? Double(a[3]) ?? 0 : 0
    let rate = a.count > 4 ? max(0.05, min(4, Double(a[4]) ?? 0.5)) : 0.5
    let asset = AVURLAsset(url: url)
    let total = CMTimeGetSeconds(asset.duration)
    guard total.isFinite, total > 0 else { fail("could not read duration") }
    let duration = wanted > 0 ? min(wanted, total - start) : total - start
    guard duration > 0 else { fail("range is outside the video") }

    let generator = AVAssetImageGenerator(asset: asset)
    generator.appliesPreferredTrackTransform = true
    generator.requestedTimeToleranceBefore = CMTime(seconds: 0.1, preferredTimescale: 600)
    generator.requestedTimeToleranceAfter = CMTime(seconds: 0.1, preferredTimescale: 600)
    // Words on a screen recording read at this size; smaller loses the small print.
    generator.maximumSize = CGSize(width: 1920, height: 1920)

    func flipped(_ box: CGRect) -> Face {
        return Face(x: Double(box.origin.x), y: Double(1.0 - box.origin.y - box.height), w: Double(box.width), h: Double(box.height))
    }
    var samples: [ScreenSample] = []
    var n = 0
    while Double(n) / rate < duration {
        let t = Double(n) / rate
        n += 1
        guard let image = try? generator.copyCGImage(at: CMTime(seconds: start + t, preferredTimescale: 600), actualTime: nil) else { continue }
        let text = VNRecognizeTextRequest()
        // Fast reads a page of text in a few tens of milliseconds: enough to know what it says and where.
        text.recognitionLevel = .fast
        text.usesLanguageCorrection = false
        let faces = VNDetectFaceRectanglesRequest()
        let boxes = VNDetectRectanglesRequest()
        boxes.minimumSize = 0.08
        boxes.maximumObservations = 8
        boxes.minimumConfidence = 0.5
        boxes.minimumAspectRatio = 0.3
        boxes.maximumAspectRatio = 1.0
        boxes.quadratureTolerance = 12
        let handler = VNImageRequestHandler(cgImage: image, orientation: .up, options: [:])
        try? handler.perform([text, faces, boxes])
        let lines: [ScreenLine] = (text.results ?? []).compactMap { obs in
            guard let read = obs.topCandidates(1).first?.string, !read.trimmingCharacters(in: .whitespaces).isEmpty else { return nil }
            let f = flipped(obs.boundingBox)
            return ScreenLine(text: String(read.prefix(160)), x: f.x, y: f.y, w: f.w, h: f.h)
        }
        let found = (faces.results ?? []).map { flipped($0.boundingBox) }
        // A window is a box smaller than the frame with a face inside it.
        let windows: [Face] = (boxes.results ?? []).map { flipped($0.boundingBox) }.filter { box in
            box.w * box.h < 0.5 && found.contains { f in
                let cx = f.x + f.w / 2
                let cy = f.y + f.h / 2
                return cx > box.x && cx < box.x + box.w && cy > box.y && cy < box.y + box.h
            }
        }
        samples.append(ScreenSample(t: t, lines: lines, faces: found, windows: windows))
    }
    let encoder = JSONEncoder()
    guard let data = try? encoder.encode(samples), let json = String(data: data, encoding: .utf8) else { fail("could not encode results") }
    print(json)
    exit(0)
}
