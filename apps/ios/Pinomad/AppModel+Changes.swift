import PinomadCore

extension AppModel {
    /// The conversation's parsed file changes, fetched by explicit id so a
    /// conversation switch on another screen cannot redirect the answer.
    /// Request-class: a host refusal arrives as `SessionError.operationFailed`.
    func changes(conversation id: UInt64) async throws -> ConversationChanges {
        #if DEBUG
        if let devChanges { return devChanges }
        #endif
        guard let session else { throw SessionError.sessionClosed }
        let result = try await session.invoke(.changes(conversationId: id))
        guard case .changes(let changes) = result else {
            throw SessionError.operationFailed("宿主返回了意外的改动结果")
        }
        return changes
    }
}
