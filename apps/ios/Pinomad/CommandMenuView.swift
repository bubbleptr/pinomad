import PinomadChat
import PinomadCore
import SwiftUI

/// The `/` command menu above the conversation composer (issue #254): the
/// host's commands matching the typed prefix, with the argument hint and
/// description. A disabled command stays listed, greyed, with the host's
/// reason in place of its description. With no match the card says the
/// text goes out as a message — the recognition rule never guesses.
struct CommandMenuView: View {
    let menu: SlashCommandMenu
    let choose: (CommandEntry) -> Void

    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        Group {
            if menu.commands.count > 6 {
                ScrollView {
                    rows
                }
                .scrollBounceBehavior(.basedOnSize)
                .scrollIndicators(.hidden)
                .frame(height: 292)
            } else {
                rows
            }
        }
        .padding(.vertical, 4)
        .clipShape(.rect(cornerRadius: 22))
        .glassEffect(.regular, in: .rect(cornerRadius: 22))
        // A short menu already on screen does not re-resolve the material
        // on an appearance switch without a new identity.
        .id(colorScheme)
        .transition(.opacity.combined(with: .move(edge: .bottom)))
    }

    private var rows: some View {
        LazyVStack(alignment: .leading, spacing: 0) {
            if menu.commands.isEmpty {
                Text("No matching command. This will be sent as a message.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
            } else {
                ForEach(menu.commands, id: \.name) { command in
                    Button {
                        choose(command)
                    } label: {
                        CommandRow(command: command)
                    }
                    .buttonStyle(MentionRowStyle())
                    .disabled(command.disabled != nil)
                }
            }
        }
    }
}

private struct CommandRow: View {
    let command: CommandEntry

    @Environment(\.isEnabled) private var isEnabled

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(.squareSlash)
                .font(.system(size: 16))
                .foregroundStyle(.secondary)
                .frame(width: 22, height: 22)
            VStack(alignment: .leading, spacing: 1) {
                HStack(spacing: 6) {
                    Text("/\(command.name)")
                        .font(.subheadline.weight(.medium))
                    if let hint = command.argumentHint, !hint.isEmpty {
                        Text(hint)
                            .font(.caption.monospaced())
                            .foregroundStyle(.secondary)
                    }
                }
                .lineLimit(1)
                if let reason = command.disabled {
                    Text(reason)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                } else if !command.description.isEmpty {
                    Text(command.description)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
            Spacer(minLength: 0)
        }
        .opacity(isEnabled ? 1 : 0.45)
        .padding(.horizontal, 12)
        .padding(.vertical, 7)
        .contentShape(.rect)
    }
}
