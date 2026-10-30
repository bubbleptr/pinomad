import Foundation

/// A conversation identified across every paired host (ADR-0035 §1). Inside
/// one host the protocol still uses the bare id.
public struct ConversationRef: Hashable, Sendable, Codable {
    public var hostKey: String
    public var conversationId: UInt64

    public init(hostKey: String, conversationId: UInt64) {
        self.hostKey = hostKey
        self.conversationId = conversationId
    }
}

/// What the screen shows: one host, with a conversation or its new-conversation
/// draft (ADR-0035 §2).
public struct HostFocus: Equatable, Sendable {
    public var hostKey: String
    public var conversationId: UInt64?

    public init(hostKey: String, conversationId: UInt64? = nil) {
        self.hostKey = hostKey
        self.conversationId = conversationId
    }

    public var conversation: ConversationRef? {
        conversationId.map { ConversationRef(hostKey: hostKey, conversationId: $0) }
    }
}

/// The pure part of the app's runtime table: stored order, the one focus, and
/// which conversation a focus change must release (ADR-0035 §1, §2). The
/// runtime objects themselves stay in the app's composition root.
public struct HostRuntimeTable: Equatable, Sendable {
    public private(set) var hostKeys: [String]
    public private(set) var focus: HostFocus?
    /// Where focus returns to when its host is forgotten. Remembered at
    /// launch; later focus changes do not rewrite it, exactly like the keychain
    /// value it came from.
    private var fallbackHostKey: String?

    public init(hostKeys: [String], rememberedHostKey: String? = nil) {
        self.hostKeys = hostKeys
        self.fallbackHostKey = rememberedHostKey
        self.focus = Self.initialFocus(hostKeys: hostKeys, rememberedHostKey: rememberedHostKey)
    }

    public var focusedConversation: ConversationRef? { focus?.conversation }

    public func contains(_ hostKey: String) -> Bool {
        hostKeys.contains(hostKey)
    }

    /// Bring the table in line with the stored hosts. Returns the conversation
    /// whose host disappeared while focused — that runtime must clear it.
    @discardableResult
    public mutating func synchronize(_ next: [String]) -> ConversationRef? {
        hostKeys = next
        guard let current = focus else {
            focus = Self.initialFocus(hostKeys: next, rememberedHostKey: fallbackHostKey)
            return nil
        }
        if next.contains(current.hostKey) { return nil }
        let released = current.conversation
        focus = Self.initialFocus(hostKeys: next, rememberedHostKey: fallbackHostKey)
        return released
    }

    /// Focus a host's draft or conversation. A conversation that leaves the
    /// screen is returned so its runtime can release the subscription; a
    /// same-host switch stays with the core's own switchConversation.
    @discardableResult
    public mutating func focus(_ next: HostFocus) -> ConversationRef? {
        guard hostKeys.contains(next.hostKey), focus != next else { return nil }
        let released = releasedConversation(switchingTo: next)
        focus = next
        return released
    }

    @discardableResult
    public mutating func focusConversation(_ ref: ConversationRef) -> ConversationRef? {
        focus(HostFocus(hostKey: ref.hostKey, conversationId: ref.conversationId))
    }

    @discardableResult
    public mutating func focusDraft(on hostKey: String) -> ConversationRef? {
        focus(HostFocus(hostKey: hostKey))
    }

    /// Focus what the visible page shows (#429): its host's conversation or
    /// draft. A page of no host — the home page, a cross-machine list —
    /// keeps the focused host, which is where New starts, but not its
    /// conversation.
    @discardableResult
    public mutating func followPage(_ page: HostFocus?) -> ConversationRef? {
        guard let target = page ?? focus.map({ HostFocus(hostKey: $0.hostKey) }) else { return nil }
        return focus(target)
    }

    /// A new pairing lands at the end of the stored order; a manual pairing
    /// also focuses it.
    @discardableResult
    public mutating func addPairedHost(_ hostKey: String, focus shouldFocus: Bool) -> ConversationRef? {
        if !hostKeys.contains(hostKey) { hostKeys.append(hostKey) }
        guard shouldFocus else { return nil }
        return focus(HostFocus(hostKey: hostKey))
    }

    /// Drop a forgotten host. Another host takes over when it was focused.
    @discardableResult
    public mutating func forget(_ hostKey: String) -> ConversationRef? {
        guard hostKeys.contains(hostKey) else { return nil }
        let wasFocused = focus?.hostKey == hostKey
        let released = wasFocused ? focus?.conversation : nil
        hostKeys.removeAll { $0 == hostKey }
        if wasFocused {
            focus = Self.initialFocus(hostKeys: hostKeys, rememberedHostKey: fallbackHostKey)
        }
        return released
    }

    private func releasedConversation(switchingTo next: HostFocus) -> ConversationRef? {
        guard let current = focus, let ref = current.conversation else { return nil }
        // Same host, another conversation: switchConversation releases it.
        // Moving to the draft still has to clear it explicitly.
        if current.hostKey == next.hostKey, next.conversationId != nil { return nil }
        return ref
    }

    private static func initialFocus(hostKeys: [String], rememberedHostKey: String?) -> HostFocus? {
        if let rememberedHostKey, hostKeys.contains(rememberedHostKey) {
            return HostFocus(hostKey: rememberedHostKey)
        }
        return hostKeys.first.map { HostFocus(hostKey: $0) }
    }
}
