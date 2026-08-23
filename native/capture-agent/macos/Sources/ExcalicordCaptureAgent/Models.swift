import Foundation

struct HealthResponse: Codable {
  let ok: Bool
  let protocolVersion: Int
  let platform: String
  let state: String
  let capabilities: [String]
  let permissions: [String: Bool]
  let token: String
}

struct CaptureSource: Codable {
  let id: String
  let type: String
  let name: String
  let width: Int
  let height: Int
  let application: String?
  let thumbnail: String?
}

struct SourcesResponse: Codable {
  let displays: [CaptureSource]
  let windows: [CaptureSource]
}

struct CaptureStartRequest: Codable {
  let sourceType: String
  let sourceId: String
  let sessionId: String?
  let cameraEnabled: Bool?
  let microphoneEnabled: Bool?
  let cameraX: Double?
  let cameraY: Double?
  let cameraSize: Double?
  let cameraMirrored: Bool?
  let smoothing: Double?
  let whitening: Double?
  let lightIntensity: Double?
}

struct CommandResponse: Codable {
  let ok: Bool
  let state: String
  let message: String?
  let outputPath: String?
}

struct StatusResponse: Codable {
  let ok: Bool
  let state: String
  let seconds: Double
  let outputPath: String?
  let error: String?
}

struct SaveFolderResponse: Codable {
  let ok: Bool
  let path: String
  let isDefault: Bool
}

struct FolderSelectionCancelledResponse: Codable {
  let ok: Bool
  let cancelled: Bool
}

struct SaveRecordingResponse: Codable {
  let ok: Bool
  let path: String
  let fileName: String
  let overwritten: Bool
}

struct ProjectFileRequest: Codable {
  let path: String
  let content: String?
}

struct ProjectFileResponse: Codable {
  let ok: Bool
  let path: String
  let bytes: Int
}

struct ProjectFileReadResponse: Codable {
  let ok: Bool
  let found: Bool
  let path: String
  let content: String?
}

enum AgentError: LocalizedError {
  case badRequest(String)
  case sourceNotFound
  case alreadyRecording
  case notRecording
  case noRecording
  case capture(String)

  var errorDescription: String? {
    switch self {
    case .badRequest(let message): return message
    case .sourceNotFound: return "Capture source was not found"
    case .alreadyRecording: return "A recording is already active"
    case .notRecording: return "No recording is active"
    case .noRecording: return "No completed recording is available"
    case .capture(let message): return message
    }
  }
}
