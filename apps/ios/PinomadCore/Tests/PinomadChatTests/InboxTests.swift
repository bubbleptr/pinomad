import Foundation
import Testing
@testable import PinomadChat
import PinomadCore

private func summary(_ id: UInt64, status: ConversationStatus? = nil, activity: SummaryActivity? = nil) -> ConversationSummary {
    ConversationSummary(
        id: id, kind: nil, parent: nil, forkedAt: nil, title: "c\(id)", status: status,
        updatedAt: nil, label: nil, role: nil, activity: activity)
}

private func node(_ id: UInt64, status: ConversationStatus? = nil, activity: SummaryActivity? = nil) -> ConversationNode {
    ConversationNode(summary: summary(id, status: status, activity: activity), children: [])
}

private func event(_ id: String, source: String = "user", handled: Bool = false) -> InboxEvent {
    InboxEvent(id: id, source: source, thread: nil, summary: "summary \(id)", trusted: true,
               receivedAt: 1_000, handled: handled)
}

private func task(
    _ id: String, conversation: UInt64? = nil, events: [InboxEvent] = [], inFlight: Bool = false,
    closed: Bool = false, failed: String? = nil, waiting: Bool = false, kind: String? = nil,
    questions: [PendingQuestion] = []
) -> InboxTask {
    InboxTask(id: id, title: "Task \(id)", createdAt: 0, conversationId: conversation, events: events,
              inFlight: inFlight, closed: closed, skipped: false, failed: failed, waiting: waiting, kind: kind,
              questions: questions)
}

private func inbox(intake: UInt64? = nil, tasks: [InboxTask] = [], sources: [InboxSource] = []) -> ProjectInbox {
    ProjectInbox(project: "/p", intake: intake, tasks: tasks, threads: [:], rules: "", followUps: [], sources: sources,
                 baseBranch: nil)
}

private func question(_ id: String, kind: String = "ask_user_question") -> PendingQuestion {
    PendingQuestion(kind: kind, request: QuestionRequest(id: id, questions: [], askedAt: 0, resolution: nil))
}

private func tool(
    state: ToolPartState = .outputAvailable, args: String? = nil, callId: String? = "call-1",
    name: String? = "inbox_submit", pinomad: PinomadToolDetail? = nil
) -> ToolItem {
    ToolItem(state: state, argsText: args, children: [], diffStat: nil, durationMs: nil, images: [],
             output: nil, toolCallId: callId, toolName: name, pinomad: pinomad)
}

private func cot(_ tools: [ToolItem]) -> CotView {
    CotView(phase: .settled, failed: false, anchorMs: nil, elapsedMs: nil, todoWrittenAtMs: nil,
            steps: [.tools(id: "s1", tools: tools, live: false, activeToolCallId: nil)], answer: nil)
}

@Suite struct InboxPlacementTests {
    private let inboxes = [inbox(intake: 9, tasks: [task("t1", conversation: 3), task("t2")])]

    @Test func inboxModeStaysUnavailableWhileDisabled() {
        #expect(!Inbox.modeAvailable(inboxes))
        // The snapshots still identify old conversations so coding can hide them.
        #expect(Inbox.conversationIds(inboxes) == [3, 9])
    }

    /// ADR-0051 §2: the intake and task conversations are listed in Inbox mode only.
    @Test func codingViewDropsTheInboxConversationsFromProjects() {
        let organized = Organized(
            chats: [node(1)],
            projects: [ProjectConversations(project: Project(path: "/p", name: "p", addedAt: nil),
                                            conversations: [node(3), node(4), node(9)])],
            archived: [])
        let view = Inbox.codingView(organized, inboxes: inboxes)
        #expect(view.chats.map(\.summary.id) == [1])
        #expect(view.projects[0].conversations.map(\.summary.id) == [4])
        #expect(Inbox.codingView(organized, inboxes: nil) == organized)
    }

    @Test func anInboxForkIsReadOnlyWhileDisabled() {
        let fork = ConversationNode(summary: ConversationSummary(
            id: 10, kind: .fork, parent: 3, forkedAt: nil, title: "Fork", status: nil,
            updatedAt: nil, label: nil, role: nil, activity: nil), children: [])
        let organized = Organized(
            chats: [],
            projects: [ProjectConversations(project: Project(path: "/p", name: "p", addedAt: nil),
                                            conversations: [node(3), node(4)])],
            archived: [])
        var withFork = organized
        withFork.projects[0].conversations[0].children = [fork]
        #expect(Inbox.isReadOnly(organized: withFork, inboxes: inboxes, conversationId: 10))
        #expect(!Inbox.isReadOnly(organized: withFork, inboxes: inboxes, conversationId: 10, modeEnabled: true))
        #expect(!Inbox.isReadOnly(organized: withFork, inboxes: inboxes, conversationId: 4))
    }

    @Test func placeFindsTheIntakeOrTheTask() {
        #expect(Inbox.place(of: 9, in: inboxes)?.task == nil)
        #expect(Inbox.place(of: 9, in: inboxes)?.inbox.project == "/p")
        #expect(Inbox.place(of: 3, in: inboxes)?.task?.id == "t1")
        #expect(Inbox.place(of: 4, in: inboxes) == nil)
        #expect(Inbox.place(of: nil, in: inboxes) == nil)
    }

    @Test func aBatchShowsTheEventsTheInboxStillListsInDeliveryOrder() {
        let listed = task("t1", events: [event("a"), event("b")])
        #expect(Inbox.batchEvents(["b", "gone", "a"], task: listed).map(\.id) == ["b", "a"])
        #expect(Inbox.batchEvents(["a"], task: nil).isEmpty)
    }
}

@Suite struct InboxSectionsTests {
    /// The groups come in the sidebar's order, empty ones left out; a queued
    /// task says its place, a running one what it is doing.
    @Test func groupsReadAsTheWebDoes() {
        let project = inbox(tasks: [
            task("q1", events: [event("e1")]),
            task("run", conversation: 5, events: [event("e2", handled: true)], inFlight: true),
            task("ask", conversation: 6, events: [event("e3", handled: true)]),
            task("q2", events: [event("e4")]),
            task("done", conversation: 7, closed: true),
        ])
        let summaries = Inbox.summaries(Organized(
            chats: [],
            projects: [ProjectConversations(project: Project(path: "/p", name: "p", addedAt: nil), conversations: [
                node(5, status: .running, activity: SummaryActivity(tool: "mcp__gh__issue", target: "#4")),
                node(6, status: .needsAnswer),
                node(7),
            ])],
            archived: []))
        let sections = Inbox.sections(project, summaries: summaries)
        #expect(sections.map(\.title) == ["Waiting for you", "In progress", "Queued", "Done"])
        #expect(sections[0].tasks.map(\.text) == ["Needs your answer"])
        #expect(sections[1].tasks.map(\.text) == ["Working · gh/issue #4"])
        #expect(sections[2].tasks.map(\.text) == ["#1 in queue", "#2 in queue"])
        #expect(sections[3].tasks.map(\.text) == ["Done"])
        #expect(Inbox.describe(project, summaries: summaries)["q2"]?.state == .pending)
    }

    @Test func aFailedTaskSaysWhy() {
        let failed = task("f", closed: true, failed: "worktree gone")
        #expect(Inbox.stateText(.failed, task: failed) == "Failed: worktree gone")
    }

    @Test func originNamesTheFirstEventsSource() {
        #expect(Inbox.taskOrigin(task("a", events: [event("e", source: "plugin:github")])) == "github")
        #expect(Inbox.taskOrigin(task("b", events: [event("e", source: "schedule")])) == "Scheduled")
        #expect(Inbox.taskOrigin(task("c", kind: "tidy")) == "Memory tidy-up")
        #expect(Inbox.taskOrigin(task("d")) == "Inbox")
    }
}

@Suite struct InboxFiledCardTests {
    private let tasks: [String: InboxTaskInfo] = [
        "t1": InboxTaskInfo(task: task("t1"), state: .pending, group: .pending, text: "#1 in queue"),
    ]

    /// A filed task's card shows it as it stands now and opens it.
    @Test func anAcceptedCallShowsTheTaskLive() {
        let cards = InboxFiledCard.of(
            cot([tool(args: #"{"title":"old"}"#, pinomad: .inboxSubmit(task: "t1", title: "Filed", merged: false))]),
            tasks: tasks)
        #expect(cards == [InboxFiledCard(id: "call-1", task: task("t1"), state: .pending,
                                          title: "Task t1", detail: "New task · #1 in queue")])
    }

    /// Web dureview: the model's arguments may be any JSON; a non-string
    /// title never reaches the card, which falls back to "Task".
    @Test func malformedArgumentsFallBackWithoutCrashing() {
        let cards = InboxFiledCard.of(cot([
            tool(state: .inputAvailable, args: #"{"title":{"nested":true},"mergeInto":3}"#, callId: "a"),
            tool(state: .inputAvailable, args: "not json", callId: "b"),
            tool(state: .inputAvailable, args: #"["title"]"#, callId: "c"),
            tool(state: .inputAvailable, args: #"{"title":"Fix login","mergeInto":"t9"}"#, callId: "d"),
            tool(state: .outputError, args: #"{"title":"Nope"}"#, callId: "e"),
            tool(callId: "f", name: "read"),
        ]), tasks: tasks)
        #expect(cards.map(\.title) == ["Task", "Task", "Task", "Fix login", "Nope"])
        #expect(cards.map(\.detail) == ["Filing…", "Filing…", "Filing…", "Filing…", "Not filed"])
        #expect(cards.allSatisfy { $0.task == nil })
    }

    /// Filed but no longer listed (removed meanwhile): the call's own words, not openable.
    @Test func aFiledTaskTheInboxDropped() {
        let cards = InboxFiledCard.of(
            cot([tool(pinomad: .inboxSubmit(task: "gone", title: "Merged", merged: true))]), tasks: tasks)
        #expect(cards.map(\.title) == ["Merged"])
        #expect(cards.map(\.detail) == ["Added to task"])
        #expect(cards[0].task == nil)
    }
}

@Suite struct InboxSourceFormTests {
    private let plugins = [
        PluginInfo(name: "panel", api: 1, sources: []),
        PluginInfo(name: "github", api: 1, sources: [
            PluginSourceInfo(name: "issues", description: "New issues", filter: "owner/repo", followedOnly: false),
            PluginSourceInfo(name: "comments", description: "PR comments", filter: nil, followedOnly: true),
        ]),
    ]

    @Test func startsOnTheFirstPluginWithSources() {
        let form = InboxSourceForm(zone: "UTC", plugins: plugins)
        #expect(form.plugin == "github")
        #expect(form.event == "issues")
    }

    @Test func aScheduleNeedsANameANoteATimeAndAZone() {
        var form = InboxSourceForm(zone: "Mars/Olympus", plugins: plugins)
        form.time = "9:00"
        let problems = form.problems
        #expect(problems.name != nil && problems.note != nil && problems.time != nil && problems.zone != nil)
        #expect(form.spec(plugins: plugins) == nil)
        form.name = " Deps "
        form.note = " Check deps "
        form.time = "08:30"
        form.zone = "Europe/Berlin"
        form.repeatKind = .weekly
        form.day = 3
        #expect(form.spec(plugins: plugins) == .schedule(
            schedule: .weekly(day: 3, time: "08:30", timeZone: "Europe/Berlin"), note: "Check deps"))
        #expect(form.effectiveTrusted)
    }

    @Test func cronTakesExactlyFiveFields() {
        var form = InboxSourceForm(zone: "UTC", plugins: [])
        form.name = "n"
        form.note = "x"
        form.repeatKind = .cron
        form.cron = "0 9 * *"
        #expect(form.problems.cron != nil)
        form.cron = " 0  9 * * 1-5 "
        #expect(form.spec(plugins: []) == .schedule(schedule: .cron(expression: "0 9 * * 1-5", timeZone: "UTC"), note: "x"))
    }

    @Test func nameLengthIsCapped() {
        var form = InboxSourceForm(zone: "UTC", plugins: [])
        form.kind = .webhook
        form.name = String(repeating: "a", count: InboxSourceForm.nameMax + 1)
        #expect(form.problems.name == "At most 120 characters")
        form.name = "Alerts"
        #expect(form.spec(plugins: []) == .webhook)
        #expect(!form.effectiveTrusted)
    }

    /// A source that takes no filter sends none, whatever was typed before switching.
    @Test func pluginSpecKeepsTheFilterOnlyWhereItMeansSomething() {
        var form = InboxSourceForm(zone: "UTC", plugins: plugins)
        form.kind = .plugin
        form.name = "Bugs"
        form.filter = " acme/web "
        #expect(form.spec(plugins: plugins) == .plugin(plugin: "github", source: "issues", filter: "acme/web"))
        form.event = "comments"
        #expect(form.spec(plugins: plugins) == .plugin(plugin: "github", source: "comments", filter: ""))
        form.pick(plugin: "panel", among: plugins)
        #expect(form.event == "")
        #expect(form.spec(plugins: plugins) == nil)
    }
}

@Suite struct InboxSourceFlipsTests {
    private func source(_ enabled: Bool) -> InboxSource {
        InboxSource(id: "s", name: "S", spec: .webhook, enabled: enabled, trusted: false, createdAt: 0, next: nil, problem: nil)
    }

    @Test func showsTheFlipWhileTheHostWorks() {
        var flips = InboxSourceFlips()
        flips.begin("s", from: true)
        #expect(flips.shown(source(true)) == (isOn: false, busy: true))
        flips.failed("s")
        #expect(flips.shown(source(true)) == (isOn: true, busy: false))
    }

    /// Web dureview: after a successful toggle the switch shows the
    /// snapshot, even when another device flipped it back before this
    /// device saw its own change land.
    @Test func afterTheAnswerTheNextSnapshotIsTheTruth() {
        var flips = InboxSourceFlips()
        flips.begin("s", from: true)
        flips.answered("s", at: 10)
        flips.catchUp([source(true)], version: 10)
        #expect(flips.shown(source(true)).isOn == false)
        flips.catchUp([source(true)], version: 11)
        #expect(flips.shown(source(true)) == (isOn: true, busy: false))
    }

    @Test func theSnapshotLeavingTheOldValueEndsTheFlip() {
        var flips = InboxSourceFlips()
        flips.begin("s", from: true)
        flips.catchUp([source(false)], version: 3)
        // Flipped back elsewhere before the answer: the snapshot shows it.
        #expect(flips.shown(source(true)) == (isOn: true, busy: false))
    }
}

@Suite struct LatestSheetTests {
    /// Web dureview: a reply for a closed sheet must not close (or fill) the
    /// one opened after it.
    @Test func aStaleReplyIsDropped() {
        var sheet = LatestSheet<String>()
        let first = sheet.present("add")
        sheet.dismiss()
        let second = sheet.present("add")
        let stale = sheet.complete(first, with: nil)
        #expect(!stale)
        #expect(sheet.value == "add")
        let current = sheet.complete(second, with: "secret")
        #expect(current)
        #expect(sheet.value == "secret")
        #expect(!sheet.isCurrent(second))
    }
}

@Suite struct InboxSmallTests {
    @Test func quietHoursAreHostMinutes() {
        #expect(QuietHoursText.clock(22 * 60) == "22:00")
        #expect(QuietHoursText.clock(7 * 60 + 5) == "07:05")
        #expect(QuietHoursText.minutes("07:05") == 425)
        #expect(QuietHoursText.minutes("24:00") == nil)
    }

    /// Web dureview: an intake send that resolves after the reader moved on
    /// leaves the stack alone.
    @Test func replacingTopOnlyWhileItIsStillShown() {
        #expect(Inbox.replacingTop(["home", "draft"], ifTop: "draft", with: "chat") == ["home", "chat"])
        #expect(Inbox.replacingTop(["home", "draft", "other"], ifTop: "draft", with: "chat") == nil)
        #expect(Inbox.replacingTop([String](), ifTop: "draft", with: "chat") == nil)
    }

    /// dureview: the intake opened from another device while a message was
    /// half typed — the text moves into that conversation's composer.
    @Test func unsentIntakeTextCarriesIntoTheConversationDraft() {
        #expect(Inbox.carryingDraft("Login loops", into: nil) == "Login loops")
        #expect(Inbox.carryingDraft("Login loops", into: "  ") == "Login loops")
        // Nothing typed: the conversation's own draft stays as it is.
        #expect(Inbox.carryingDraft(" \n", into: "Earlier note") == nil)
        #expect(Inbox.carryingDraft("", into: nil) == nil)
        // Both: neither is lost.
        #expect(Inbox.carryingDraft("Login loops", into: "Earlier note") == "Earlier note\n\nLogin loops")
    }
}

@Suite struct InboxTaskQuestionsTests {
    /// #846: every task's pending requests, in task order, each answered on
    /// its own task's conversation with the card's kind.
    @Test func listsEveryTasksQuestionsInTaskOrder() {
        let listed = inbox(intake: 9, tasks: [
            task("t1", conversation: 3, questions: [question("a"), question("b", kind: "pinomad.allow")]),
            task("t2", conversation: 4),
            task("t3", conversation: 5, questions: [question("c")]),
        ])
        let asking = Inbox.taskQuestions(listed)
        #expect(asking.map(\.id) == ["t1:a", "t1:b", "t3:c"])
        #expect(asking.map(\.conversationId) == [3, 3, 5])
        #expect(asking[1].question.kind == "pinomad.allow")
        #expect(asking[0].task.id == "t1")
    }

    /// A task the worker hasn't taken has no conversation to answer on.
    @Test func skipsTasksWithoutAConversation() {
        #expect(Inbox.taskQuestions(inbox(tasks: [task("t1", questions: [question("a")])])).isEmpty)
    }
}

@Suite struct InboxAnswerTargetTests {
    private let inboxes = [inbox(intake: 9, tasks: [task("open", conversation: 3), task("closed", conversation: 4, closed: true)])]

    @Test func aDisabledModeOpensTheTaskInsteadOfTheIntake() {
        #expect(Inbox.answerTarget(3, waiting: true, inboxes: inboxes, hostMinor: 41) == 3)
    }

    /// An open task's question is answered in its intake (#846).
    @Test func anOpenTasksQuestionOpensTheIntake() {
        #expect(Inbox.answerTarget(3, waiting: true, inboxes: inboxes, hostMinor: 41, modeEnabled: true) == 9)
    }

    /// The host publishes no questions for a closed task: its own conversation.
    @Test func aClosedTasksQuestionOpensTheTask() {
        #expect(Inbox.answerTarget(4, waiting: true, inboxes: inboxes, hostMinor: 41) == 4)
    }

    /// 5.38–5.40 hosts have intakes but publish no task questions there.
    @Test func anOlderHostsQuestionOpensTheTask() {
        #expect(Inbox.answerTarget(3, waiting: true, inboxes: inboxes, hostMinor: 40) == 3)
        #expect(Inbox.answerTarget(3, waiting: true, inboxes: inboxes, hostMinor: nil) == 3)
    }

    @Test func withoutAnIntakeTheTaskOpens() {
        let noIntake = [inbox(tasks: [task("open", conversation: 3)])]
        #expect(Inbox.answerTarget(3, waiting: true, inboxes: noIntake, hostMinor: 41) == 3)
    }

    @Test func otherNoticesAndOtherConversationsOpenThemselves() {
        #expect(Inbox.answerTarget(3, waiting: false, inboxes: inboxes, hostMinor: 41) == 3)
        #expect(Inbox.answerTarget(7, waiting: true, inboxes: inboxes, hostMinor: 41) == 7)
        #expect(Inbox.answerTarget(9, waiting: true, inboxes: inboxes, hostMinor: 41) == 9)
        #expect(Inbox.answerTarget(3, waiting: true, inboxes: nil, hostMinor: 41) == 3)
    }
}

@Suite struct InboxBaseBranchTests {
    /// Empty goes back to the repository's default branch.
    @Test func blankMeansTheRepositoryDefault() {
        #expect(Inbox.baseBranch(from: "  release/1.2 \n") == "release/1.2")
        #expect(Inbox.baseBranch(from: " \n ") == nil)
    }
}
