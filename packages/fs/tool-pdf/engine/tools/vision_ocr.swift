import Foundation
import Vision
import ImageIO
import CoreGraphics

struct OCRLine: Codable {
    let text: String
    let confidence: Float
    let bbox: [Int]
}

func loadImage(_ path: String) -> CGImage? {
    let url = URL(fileURLWithPath: path) as CFURL
    guard let source = CGImageSourceCreateWithURL(url, nil) else { return nil }
    return CGImageSourceCreateImageAtIndex(source, 0, nil)
}

guard CommandLine.arguments.count >= 3 else {
    fputs("usage: vision_ocr IMAGE OUTPUT_JSON\n", stderr)
    exit(2)
}

let imagePath = CommandLine.arguments[1]
let outputPath = CommandLine.arguments[2]
guard let image = loadImage(imagePath) else {
    fputs("cannot load image: \(imagePath)\n", stderr)
    exit(3)
}

let width = image.width
let height = image.height
let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = true
request.recognitionLanguages = ["zh-Hans", "en-US"]
request.minimumTextHeight = 0.006

do {
    try VNImageRequestHandler(cgImage: image, options: [:]).perform([request])
} catch {
    fputs("Vision OCR failed: \(error)\n", stderr)
    exit(4)
}

let observations = request.results ?? []
let lines: [OCRLine] = observations.compactMap { observation in
    guard let candidate = observation.topCandidates(1).first else { return nil }
    let box = observation.boundingBox
    let left = Int(box.minX * CGFloat(width))
    let right = Int(box.maxX * CGFloat(width))
    let top = Int((1.0 - box.maxY) * CGFloat(height))
    let bottom = Int((1.0 - box.minY) * CGFloat(height))
    return OCRLine(text: candidate.string, confidence: candidate.confidence,
                   bbox: [left, top, right, bottom])
}.sorted { lhs, rhs in
    if abs(lhs.bbox[1] - rhs.bbox[1]) > 8 { return lhs.bbox[1] < rhs.bbox[1] }
    return lhs.bbox[0] < rhs.bbox[0]
}

let encoder = JSONEncoder()
encoder.outputFormatting = [.prettyPrinted, .withoutEscapingSlashes]
let data = try encoder.encode(lines)
try data.write(to: URL(fileURLWithPath: outputPath))
