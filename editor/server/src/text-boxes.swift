import AppKit
import Foundation
import Vision

let url = URL(fileURLWithPath: CommandLine.arguments[1])
guard let image = NSImage(contentsOf: url), let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else { exit(1) }
let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.recognitionLanguages = ["es-ES", "en-US"]
request.usesLanguageCorrection = true
try VNImageRequestHandler(cgImage: cg).perform([request])
var lines: [[String: Any]] = []
for observation in request.results ?? [] {
  guard let top = observation.topCandidates(1).first else { continue }
  let box = observation.boundingBox
  // Vision measures from the bottom-left corner; callers expect top-left.
  lines.append(["text": top.string, "x": box.minX, "y": 1 - box.maxY, "w": box.width, "h": box.height])
}
let output = try JSONSerialization.data(withJSONObject: ["lines": lines])
FileHandle.standardOutput.write(output)
