import Foundation
import Network

struct HTTPRequest {
  let method: String
  let path: String
  let headers: [String: String]
  let body: Data
}

struct HTTPResponse {
  let status: Int
  let contentType: String
  let body: Data
  let extraHeaders: [String: String]

  static func json<T: Encodable>(_ value: T, status: Int = 200) -> HTTPResponse {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.withoutEscapingSlashes]
    let data = (try? encoder.encode(value)) ?? Data("{\"ok\":false}".utf8)
    return HTTPResponse(
      status: status,
      contentType: "application/json; charset=utf-8",
      body: data,
      extraHeaders: [:]
    )
  }
}

final class HTTPServer {
  typealias Handler = (HTTPRequest) async -> HTTPResponse

  private static let maximumRequestBytes = 2_147_483_648
  private let queue = DispatchQueue(label: "excalicord.http")
  private let handler: Handler
  private var listener: NWListener?

  init(handler: @escaping Handler) {
    self.handler = handler
  }

  func start(port: UInt16 = 5002) throws {
    let parameters = NWParameters.tcp
    parameters.allowLocalEndpointReuse = true
    parameters.requiredLocalEndpoint = .hostPort(
      host: "127.0.0.1",
      port: NWEndpoint.Port(rawValue: port)!
    )
    let listener = try NWListener(using: parameters)
    listener.newConnectionHandler = { [weak self] connection in
      self?.accept(connection)
    }
    listener.stateUpdateHandler = { state in
      switch state {
      case .ready:
        fputs("Excalicord Capture Agent listening on 127.0.0.1:\(port)\n", stderr)
      case .failed(let error):
        fputs("Capture Agent listener failed: \(error)\n", stderr)
      default:
        break
      }
    }
    listener.start(queue: queue)
    self.listener = listener
  }

  private func accept(_ connection: NWConnection) {
    guard case .hostPort(let host, _) = connection.endpoint,
          host.debugDescription.contains("127.0.0.1") ||
            host.debugDescription.contains("::1") ||
            host.debugDescription.contains("localhost") else {
      connection.cancel()
      return
    }
    connection.start(queue: queue)
    receive(on: connection, buffer: Data())
  }

  private func receive(on connection: NWConnection, buffer: Data) {
    connection.receive(minimumIncompleteLength: 1, maximumLength: 1_048_576) {
      [weak self] data, _, isComplete, error in
      guard let self else { return }
      var accumulated = buffer
      if let data { accumulated.append(data) }

      if let request = self.parseRequest(accumulated) {
        let origin = self.allowedOrigin(request.headers["origin"])
        Task {
          let response = await self.handler(request)
          self.send(response, on: connection, origin: origin)
        }
        return
      }

      if isComplete || error != nil || accumulated.count > Self.maximumRequestBytes {
        self.send(
          HTTPResponse.json(
            CommandResponse(
              ok: false,
              state: "error",
              message: "Invalid HTTP request",
              outputPath: nil
            ),
            status: 400
          ),
          on: connection,
          origin: "http://localhost:5001"
        )
        return
      }
      self.receive(on: connection, buffer: accumulated)
    }
  }

  private func parseRequest(_ data: Data) -> HTTPRequest? {
    guard let marker = "\r\n\r\n".data(using: .utf8),
          let headerRange = data.range(of: marker),
          let headerText = String(data: data[..<headerRange.lowerBound], encoding: .utf8)
    else { return nil }

    let lines = headerText.components(separatedBy: "\r\n")
    guard let requestLine = lines.first else { return nil }
    let parts = requestLine.split(separator: " ")
    guard parts.count >= 2 else { return nil }

    var headers: [String: String] = [:]
    for line in lines.dropFirst() {
      guard let separator = line.firstIndex(of: ":") else { continue }
      let key = line[..<separator].trimmingCharacters(in: .whitespaces).lowercased()
      let value = line[line.index(after: separator)...]
        .trimmingCharacters(in: .whitespaces)
      headers[key] = value
    }

    let bodyStart = headerRange.upperBound
    let contentLength = Int(headers["content-length"] ?? "0") ?? 0
    guard data.count >= bodyStart + contentLength else { return nil }
    let body = data.subdata(in: bodyStart..<(bodyStart + contentLength))
    return HTTPRequest(
      method: String(parts[0]),
      path: String(parts[1]).components(separatedBy: "?").first ?? "/",
      headers: headers,
      body: body
    )
  }

  private func allowedOrigin(_ origin: String?) -> String {
    switch origin {
    case "http://localhost:5001", "http://127.0.0.1:5001":
      return origin!
    default:
      return "http://localhost:5001"
    }
  }

  private func send(
    _ response: HTTPResponse,
    on connection: NWConnection,
    origin: String
  ) {
    let reason: String
    switch response.status {
    case 200: reason = "OK"
    case 204: reason = "No Content"
    case 400: reason = "Bad Request"
    case 403: reason = "Forbidden"
    case 404: reason = "Not Found"
    case 409: reason = "Conflict"
    default: reason = "Internal Server Error"
    }

    var headers = [
      "HTTP/1.1 \(response.status) \(reason)",
      "Content-Type: \(response.contentType)",
      "Content-Length: \(response.body.count)",
      "Connection: close",
      "Cache-Control: no-store",
      "Access-Control-Allow-Origin: \(origin)",
      "Access-Control-Allow-Methods: GET, POST, OPTIONS",
      "Access-Control-Allow-Headers: Content-Type, X-Excalicord-Token, X-Excalicord-File-Name",
    ]
    response.extraHeaders.forEach { headers.append("\($0.key): \($0.value)") }
    let head = Data((headers.joined(separator: "\r\n") + "\r\n\r\n").utf8)
    connection.send(content: head + response.body, completion: .contentProcessed { _ in
      connection.cancel()
    })
  }
}
