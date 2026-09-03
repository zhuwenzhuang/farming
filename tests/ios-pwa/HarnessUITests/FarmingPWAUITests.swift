import XCTest

final class FarmingPWAUITests: XCTestCase {
    private static var installedAppName = ""

    private var baseURL: URL {
        configuredURL("FarmingPWABaseURL")
    }

    private var appName: String {
        configuredString("FarmingPWAAppName")
    }

    private var terminalAgentName: String {
        configuredString("FarmingPWATerminalAgentName")
    }

    private var chatAgentName: String {
        configuredString("FarmingPWAChatAgentName")
    }

    override func setUpWithError() throws {
        continueAfterFailure = false
        try ensureInstalled()
    }

    func test01StandaloneComposerRestingGeometry() throws {
        let app = try launchStandalone()

        let navigation = app.buttons["Open navigation"].firstMatch
        let footer = app.otherElements["footer"].firstMatch
        let send = app.buttons["Send message"].firstMatch
        XCTAssertTrue(navigation.waitForExistence(timeout: 15), "The standalone top bar did not appear")
        XCTAssertTrue(footer.waitForExistence(timeout: 15), "The standalone Composer footer did not appear")
        XCTAssertTrue(send.waitForExistence(timeout: 15), "The standalone send control did not appear")
        let screen = app.windows.firstMatch.frame
        let footerFrame = footer.frame
        let bottomGap = screen.maxY - footerFrame.maxY

        attachScreenshot(named: "01-standalone-resting-composer")
        printEvidence(
            "resting-composer",
            [
                "screen": screen,
                "navigation": navigation.frame,
                "footer": footerFrame,
                "send": send.frame,
                "bottomGap": bottomGap,
                "navigationHittable": navigation.isHittable,
                "footerHittable": footer.isHittable,
            ]
        )

        XCTAssertEqual(app.state, .runningForeground, "The real standalone Web app must own the foreground")
        XCTAssertNotEqual(
            XCUIApplication(bundleIdentifier: "com.apple.mobilesafari").state,
            .runningForeground,
            "The acceptance path must not remain inside Mobile Safari"
        )
        XCTAssertTrue(footer.isHittable, "The resting Composer must remain interactive")
        XCTAssertTrue(navigation.isHittable, "The top bar must not be shifted out of the visible screen")
        XCTAssertTrue(send.isHittable, "The send control must remain interactive")
        XCTAssertGreaterThanOrEqual(
            send.frame.minY,
            footerFrame.minY,
            "The send control starts outside the Composer: send=\(send.frame), footer=\(footerFrame)"
        )
        XCTAssertLessThanOrEqual(
            send.frame.maxY,
            footerFrame.maxY,
            "The send control is clipped by the Composer bottom: send=\(send.frame), footer=\(footerFrame)"
        )
        XCTAssertLessThanOrEqual(
            bottomGap,
            64,
            "Standalone Composer leaves an abnormal \(format(bottomGap))pt blank region below it; screen=\(screen), footer=\(footerFrame)"
        )
    }

    func test02NewAgentDialogRespectsSafeViewport() throws {
        let app = try launchStandalone()
        dismissDialogIfPresent(in: app)

        let navigation = app.buttons["Open navigation"].firstMatch
        XCTAssertTrue(navigation.waitForExistence(timeout: 15), "The mobile navigation control did not appear")
        let safeContentTop = navigation.frame.minY
        navigation.tap()

        let newAgent = app.buttons["New Agent"].firstMatch
        XCTAssertTrue(newAgent.waitForExistence(timeout: 10), "The mobile New Agent control did not appear")
        XCTAssertTrue(newAgent.isHittable, "The mobile New Agent control must be tappable")
        newAgent.tap()

        let title = app.staticTexts["Start New Agent"].firstMatch
        let group = app.staticTexts["coding agents"].firstMatch
        let provider = app.buttons.matching(
            NSPredicate(format: "label CONTAINS[c] %@", "Codex CLI")
        ).firstMatch
        XCTAssertTrue(title.waitForExistence(timeout: 10), "The Start New Agent dialog did not appear")
        XCTAssertTrue(group.waitForExistence(timeout: 10), "The coding agents heading did not appear")
        XCTAssertTrue(provider.waitForExistence(timeout: 10), "The first coding Agent row did not appear")

        let screen = app.windows.firstMatch.frame
        attachScreenshot(named: "02-start-new-agent-safe-viewport")
        printEvidence(
            "new-agent-dialog",
            [
                "screen": screen,
                "safeContentTop": safeContentTop,
                "title": title.frame,
                "group": group.frame,
                "provider": provider.frame,
                "providerHittable": provider.isHittable,
            ]
        )

        for (name, element) in [("title", title), ("coding agents", group), ("first provider", provider)] {
            XCTAssertGreaterThanOrEqual(
                element.frame.minX,
                screen.minX,
                "\(name) is clipped by the left viewport edge: \(element.frame)"
            )
            XCTAssertLessThanOrEqual(
                element.frame.maxX,
                screen.maxX,
                "\(name) is clipped by the right viewport edge: \(element.frame)"
            )
        }
        XCTAssertGreaterThanOrEqual(
            title.frame.minY,
            safeContentTop,
            "Start New Agent is rendered inside the iOS status/Dynamic Island region: title=\(title.frame), safe content starts at \(format(safeContentTop))pt"
        )
        XCTAssertTrue(provider.isHittable, "The first coding Agent row must remain tappable")
    }

    func test03FocusedBusyQueuedControlsRemainHittable() throws {
        let app = try launchStandalone()
        dismissDialogIfPresent(in: app)
        try selectAgent(named: chatAgentName, in: app)

        let input = app.textViews.firstMatch
        XCTAssertTrue(input.waitForExistence(timeout: 20), "The structured Chat Composer did not appear")
        input.tap()
        input.typeText("hold for steer")

        let send = app.buttons["Send message"].firstMatch
        XCTAssertTrue(send.waitForExistence(timeout: 10), "The Send control did not appear")
        XCTAssertTrue(send.isHittable, "The first Prompt Send control must be tappable")
        send.tap()

        let waiting = app.staticTexts["Waiting for steering."].firstMatch
        XCTAssertTrue(waiting.waitForExistence(timeout: 15), "The fake Agent did not enter the deterministic busy state")

        input.tap()
        input.typeText("queued message remains actionable")
        let queueSend = app.buttons["Send message"].firstMatch
        XCTAssertTrue(queueSend.waitForExistence(timeout: 10), "The queued-message Send control did not appear")
        XCTAssertTrue(queueSend.isHittable, "The queued-message Send control must be tappable before submission")
        queueSend.tap()

        let queued = app.buttons["Steer"].firstMatch
        XCTAssertTrue(queued.waitForExistence(timeout: 10), "The deterministic queued-message row did not appear")

        let addContext = labeledElement("Add context", in: app)
        let model = labeledElement("Model and reasoning", in: app)
        let activeControl = app.buttons["Interrupt agent"].firstMatch
        for (name, element) in [
            ("Composer input", input),
            ("Add context", addContext),
            ("Model and reasoning", model),
            ("Interrupt agent", activeControl),
        ] {
            XCTAssertTrue(element.waitForExistence(timeout: 10), "\(name) did not exist in the focused queued state")
        }

        let keyboard = app.keyboards.firstMatch
        let assistant = app.otherElements.matching(
            NSPredicate(format: "identifier == %@", "SystemInputAssistantView")
        ).firstMatch
        let screen = app.windows.firstMatch.frame
        let inferredAssistant = inferredInputAssistantFrame(keyboard: keyboard, screen: screen)
        let obstruction = visibleObstructionFrame(
            keyboard: keyboard,
            assistant: assistant,
            inferredAssistant: inferredAssistant
        )

        attachScreenshot(named: "03-focused-busy-queued-controls")
        printEvidence(
            "focused-busy-queued",
            [
                "screen": screen,
                "input": input.frame,
                "queued": queued.frame,
                "addContext": addContext.frame,
                "model": model.frame,
                "activeControl": activeControl.frame,
                "keyboard": keyboard.exists ? keyboard.frame : "missing",
                "assistant": assistant.exists ? assistant.frame : inferredAssistant as Any,
                "obstruction": obstruction as Any,
                "addContextHittable": addContext.isHittable,
                "modelHittable": model.isHittable,
                "activeControlHittable": activeControl.isHittable,
            ]
        )

        XCTAssertNotNil(obstruction, "The iOS software keyboard or input assistant must be visible for this scenario")
        for (name, element) in [
            ("Add context", addContext),
            ("Model and reasoning", model),
            ("Interrupt agent", activeControl),
        ] {
            XCTAssertTrue(element.isHittable, "\(name) is covered or otherwise not tappable; frame=\(element.frame)")
            XCTAssertGreaterThanOrEqual(element.frame.minX, screen.minX, "\(name) is clipped on the left")
            XCTAssertLessThanOrEqual(element.frame.maxX, screen.maxX, "\(name) is clipped on the right")
            if let obstruction {
                XCTAssertLessThanOrEqual(
                    element.frame.maxY,
                    obstruction.minY + 1,
                    "\(name) is covered by the iOS keyboard/input assistant: control=\(element.frame), obstruction=\(obstruction)"
                )
            }
        }
    }

    func test04SafariTabKeepsFocusedComposerAboveInputUI() throws {
        let safari = XCUIApplication(bundleIdentifier: "com.apple.mobilesafari")
        safari.terminate()
        safari.launch()
        safari.open(baseURL)
        XCTAssertTrue(safari.webViews.firstMatch.waitForExistence(timeout: 20), "Farming did not load in Mobile Safari")
        try selectAgent(named: chatAgentName, in: safari)

        let navigation = safari.buttons["Open navigation"].firstMatch
        let input = safari.textViews.firstMatch
        XCTAssertTrue(navigation.waitForExistence(timeout: 15), "The Safari tab top bar did not appear")
        XCTAssertTrue(input.waitForExistence(timeout: 20), "The Safari tab Composer did not appear")
        input.tap()
        input.typeText("browser viewport remains visible")

        let keyboard = safari.keyboards.firstMatch
        XCTAssertTrue(keyboard.waitForExistence(timeout: 10), "The Safari software keyboard did not appear")
        let assistant = safari.otherElements.matching(
            NSPredicate(format: "identifier == %@", "SystemInputAssistantView")
        ).firstMatch
        let screen = safari.windows.firstMatch.frame
        let obstruction = visibleObstructionFrame(
            keyboard: keyboard,
            assistant: assistant,
            inferredAssistant: inferredInputAssistantFrame(keyboard: keyboard, screen: screen)
        )

        attachScreenshot(named: "04-safari-tab-focused-composer")
        printEvidence(
            "safari-tab-focused-composer",
            [
                "screen": screen,
                "navigation": navigation.frame,
                "input": input.frame,
                "keyboard": keyboard.frame,
                "obstruction": obstruction as Any,
                "navigationHittable": navigation.isHittable,
                "inputHittable": input.isHittable,
            ]
        )

        XCTAssertTrue(navigation.isHittable, "The Safari tab top bar is shifted out of view")
        XCTAssertTrue(input.isHittable, "The Safari tab Composer input is covered")
        XCTAssertNotNil(obstruction, "The Safari keyboard or input assistant must be visible")
        if let obstruction {
            XCTAssertLessThanOrEqual(
                input.frame.maxY,
                obstruction.minY + 1,
                "The Safari tab Composer is covered by the keyboard/input assistant: input=\(input.frame), obstruction=\(obstruction)"
            )
        }
    }

    private func ensureInstalled() throws {
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        springboard.activate()
        XCTAssertTrue(
            springboard.wait(for: .runningForeground, timeout: 10),
            "SpringBoard was not available while checking the installed Web app"
        )
        if findSpringBoardIcon(in: springboard).exists {
            Self.installedAppName = appName
            return
        }

        let safari = XCUIApplication(bundleIdentifier: "com.apple.mobilesafari")
        safari.terminate()
        safari.launch()
        safari.open(baseURL)
        XCTAssertTrue(safari.webViews.firstMatch.waitForExistence(timeout: 20), "Farming did not load in Mobile Safari")

        let share = safari.buttons["Share"].firstMatch
        XCTAssertTrue(share.waitForExistence(timeout: 10), "Safari Share was not available")
        XCTAssertTrue(share.isHittable, "Safari Share was not tappable")
        share.tap()

        let addToHome = safari.cells["Add to Home Screen"].firstMatch
        XCTAssertTrue(addToHome.waitForExistence(timeout: 10), "Safari did not expose Add to Home Screen")
        for _ in 0..<8 where !addToHome.isHittable {
            safari.swipeUp()
        }
        XCTAssertTrue(addToHome.isHittable, "Add to Home Screen could not be scrolled into view")
        addToHome.tap()

        let name = safari.textFields.matching(
            NSPredicate(format: "value == %@", "Farming 2")
        ).firstMatch
        XCTAssertTrue(name.waitForExistence(timeout: 10), "The Add to Home Screen name field did not appear")
        let suffix = String(appName.dropFirst("Farming 2".count))
        XCTAssertFalse(suffix.isEmpty, "The harness app name must be unique")
        name.tap()
        name.typeText(suffix)

        let add = safari.buttons["Add"].firstMatch
        XCTAssertTrue(add.waitForExistence(timeout: 5), "The Add confirmation did not appear")
        XCTAssertTrue(add.isHittable, "The Add confirmation was not tappable")
        add.tap()

        XCTAssertTrue(springboard.wait(for: .runningForeground, timeout: 15), "SpringBoard did not receive the installed Web app")
        let icon = findSpringBoardIcon(in: springboard)
        XCTAssertTrue(icon.waitForExistence(timeout: 15), "SpringBoard did not show the \(appName) Web app icon")
        Self.installedAppName = appName
    }

    private func launchStandalone() throws -> XCUIApplication {
        let app = XCUIApplication(bundleIdentifier: "com.apple.webapp")
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        var failures: [String] = []
        for attempt in 1...3 {
            springboard.activate()
            guard springboard.wait(for: .runningForeground, timeout: 10) else {
                failures.append("attempt \(attempt): SpringBoard did not reach the foreground")
                continue
            }
            let icon = findSpringBoardIcon(in: springboard)
            guard icon.waitForExistence(timeout: 10) else {
                failures.append("attempt \(attempt): installed icon was not present after SpringBoard activation")
                continue
            }
            let iconHittable = XCTNSPredicateExpectation(
                predicate: NSPredicate(format: "exists == true AND hittable == true"),
                object: icon
            )
            guard XCTWaiter.wait(for: [iconHittable], timeout: 10) == .completed else {
                failures.append("attempt \(attempt): installed icon was not tappable")
                continue
            }
            icon.tap()
            guard app.wait(for: .runningForeground, timeout: 15) else {
                failures.append(
                    "attempt \(attempt): com.apple.webapp did not reach the foreground (state \(app.state.rawValue))"
                )
                continue
            }
            guard app.webViews.firstMatch.waitForExistence(timeout: 20) else {
                failures.append("attempt \(attempt): standalone WebView did not appear")
                continue
            }
            return app
        }
        throw NSError(
            domain: "FarmingPWAHarness",
            code: 1,
            userInfo: [
                NSLocalizedDescriptionKey:
                    "Harness launch failed before product evidence after three fresh SpringBoard attempts: \(failures.joined(separator: "; "))"
            ]
        )
    }

    private func findSpringBoardIcon(in springboard: XCUIApplication) -> XCUIElement {
        return springboard.descendants(matching: .any).matching(
            NSPredicate(format: "label == %@", appName)
        ).firstMatch
    }

    private func dismissDialogIfPresent(in app: XCUIApplication) {
        let close = app.buttons["Close"].firstMatch
        if close.exists && close.isHittable {
            close.tap()
            _ = close.waitForNonExistence(timeout: 5)
        }
    }

    private func selectAgent(named name: String, in app: XCUIApplication) throws {
        dismissDialogIfPresent(in: app)
        let navigation = app.buttons["Open navigation"].firstMatch
        XCTAssertTrue(navigation.waitForExistence(timeout: 15), "The mobile navigation control did not appear")
        if navigation.isHittable {
            navigation.tap()
        }

        let predicate = NSPredicate(format: "label CONTAINS[c] %@", name)
        let row = app.otherElements.matching(predicate).firstMatch
        let agent = row.waitForExistence(timeout: 10)
            ? row
            : app.descendants(matching: .any).matching(predicate).firstMatch
        XCTAssertTrue(agent.waitForExistence(timeout: 15), "The \(name) fixture Agent was not listed")
        XCTAssertTrue(agent.isHittable, "The \(name) fixture Agent row was not tappable")
        agent.tap()
    }

    private func labeledElement(_ label: String, in app: XCUIApplication) -> XCUIElement {
        app.descendants(matching: .any).matching(
            NSPredicate(format: "label == %@", label)
        ).firstMatch
    }

    private func visibleObstructionFrame(
        keyboard: XCUIElement,
        assistant: XCUIElement,
        inferredAssistant: CGRect?
    ) -> CGRect? {
        let frames = [keyboard, assistant]
            .filter { $0.exists }
            .map(\.frame)
            .filter { !$0.isEmpty && $0.minY >= 0 } + [inferredAssistant].compactMap { $0 }
        return frames.min(by: { $0.minY < $1.minY })
    }

    private func inferredInputAssistantFrame(
        keyboard: XCUIElement,
        screen: CGRect
    ) -> CGRect? {
        guard keyboard.exists else { return nil }
        let keyboardFrame = keyboard.frame
        guard !keyboardFrame.isEmpty, keyboardFrame.minY > screen.midY else { return nil }
        let assistantHeight: CGFloat = 44
        return CGRect(
            x: screen.minX,
            y: keyboardFrame.minY - assistantHeight,
            width: screen.width,
            height: assistantHeight
        )
    }

    private func attachScreenshot(named name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private func printEvidence(_ scenario: String, _ values: [String: Any]) {
        let rendered = values.keys.sorted().map { key in
            "\(key)=\(values[key]!)"
        }.joined(separator: " ")
        print("IOS_PWA_EVIDENCE scenario=\(scenario) \(rendered)")
    }

    private func configuredString(_ key: String) -> String {
        let environmentKeys = [
            "FarmingPWAAppName": "FARMING_PWA_APP_NAME",
            "FarmingPWABaseURL": "FARMING_PWA_BASE_URL",
            "FarmingPWAChatAgentName": "FARMING_PWA_CHAT_AGENT_NAME",
            "FarmingPWATerminalAgentName": "FARMING_PWA_TERMINAL_AGENT_NAME",
        ]
        let value = (Bundle(for: Self.self).object(forInfoDictionaryKey: key) as? String)
            ?? environmentKeys[key].flatMap { ProcessInfo.processInfo.environment[$0] }
        guard let value,
              !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        else {
            XCTFail("Missing XCUITest configuration key \(key)")
            return ""
        }
        return value
    }

    private func configuredURL(_ key: String) -> URL {
        let value = configuredString(key)
        guard let url = URL(string: value) else {
            XCTFail("Invalid XCUITest URL in \(key): \(value)")
            return URL(string: "about:blank")!
        }
        return url
    }

    private func format(_ value: CGFloat) -> String {
        String(format: "%.1f", Double(value))
    }
}
