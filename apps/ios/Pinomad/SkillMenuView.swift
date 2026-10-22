import PinomadChat
import PinomadCore
import SwiftUI

/// The `$` skill menu above a composer: a headed Project / User list from
/// the scope's known skills, with name and description. Every row inserts
/// plain text `$name `; the host never parses a token. When the listing is
/// known but nothing matches, the card says so instead of silently closing.
struct SkillMenuView: View {
    let menu: SkillMenu
    let choose: (SkillEntry) -> Void

    @Environment(\.colorScheme) private var colorScheme

    private var rowCount: Int {
        menu.sections.reduce(0) { $0 + $1.skills.count + 1 }
    }

    var body: some View {
        Group {
            if rowCount > 6 {
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
            if menu.sections.isEmpty {
                Text("No matching skills")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
            } else {
                ForEach(menu.sections) { section in
                    Text(section.source == .project ? "Project" : "User")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 14)
                        .padding(.top, 6)
                        .padding(.bottom, 2)
                    ForEach(section.skills, id: \.name) { skill in
                        Button {
                            choose(skill)
                        } label: {
                            SkillMentionRow(skill: skill)
                        }
                        .buttonStyle(MentionRowStyle())
                    }
                }
            }
        }
    }
}

private struct SkillMentionRow: View {
    let skill: SkillEntry

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(.sparkles)
                .font(.system(size: 16))
                .foregroundStyle(.secondary)
                .frame(width: 22, height: 22)
            VStack(alignment: .leading, spacing: 1) {
                Text("$\(skill.name)")
                    .font(.subheadline.weight(.medium))
                    .lineLimit(1)
                if !skill.description.isEmpty {
                    Text(skill.description)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 7)
        .contentShape(.rect)
    }
}
