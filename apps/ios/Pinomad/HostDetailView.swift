import PinomadCore
import SwiftUI

/// One paired host's connection settings: the Auto / Direct only / Relay
/// only choice and, while it is the connected host, the coordinator's RTC
/// status. Reached from the ⓘ in Settings → Hosts, connected or not.
struct HostDetailView: View {
    let model: AppModel
    let hostKey: String

    @Environment(\.dismiss) private var dismiss
    @State private var mode: HostConnectionMode = .auto
    @State private var forgetting = false
    /// The full addresses are hidden by default so a screenshot does not
    /// leak the network. The disclosure resets with the page.
    @State private var addressesExpanded = false

    private var host: HostRecord? { model.hostRecord(for: hostKey) }
    private var isCurrent: Bool { hostKey == model.currentHostKey }
    private var isLive: Bool { model.isConnected(hostKey) }

    var body: some View {
        List {
            Section {
                Picker("Mode", selection: $mode) {
                    ForEach(HostConnectionMode.allCases, id: \.self) { mode in
                        Text(mode.label).tag(mode)
                    }
                }
                .pickerStyle(.menu)
            } header: {
                Text("Connection")
            } footer: {
                Text(mode.footer)
            }

            if isLive {
                Section("Status") {
                    TimelineView(.periodic(from: .now, by: 1)) { _ in
                        LabeledContent("Path", value: pathText)
                    }
                    if let pair = status?.selectedPair {
                        DisclosureGroup("Addresses", isExpanded: $addressesExpanded) {
                            RtcAddressRow(label: "This device", end: pair.local)
                            RtcAddressRow(label: "Host", end: pair.remote)
                        }
                    }
                    TimelineView(.periodic(from: .now, by: 1)) { _ in
                        LabeledContent("Peer-to-peer", value: peerText)
                    }
                    if let failure = status?.lastFailure {
                        TimelineView(.periodic(from: .now, by: 1)) { _ in
                            RtcFailureRow(
                                failure: failure,
                                stage: stageLabel(failure.stage),
                                elapsedMs: statusElapsedMs)
                        }
                    }
                }
            }

            Section {
                Button("Forget This Host", role: .destructive) {
                    forgetting = true
                }
                .frame(maxWidth: .infinity, alignment: .center)
            }
        }
        .navigationTitle(host.map(label) ?? "Host")
        .task(id: isLive) {
            guard isLive else { return }
            while !Task.isCancelled {
                model.refreshLiveRtcStatus(for: hostKey)
                try? await Task.sleep(for: .seconds(1))
            }
        }
        .onAppear { mode = model.connectionMode(for: hostKey) }
        .onChange(of: mode) { _, next in
            // The coordinator's mode is fixed when the session is built, so
            // saving is the trigger; the model reconnects the live host.
            guard next != model.connectionMode(for: hostKey) else { return }
            model.setConnectionMode(next, for: hostKey)
        }
        .alert("Forget \(host.map(label) ?? "this host")?", isPresented: $forgetting) {
            Button("Cancel", role: .cancel) {}
            Button("Forget", role: .destructive) {
                model.forget(hostKey)
                dismiss()
            }
        } message: {
            Text("This device will need a new pairing link to reconnect to it.")
        }
    }

    private func label(_ host: HostRecord) -> String {
        model.hostLabels[host.hostKey] ?? host.name ?? hostOf(host.url)
    }

    private var status: RtcDiagnostics? {
        model.rtcStatus(for: hostKey)
    }

    /// The core's `agoMs` is frozen until a Clock event, so the failure row
    /// adds the local time since the status read — the same baseline the
    /// cooldown uses.
    private var statusElapsedMs: UInt64 {
        let elapsed = Date().timeIntervalSince(model.rtcStatusAt(for: hostKey))
        guard elapsed > 0 else { return 0 }
        return UInt64(elapsed * 1000)
    }

    private var pathText: String {
        RtcDiagnosticsText.pathLabel(
            path: status?.path ?? "loopback",
            remote: status?.selectedPair?.remote.scope,
            local: status?.selectedPair?.local.scope)
    }

    private var peerText: String {
        guard mode != .relayOnly else { return "Off · Relay only" }
        guard status?.available == true else {
            return status == nil ? "Preparing…" : "Not available on this host"
        }
        switch status?.phase {
        case "active":
            return "Active"
        case "cooldown":
            return "Cooling down · \(cooldownText)"
        case "signal", "ice", "noise", "warm", "scheduled":
            return "Preparing…"
        default:
            return "Preparing…"
        }
    }

    /// The core reports the cooldown at the last snapshot; subtract the time
    /// since that read so the page counts down without a core poll.
    private var cooldownText: String {
        let remaining = remainingCooldown
        guard remaining > 0 else { return "0s" }
        if remaining >= 60_000 {
            return "\(Int((Double(remaining) / 60_000).rounded(.up)))m"
        }
        return "\(Int((Double(remaining) / 1_000).rounded(.up)))s"
    }

    private var remainingCooldown: UInt64 {
        guard let status else { return 0 }
        let elapsed = Date().timeIntervalSince(model.rtcStatusAt(for: hostKey))
        let remaining = Double(status.cooldownRemainingMs) - max(0, elapsed) * 1000
        return remaining > 0 ? UInt64(remaining) : 0
    }

    private func stageLabel(_ stage: String) -> String {
        switch stage {
        case "signal": "Signal"
        case "ice": "ICE"
        case "noise": "Noise"
        case "warm": "Warm"
        case "commit": "Switch"
        case "liveness": "Liveness"
        default: stage.capitalized
        }
    }
}

/// One end of the selected pair. The disclosure's rows stay selectable so a
/// long press can copy the address, and monospaced digits keep the values
/// aligned while the page ticks.
private struct RtcAddressRow: View {
    let label: String
    let end: RtcCandidateEnd

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label)
            Text(RtcDiagnosticsText.candidateLabel(
                type: end.rtcType, address: end.address, scope: end.scope))
                .foregroundStyle(.secondary)
                .monospacedDigit()
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 2)
    }
}

/// The status card's failure line. Kept separate so the cooldown state can
/// show the last failure without replacing the Peer-to-peer value.
struct RtcFailureRow: View {
    let failure: RtcFailure
    let stage: String
    let elapsedMs: UInt64

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline) {
                Text("Last failure")
                Spacer(minLength: 12)
                Text(stage)
                    .foregroundStyle(.secondary)
            }
            Text(failure.reason)
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Text(metaText)
                .font(.caption2)
                .foregroundStyle(.tertiary)
                .monospacedDigit()
        }
        .padding(.vertical, 2)
    }

    private var metaText: String {
        RtcDiagnosticsText.failureMeta(
            agoMs: failure.agoMs,
            elapsedMs: elapsedMs,
            remote: failure.pair?.remote.scope,
            local: failure.pair?.local.scope)
    }
}

#Preview("RTC last failure") {
    List {
        RtcFailureRow(
            failure: RtcFailure(
                stage: "ice",
                reason: "ICE, DTLS, or the DataChannel did not open within 10s",
                agoMs: 12_000,
                pair: RtcSelectedPair(
                    local: RtcCandidateEnd(
                        rtcType: "host", address: "10.0.0.2:5000", scope: .lan),
                    remote: RtcCandidateEnd(
                        rtcType: "srflx", address: "100.64.1.2:6000", scope: .tailnet))
            ),
            stage: "ICE",
            elapsedMs: 0
        )
    }
}

#Preview("RTC addresses") {
    List {
        RtcAddressRow(
            label: "This device",
            end: RtcCandidateEnd(rtcType: "host", address: "10.0.0.2:5000", scope: .lan))
        RtcAddressRow(
            label: "Host",
            end: RtcCandidateEnd(rtcType: "srflx", address: "100.64.1.2:6000", scope: .tailnet))
    }
}
