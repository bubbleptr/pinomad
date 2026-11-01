import Foundation

// Confirming a host join by its short code (#497): `pinomad join <server>`
// without a token prints a code like KXHN-BWCV, and a signed-in device
// confirms it. The code is only ever typed by hand — no link carries it and
// the pasteboard isn't read for it — so a phished code takes a deliberate act.

/// The code field: what a person types, as the host prints it, and the one
/// form the server is sent.
public enum HostLinkCode {
    /// The server's alphabet: no vowels or Y (no words), nothing that looks
    /// like a digit.
    public static let alphabet: Set<Character> = Set("BCDFGHJKLMNPQRSTVWXZ")
    public static let length = 8

    /// `XXXX-XXXX` from whatever was typed: letters only, uppercased, at
    /// most eight of them.
    public static func format(_ input: String) -> String {
        let letters = input.uppercased().filter { $0.isASCII && $0.isLetter }.prefix(length)
        guard letters.count > 4 else { return String(letters) }
        return String(letters.prefix(4)) + "-" + String(letters.dropFirst(4))
    }

    /// The canonical code, or nil when it can't be one. The server counts a
    /// malformed code against the account's and the address's lockout, so
    /// nothing else is sent.
    public static func normalize(_ input: String) -> String? {
        let code = input.uppercased().filter { !$0.isWhitespace && $0 != "-" }
        guard code.count == length, code.allSatisfy(alphabet.contains) else { return nil }
        return code
    }
}

public enum HostLinkCopy {
    public enum Stage: Sendable {
        case lookup
        case confirm
        case deny
    }

    /// Install pinomad with its own Node (#499), then `pinomad up` (#498),
    /// which asks for a code to confirm here. The full path because a new Mac
    /// has no ~/.local/bin on PATH; `--origin` because up otherwise joins the
    /// official server.
    public static func joinCommand(serverOrigin: String) -> String {
        let origin = normalizeServerOrigin(origin: serverOrigin)
        let up = origin == OfficialServer.origin ? "pinomad up" : "pinomad up --origin \(origin)"
        return "curl -fsSL https://pinomad.si/install.sh | sh\n~/.local/bin/\(up)"
    }

    /// Both ends of the host id, to compare with the one `pinomad join`
    /// prints in full.
    public static func shortHostId(_ hostId: String) -> String {
        guard hostId.count > 12 else { return hostId }
        return hostId.prefix(6) + "…" + hostId.suffix(4)
    }

    public static let warning = "Only confirm a computer you are setting up yourself right now."

    public static let ipDiffersWarning =
        "This request came from a different network address than this iPhone. If you aren't at that computer, deny it."

    /// The once-per-host notice (#497). There's no removing a host from the
    /// account here; forgetting it stops this iPhone from connecting.
    public static func newHostsNotice(_ names: [String]) -> String {
        switch names.count {
        case 0: ""
        case 1: "New host \(names[0]) joined your account."
        default: "New hosts \(names.dropLast().joined(separator: ", ")) and \(names[names.count - 1]) joined your account."
        }
    }

    public static let newHostsHint =
        "If you didn't add it, forget it in Settings so this iPhone stops connecting to it."

    /// The server answers one 404 for a wrong, used or expired code.
    public static func message(_ failure: AccountFailure, stage: Stage) -> String {
        switch (failure.code, stage) {
        case ("not_found", .lookup), ("invalid_request", _):
            "No host is waiting for this code. Check it against the host, or run pinomad up there again for a new one."
        case ("not_found", _):
            "This code is no longer valid: it expired or was already used. Run pinomad up on the host again."
        case ("rate_limited", _):
            "Too many wrong codes. Wait a few minutes and try again."
        default:
            AccountCopy.message(failure)
        }
    }
}

/// The code field, the lookup, and the confirm page's answer, as one value
/// the view drives: each request starts with a `begin…` that returns what to
/// send (nil: nothing to send now) and ends with its `…Finished`, which an
/// answer for a step the reader already left doesn't change.
public struct HostLinkFlow: Equatable, Sendable {
    public enum Step: Equatable, Sendable {
        case entering
        case lookingUp(code: String)
        case reviewing(code: String, request: HostLinkRequest)
        case confirming(code: String, request: HostLinkRequest)
        case denying(code: String, request: HostLinkRequest)
        case joined(HostLinkRequest)
        case denied(HostLinkRequest)
    }

    public private(set) var step: Step = .entering
    /// The field's text, formatted.
    public private(set) var input = ""
    public private(set) var error: String?

    public init() {}

    public mutating func type(_ text: String) {
        let formatted = HostLinkCode.format(text)
        if formatted != input { error = nil }
        input = formatted
    }

    public var canLookUp: Bool {
        step == .entering && HostLinkCode.normalize(input) != nil
    }

    public mutating func beginLookup() -> String? {
        guard step == .entering, let code = HostLinkCode.normalize(input) else { return nil }
        step = .lookingUp(code: code)
        error = nil
        return code
    }

    public mutating func lookupFinished(code: String, _ result: Result<HostLinkRequest, AccountFailure>) {
        guard step == .lookingUp(code: code) else { return }
        switch result {
        case .success(let request):
            step = .reviewing(code: code, request: request)
        case .failure(let failure):
            step = .entering
            error = HostLinkCopy.message(failure, stage: .lookup)
        }
    }

    /// The request being looked at, from review until it is settled.
    public var request: HostLinkRequest? {
        switch step {
        case .reviewing(_, let request), .confirming(_, let request), .denying(_, let request),
             .joined(let request), .denied(let request):
            request
        case .entering, .lookingUp:
            nil
        }
    }

    public func isExpired(now: Date) -> Bool {
        guard let request else { return false }
        return PairingCodeCopy.remainingSeconds(expiresAt: request.expiresAt, now: now) == 0
    }

    /// Past its expiry the server would refuse anyway.
    public func canConfirm(now: Date) -> Bool {
        guard case .reviewing = step else { return false }
        return !isExpired(now: now)
    }

    public mutating func beginConfirm(now: Date) -> String? {
        guard canConfirm(now: now), case .reviewing(let code, let request) = step else { return nil }
        step = .confirming(code: code, request: request)
        error = nil
        return code
    }

    public mutating func confirmFinished(code: String, _ result: Result<Void, AccountFailure>) {
        guard case .confirming(code, let request) = step else { return }
        settle(code: code, request: request, result: result, stage: .confirm, done: .joined(request))
    }

    /// Deny only tidies up on the server, so an expired request can still
    /// be denied.
    public mutating func beginDeny() -> String? {
        guard case .reviewing(let code, let request) = step else { return nil }
        step = .denying(code: code, request: request)
        error = nil
        return code
    }

    public mutating func denyFinished(code: String, _ result: Result<Void, AccountFailure>) {
        guard case .denying(code, let request) = step else { return }
        settle(code: code, request: request, result: result, stage: .deny, done: .denied(request))
    }

    /// Back to an empty field: the confirm page was closed or finished.
    public mutating func startOver() {
        self = HostLinkFlow()
    }

    /// A dead code sends the reader back for a new one; anything else keeps
    /// the page to try again.
    private mutating func settle(
        code: String, request: HostLinkRequest, result: Result<Void, AccountFailure>,
        stage: HostLinkCopy.Stage, done: Step
    ) {
        switch result {
        case .success:
            step = done
        case .failure(let failure) where failure.code == "not_found":
            step = .entering
            error = HostLinkCopy.message(failure, stage: stage)
        case .failure(let failure):
            step = .reviewing(code: code, request: request)
            error = HostLinkCopy.message(failure, stage: stage)
        }
    }
}
