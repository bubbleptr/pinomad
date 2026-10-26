import Foundation

/// One append-only evidence file in the app container. All writes happen on
/// the controller's serial queue; `devicectl copy from` retrieves the result.
final class FileLogger {
    let url: URL
    private let handle: FileHandle?

    init() {
        let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        url = documents.appendingPathComponent("rtcspike.log")
        FileManager.default.createFile(atPath: url.path, contents: nil)
        handle = try? FileHandle(forWritingTo: url)
        handle?.seekToEndOfFile()
    }

    func write(_ line: String) {
        guard let data = (line + "\n").data(using: .utf8) else { return }
        handle?.write(data)
    }

    func close() {
        try? handle?.close()
    }
}
