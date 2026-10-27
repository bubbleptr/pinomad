import Foundation
import Testing
@testable import PinomadChat
import PinomadCore

private func user(_ id: String, _ text: String, at timestamp: Double? = nil) -> ChatEntry {
    .user(id: id, text: text, images: [], timestamp: timestamp)
}

private func run(_ id: String) -> ChatEntry {
    .run(
        id: id,
        cot: CotView(
            phase: .settled, failed: false, anchorMs: nil, elapsedMs: nil,
            todoWrittenAtMs: nil, steps: [], answer: nil
        ),
        forkEntryId: nil, interrupted: false, failure: nil
    )
}

private func local(
    _ requestId: String,
    _ text: String = "hi",
    status: SubmissionStatus = .failed,
    error: String? = nil
) -> LocalSubmission {
    LocalSubmission(
        requestId: requestId, text: text, images: [], skills: [],
        attachmentIds: [], status: status, error: error
    )
}

@Suite struct TranscriptTests {
    @Test func onlyTheNewestCommittedBubbleIsDelivered() {
        let rows = Transcript.rows(chat: [user("u1", "one"), user("u2", "two"), run("r1")], local: [])
        #expect(rows.count == 3)
        guard case let .entry(first, firstStatus) = rows[0],
              case let .entry(second, secondStatus) = rows[1],
              case let .entry(third, thirdStatus) = rows[2]
        else {
            Issue.record("expected committed entries")
            return
        }
        #expect(first.entryId == "u1")
        #expect(firstStatus == nil)
        #expect(second.entryId == "u2")
        #expect(secondStatus == .delivered)
        #expect(third.entryId == "r1")
        #expect(thirdStatus == nil)
    }

    @Test func localRowsNeverBecomeTheLatestCommittedBubble() {
        let rows = Transcript.rows(
            chat: [user("u1", "one"), user("u2", "two")],
            local: [local("a", "sending", status: .sending), local("b", "failed")]
        )
        #expect(rows.count == 4)
        guard case let .entry(second, status) = rows[1] else {
            Issue.record("expected the committed bubble")
            return
        }
        #expect(second.entryId == "u2")
        #expect(status == .delivered)
        guard case let .local(first) = rows[2], case let .local(secondLocal) = rows[3] else {
            Issue.record("expected the local bubbles")
            return
        }
        #expect(first.status == .sending)
        #expect(secondLocal.status == .failed)
        #expect(first.id == "local:a")
    }

    @Test func noCommittedUserMeansNoDeliveredMark() {
        let rows = Transcript.rows(chat: [run("r1")], local: [local("a")])
        guard case let .entry(_, status) = rows[0] else {
            Issue.record("expected the run")
            return
        }
        #expect(status == nil)
    }

    @Test func localRowsMapTheirPhaseAndKeepTheComposerFiles() {
        let files = [UserAttachment(id: "f1", name: "build.log", size: 42)]
        let rows = Transcript.rows(
            chat: [],
            local: [local("a", "waiting", status: .unknown, error: "offline")],
            attachmentDetails: ["a": files]
        )
        guard case let .local(row) = rows[0] else {
            Issue.record("expected a local row")
            return
        }
        #expect(row.status == .unknown)
        #expect(row.error == "offline")
        #expect(row.attachments == files)
        #expect(MessageStatus(.unknown) == .unknown)
        #expect(MessageStatus(.sending) == .sending)
        #expect(MessageStatus(.failed) == .failed)
    }
}

@Suite struct QueuedRowsTests {
    @Test func hostRowsSaySentAndLocalRowsKeepTheirPhase() {
        let host = QueueItem(id: 7, mode: .followUp, text: "later", imageCount: 1, attachmentCount: 0)
        let waiting = LocalQueueItem(
            requestId: "r1", mode: .steer, text: "now", imageCount: 0,
            attachmentCount: 2, status: .unknown, error: nil
        )
        let rows = QueuedList.rows(host: [host], local: [waiting])
        #expect(rows.count == 2)
        guard case let .host(hostRow) = rows[0],
              case let .local(localRow) = rows[1]
        else {
            Issue.record("expected a host row then a local row")
            return
        }
        #expect(QueuedRow.host(hostRow).status == .sent)
        #expect(hostRow.id == 7)
        #expect(QueuedRow.local(localRow).status == .unknown)
        #expect(rows[1].id == "local:r1")
        #expect(localRow.attachmentCount == 2)
    }
}
