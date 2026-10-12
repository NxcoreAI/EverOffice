// vision-ocr — 本地屏幕记忆的 OCR 助手（macOS Vision）。
//
// 用法：
//   vision-ocr --version
//   vision-ocr --frontmost
//   vision-ocr <image> [--fast] [--compress-out <path>]
//   vision-ocr --daemon
//
// daemon 协议：stdin 逐行请求 JSON，stdout 逐行响应 JSON（同序）：
//   请求 {"id":"...","op":"ping"}
//        {"id":"...","op":"frontmost"}
//        {"id":"...","op":"ocr","image":"/abs/path.jpg","level":"accurate|fast","compressOut":"/abs/out.jpg"}
//   响应 {"id":"...","ok":true,"result":{...}} 或 {"id":"...","ok":false,"error":"..."}
// OCR result：{width,height,elapsedMs,lines:[{text,confidence,box:[x,y,w,h](归一化)}],
//              compressedPath,compressedBytes}（compressOut 提供时后两项存在）
// frontmost result：{bundleId,appName,pid,windowTitle}（窗口标题依赖屏幕录制权限，无权限时为 null）
// OCR 请求串行处理；box 为归一化坐标（0–1，原点左下，Vision 原生系），压缩图坐标按比例映射不变。

import AppKit
import CoreGraphics
import Foundation
import ImageIO
import Vision

let TOOL_VERSION = "1.0.0"

struct OcrError: Error { let message: String }

func loadImage(_ path: String) throws -> CGImage {
  guard let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil),
        let cg = CGImageSourceCreateImageAtIndex(src, 0, nil) else {
    throw OcrError(message: "cannot read image: \(path)")
  }
  return cg
}

func runOcr(_ cg: CGImage, level: VNRequestTextRecognitionLevel) throws -> ([[String: Any]], Double) {
  let request = VNRecognizeTextRequest()
  request.recognitionLevel = level
  request.recognitionLanguages = ["zh-Hans", "en-US"]
  request.usesLanguageCorrection = true
  let handler = VNImageRequestHandler(cgImage: cg, options: [:])
  let start = Date()
  try handler.perform([request])
  let elapsedMs = Date().timeIntervalSince(start) * 1000
  var lines: [[String: Any]] = []
  for obs in request.results ?? [] {
    guard let top = obs.topCandidates(1).first else { continue }
    let b = obs.boundingBox
    lines.append([
      "text": top.string,
      "confidence": Double(top.confidence),
      "box": [Double(b.origin.x), Double(b.origin.y), Double(b.width), Double(b.height)],
    ])
  }
  return (lines, elapsedMs)
}

func compressImage(_ cg: CGImage, longEdge: CGFloat, quality: CGFloat, to path: String) throws -> Int {
  let w = CGFloat(cg.width), h = CGFloat(cg.height)
  let scale = min(1, longEdge / max(w, h))
  let targetW = max(1, (w * scale).rounded())
  let targetH = max(1, (h * scale).rounded())
  guard let colorSpace = CGColorSpace(name: CGColorSpace.sRGB),
        let ctx = CGContext(data: nil, width: Int(targetW), height: Int(targetH),
                            bitsPerComponent: 8, bytesPerRow: 0, space: colorSpace,
                            bitmapInfo: CGImageAlphaInfo.noneSkipFirst.rawValue) else {
    throw OcrError(message: "cannot create compression context")
  }
  ctx.interpolationQuality = .high
  ctx.draw(cg, in: CGRect(x: 0, y: 0, width: targetW, height: targetH))
  guard let scaled = ctx.makeImage(),
        let dest = CGImageDestinationCreateWithURL(URL(fileURLWithPath: path) as CFURL, "public.jpeg" as CFString, 1, nil) else {
    throw OcrError(message: "cannot create jpeg destination: \(path)")
  }
  CGImageDestinationAddImage(dest, scaled, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
  guard CGImageDestinationFinalize(dest) else {
    throw OcrError(message: "jpeg encode failed: \(path)")
  }
  let attrs = try? FileManager.default.attributesOfItem(atPath: path)
  return (attrs?[.size] as? Int) ?? 0
}

func frontmostInfo() -> [String: Any?] {
  let app = NSWorkspace.shared.frontmostApplication
  var title: String?
  if let pid = app?.processIdentifier {
    let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
    if let infos = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] {
      for info in infos {
        guard let ownerPid = info[kCGWindowOwnerPID as String] as? Int32, ownerPid == pid,
              let layer = info[kCGWindowLayer as String] as? Int, layer == 0 else { continue }
        if let name = info[kCGWindowName as String] as? String, !name.isEmpty { title = name; break }
      }
    }
  }
  return [
    "bundleId": app?.bundleIdentifier,
    "appName": app?.localizedName,
    "pid": app?.processIdentifier,
    "windowTitle": title,
  ]
}

func ocrEnvelope(imagePath: String, level: VNRequestTextRecognitionLevel, compressOut: String?) -> [String: Any] {
  do {
    let cg = try loadImage(imagePath)
    let (lines, elapsedMs) = try runOcr(cg, level: level)
    var result: [String: Any] = [
      "width": cg.width,
      "height": cg.height,
      "elapsedMs": elapsedMs,
      "lines": lines,
    ]
    if let out = compressOut {
      let bytes = try compressImage(cg, longEdge: 1600, quality: 0.55, to: out)
      result["compressedPath"] = out
      result["compressedBytes"] = bytes
    }
    return ["ok": true, "result": result]
  } catch let e as OcrError {
    return ["ok": false, "error": e.message]
  } catch {
    return ["ok": false, "error": "vision failed: \(error)"]
  }
}

func handleDaemonRequest(_ raw: String) -> [String: Any] {
  guard let data = raw.data(using: .utf8),
        let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
    return ["id": NSNull(), "ok": false, "error": "bad request json"]
  }
  let id = obj["id"] ?? NSNull()
  guard let op = obj["op"] as? String else {
    return ["id": id, "ok": false, "error": "missing op"]
  }
  switch op {
  case "ping":
    return ["id": id, "ok": true, "result": ["pong": true, "version": TOOL_VERSION]]
  case "frontmost":
    let info = frontmostInfo()
    let wrapped: [String: Any] = info.mapValues { $0 ?? NSNull() }
    return ["id": id, "ok": true, "result": wrapped]
  case "ocr":
    guard let imagePath = obj["image"] as? String else {
      return ["id": id, "ok": false, "error": "missing image"]
    }
    let level: VNRequestTextRecognitionLevel = (obj["level"] as? String) == "fast" ? .fast : .accurate
    let compressOut = obj["compressOut"] as? String
    var envelope = ocrEnvelope(imagePath: imagePath, level: level, compressOut: compressOut)
    envelope["id"] = id
    return envelope
  default:
    return ["id": id, "ok": false, "error": "unknown op: \(op)"]
  }
}

let args = CommandLine.arguments

func printEnvelope(_ envelope: [String: Any]) {
  if let data = try? JSONSerialization.data(withJSONObject: envelope, options: [.sortedKeys]),
     let text = String(data: data, encoding: .utf8) {
    print(text)
    fflush(stdout)
  }
}

if args.contains("--version") {
  print("vision-ocr \(TOOL_VERSION)")
  exit(0)
}

if args.contains("--frontmost") {
  let info = frontmostInfo().mapValues { $0 ?? NSNull() }
  printEnvelope(["ok": true, "result": info])
  exit(0)
}

if args.contains("--daemon") {
  while let line = readLine() {
    let trimmed = line.trimmingCharacters(in: .whitespaces)
    if trimmed.isEmpty { continue }
    printEnvelope(handleDaemonRequest(trimmed))
  }
  exit(0)
}

if args.count >= 2 {
  let imagePath = args[1]
  var level: VNRequestTextRecognitionLevel = .accurate
  if let flagIndex = args.firstIndex(of: "--fast") { _ = flagIndex; level = .fast }
  var compressOut: String?
  if let outIndex = args.firstIndex(of: "--compress-out"), args.indices.contains(outIndex + 1) {
    compressOut = args[outIndex + 1]
  }
  let envelope = ocrEnvelope(imagePath: imagePath, level: level, compressOut: compressOut)
  printEnvelope(envelope)
  exit((envelope["ok"] as? Bool) == true ? 0 : 3)
}

FileHandle.standardError.write("usage: vision-ocr <image> [--fast] [--compress-out <path>] | --daemon | --frontmost | --version\n".data(using: .utf8)!)
exit(2)
