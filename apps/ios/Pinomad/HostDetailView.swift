import PinomadCore
import SwiftUI

/// One paired host's connection settings: the Auto / Direct only / Relay
/// only choice and, while it is the connected host, the coordinator's RTC
/// status. Reached from the ⓘ in Settings → Paired Hosts, connected or not.
struct HostDetailView: View {
    let model: AppModel
    let hostKey: String

    @Environment(\.dismiss) private var dismiss
    @State private var mode: HostConnectionMode = .auto
    @State private var forgetting = false

    private var host: HostRecord? { model.hostRecord(for: hostKey) }
    private var isCurrent: Bool { hostKey == model.currentHostKey }
    private var isLive: Bool { isCurrent && model.phase == .connected && model.connected }

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
                    TimelineView(.periodic(from: .now, by: 1)) { _ in
                        LabeledContent("Peer-to-peer", value: peerText)
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
                model.refreshLiveRtcStatus()
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
        isCurrent ? model.rtcStatus : nil
    }

    private var pathText: String {
        switch status?.path {
        case "p2p":
            if let kind = status?.selectedCandidateType, !kind.isEmpty {
                return "P2P (\(kind))"
            }
            return "P2P"
        case "relay": return "Relay"
        case "direct": return "Direct"
        default: return "Local"
        }
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
            if let failure = status?.lastFailure {
                return "Last failure: \(stageLabel(failure.stage)) — \(failure.reason)"
            }
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
        let elapsed = Date().timeIntervalSince(model.rtcStatusAt)
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
