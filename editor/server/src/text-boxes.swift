import AppKit
import Foundation
import Vision

// `--supported` prints the recognition languages this macOS offers, so the caller can map a brand locale onto them.
if CommandLine.arguments[1] == "--supported" {
  let probe = VNRecognizeTextRequest()
  probe.recognitionLevel = .accurate
  let supported = (try? probe.supportedRecognitionLanguages()) ?? []
  FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: supported))
  exit(0)
}
let url = URL(fileURLWithPath: CommandLine.arguments[1])
guard let image = NSImage(contentsOf: url), let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else { exit(1) }
let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
// Optional second argument: comma-separated recognition languages, already mapped to supported tags by the caller
// (the brand's locale first, English as a fallback). Detection is always on, so unmatched text is still read;
// automaticallyDetectsLanguage needs macOS 13+, older systems fall back to the listed languages.
if CommandLine.arguments.count > 2 {
  request.recognitionLanguages = CommandLine.arguments[2].split(separator: ",").map(String.init)
}
if #available(macOS 13.0, *) {
  request.automaticallyDetectsLanguage = true
}
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
