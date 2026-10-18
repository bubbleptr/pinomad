import PinomadCore

/// The add-project folder picker's state: the folder shown, whether a
/// navigation is in flight, and its error. Only the newest navigation's
/// answer lands — tapping through folders quickly must not let a slower
/// earlier answer replace where the reader is now.
public struct FolderBrowser: Equatable, Sendable {
    /// Identifies one navigation.
    public struct Token: Equatable, Sendable {
        let generation: Int
    }

    public private(set) var listing: FolderListing?
    public private(set) var loading = false
    public private(set) var error: String?
    /// The folder the newest navigation asked for (nil = the host user's
    /// home) — what "再试一次" asks again.
    public private(set) var retryPath: String?
    private var generation = 0

    public init() {}

    public mutating func go(to path: String?) -> Token {
        generation += 1
        loading = true
        error = nil
        retryPath = path
        return Token(generation: generation)
    }

    public mutating func land(_ token: Token, _ next: FolderListing) {
        guard token.generation == generation else { return }
        listing = next
        loading = false
    }

    /// Keeps the last good listing so its crumbs stay usable.
    public mutating func fail(_ token: Token, _ message: String) {
        guard token.generation == generation else { return }
        error = message
        loading = false
    }
}
