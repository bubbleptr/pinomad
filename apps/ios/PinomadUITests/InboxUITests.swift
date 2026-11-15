import CryptoKit
import XCTest

// The Inbox's write paths, driven through the app against a live faux host
// (ADR-0051). Not part of CI: they need a host this simulator has already
// paired with, holding two registered projects — one with an intake, one
// without — and a faux model scripted to file tasks from the intake and to
// ask a question when an event mentions "Disk 3". Run with:
//
//   TEST_RUNNER_PINOMAD_UI_HOST=1 \
//   TEST_RUNNER_PINOMAD_UI_PROJECT=<project path with an Inbox> \
//   TEST_RUNNER_PINOMAD_UI_FRESH_PROJECT=<project path without an intake> \
//   xcodebuild -project apps/ios/Pinomad.xcodeproj -scheme PinomadUITests \
//     -destination 'id=<your own simulator>' test
@MainActor
final class InboxUITests: XCTestCase {
    private var app: XCUIApplication!
    private var project = ""

    override func setUp() async throws {
        continueAfterFailure = false
        let env = ProcessInfo.processInfo.environment
        guard env["PINOMAD_UI_HOST"] != nil, let project = env["PINOMAD_UI_PROJECT"] else {
            throw XCTSkip("Needs a paired faux host: set PINOMAD_UI_HOST and PINOMAD_UI_PROJECT")
        }
        self.project = project
        app = XCUIApplication()
        app.launchArguments = ["-homeMode", "inbox"]
    }

    private func openSettings() {
        app.launchEnvironment["PINOMAD_OPEN_INBOX"] = "settings:\(project)"
        app.launch()
        XCTAssertTrue(app.buttons["Edit Rules"].waitForExistence(timeout: 20))
    }

    /// Lists are lazy: a row below the fold has no element until it scrolls in.
    @discardableResult
    private func scrolledTo(_ element: XCUIElement) -> XCUIElement {
        for _ in 0..<15 where !(element.exists && element.isHittable) {
            app.swipeUp()
        }
        return element
    }

    private func unique(_ prefix: String) -> String {
        "\(prefix) \(Int(Date.now.timeIntervalSince1970) % 100_000)"
    }

    /// The first message to a project's intake opens it, and its filed
    /// tasks come back as cards under the reply.
    func testIntakeFirstSendOpensTheIntakeWithItsFiledTasks() throws {
        guard let fresh = ProcessInfo.processInfo.environment["PINOMAD_UI_FRESH_PROJECT"] else {
            throw XCTSkip("Needs PINOMAD_UI_FRESH_PROJECT, a project without an intake")
        }
        app.launch()
        let row = app.buttons[(fresh as NSString).lastPathComponent]
        XCTAssertTrue(app.buttons["Inbox"].waitForExistence(timeout: 20))
        XCTAssertTrue(scrolledTo(row).waitForExistence(timeout: 5))
        row.tap()
        let field = app.textViews.firstMatch.exists ? app.textViews.firstMatch : app.textFields.firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        field.tap()
        field.typeText("Safari login loops after the redirect, and settings is slow.")
        app.buttons["Send"].tap()
        // The draft page became the intake conversation.
        XCTAssertTrue(app.navigationBars["Intake"].waitForExistence(timeout: 30))
        XCTAssertTrue(app.staticTexts["Login fails on Safari after the redirect"].waitForExistence(timeout: 60))
        XCTAssertTrue(app.staticTexts["Settings page loads slowly"].waitForExistence(timeout: 30))
    }

    func testAddAScheduleSource() {
        openSettings()
        let source = unique("Weekly audit")
        scrolledTo(app.buttons["Add Source"]).tap()
        let nameField = app.textFields["Dependency check"]
        XCTAssertTrue(nameField.waitForExistence(timeout: 5))
        nameField.tap()
        nameField.typeText(source)
        let note = app.textViews.firstMatch.exists ? app.textViews.firstMatch
            : app.textFields["Look for outdated dependencies and open a task for each one worth upgrading."]
        note.tap()
        note.typeText("Audit the dependencies.")
        app.buttons["Add"].tap()
        XCTAssertTrue(app.staticTexts[source].waitForExistence(timeout: 15) || scrolledTo(app.staticTexts[source]).exists)
    }

    /// A new webhook shows its URL, source id and secret once; the secret
    /// signs real events, which open tasks the app then handles: a queued
    /// one skipped, and one whose question is answered.
    func testWebhookSecretSignsEventsThenSkipAndAnswer() async throws {
        openSettings()
        let source = unique("Hook")
        scrolledTo(app.buttons["Add Source"]).tap()
        app.buttons["Webhook"].tap()
        let nameField = app.textFields["NAS backups"]
        XCTAssertTrue(nameField.waitForExistence(timeout: 5))
        nameField.tap()
        nameField.typeText(source)
        app.buttons["Add"].tap()
        XCTAssertTrue(app.navigationBars["Webhook added"].waitForExistence(timeout: 15))
        let url = app.staticTexts["webhook-url"].label
        let sourceId = app.staticTexts["webhook-source"].label
        let secret = app.staticTexts["webhook-secret"].label
        XCTAssertFalse(secret.isEmpty)
        app.buttons["Done"].tap()
        XCTAssertFalse(app.staticTexts["webhook-secret"].exists)

        let tag = unique("run")
        // The question first: the worker moves on while it waits; then a
        // slow one runs while the last two queue.
        let asked = try await Self.post(url: url, source: sourceId, secret: secret, title: "Disk 3 \(tag)",
                                        summary: "Disk 3 reports reallocated sectors (\(tag))")
        XCTAssertEqual(asked, 200)
        for index in 1...3 {
            let status = try await Self.post(url: url, source: sourceId, secret: secret, title: "Chore \(index) \(tag)",
                                             summary: "Routine chore \(index) (\(tag))")
            XCTAssertEqual(status, 200)
        }

        app.terminate()
        app.launchEnvironment["PINOMAD_OPEN_INBOX"] = nil
        app.launch()
        let queued = app.buttons.containing(NSPredicate(format: "label CONTAINS %@", "Chore 3 \(tag)")).firstMatch
        XCTAssertTrue(queued.waitForExistence(timeout: 30))
        queued.tap()
        let skip = app.buttons["Skip"]
        XCTAssertTrue(skip.waitForExistence(timeout: 10))
        skip.tap()
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "Skipped"))
            .firstMatch.waitForExistence(timeout: 15))
        app.navigationBars.buttons.firstMatch.tap()

        let asking = app.buttons.containing(NSPredicate(format: "label CONTAINS %@", "Disk 3 \(tag)")).firstMatch
        XCTAssertTrue(asking.waitForExistence(timeout: 30))
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "Needs your answer"))
            .firstMatch.waitForExistence(timeout: 60))
        asking.tap()
        let option = app.buttons["Order a replacement"].exists ? app.buttons["Order a replacement"]
            : app.staticTexts["Order a replacement"]
        XCTAssertTrue(option.waitForExistence(timeout: 20))
        option.tap()
        app.buttons["Submit"].tap()
        XCTAssertTrue(app.buttons["Submit"].waitForNonExistence(timeout: 20))
    }

    func testToggleRemoveAndResetASource() {
        openSettings()
        // A webhook of its own, so the shared ones stay as they are.
        let source = unique("Throwaway")
        scrolledTo(app.buttons["Add Source"]).tap()
        app.buttons["Webhook"].tap()
        let nameField = app.textFields["NAS backups"]
        XCTAssertTrue(nameField.waitForExistence(timeout: 5))
        nameField.tap()
        nameField.typeText(source)
        app.buttons["Add"].tap()
        XCTAssertTrue(app.buttons["Done"].waitForExistence(timeout: 15))
        app.buttons["Done"].tap()

        let toggle = app.switches[source]
        _ = toggle.waitForExistence(timeout: 10)
        XCTAssertTrue(scrolledTo(toggle).exists)
        XCTAssertEqual(toggle.value as? String, "1")
        toggle.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.5)).tap()
        // Off once the host has it, then held there by the next snapshot.
        XCTAssertTrue(waitForValue(toggle, "0"))

        app.buttons["More for \(source)"].tap()
        app.buttons["Reset Secret"].tap()
        app.alerts.buttons["Reset Secret"].tap()
        XCTAssertTrue(app.navigationBars["New secret for \(source)"].waitForExistence(timeout: 15))
        app.buttons["Done"].tap()

        app.buttons["More for \(source)"].tap()
        app.buttons["Remove"].tap()
        app.alerts.buttons["Remove"].tap()
        XCTAssertTrue(app.switches[source].waitForNonExistence(timeout: 15))
    }

    func testSaveRules() {
        openSettings()
        let rules = unique("Run the tests before pushing.")
        app.buttons["Edit Rules"].tap()
        let field = app.textViews.firstMatch.exists ? app.textViews.firstMatch : app.textFields.firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        field.tap()
        field.press(forDuration: 1.2)
        if app.menuItems["Select All"].waitForExistence(timeout: 2) {
            app.menuItems["Select All"].tap()
            field.typeText(XCUIKeyboardKey.delete.rawValue)
        }
        field.typeText(rules)
        app.buttons["Save"].tap()
        XCTAssertTrue(app.staticTexts[rules].waitForExistence(timeout: 15))
    }

    private func waitForValue(_ element: XCUIElement, _ value: String) -> Bool {
        let expectation = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == %@", value), object: element)
        return XCTWaiter.wait(for: [expectation], timeout: 10) == .completed
    }

    /// One signed webhook event, as a sender on the LAN would post it.
    private nonisolated static func post(url: String, source: String, secret: String, title: String, summary: String) async throws -> Int? {
        let body = try JSONSerialization.data(withJSONObject: [
            "id": UUID().uuidString, "title": title, "summary": summary, "thread": "ui:\(UUID().uuidString)",
        ])
        let timestamp = String(Int(Date.now.timeIntervalSince1970))
        var signed = Data("\(timestamp).".utf8)
        signed.append(body)
        let mac = HMAC<SHA256>.authenticationCode(for: signed, using: SymmetricKey(data: Data(secret.utf8)))
        var request = URLRequest(url: URL(string: url)!)
        request.httpMethod = "POST"
        request.httpBody = body
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(source, forHTTPHeaderField: "X-Pinomad-Source")
        request.setValue(timestamp, forHTTPHeaderField: "X-Pinomad-Timestamp")
        request.setValue("sha256=" + mac.map { String(format: "%02x", $0) }.joined(), forHTTPHeaderField: "X-Pinomad-Signature")
        let (_, response) = try await URLSession.shared.data(for: request)
        return (response as? HTTPURLResponse)?.statusCode
    }
}
