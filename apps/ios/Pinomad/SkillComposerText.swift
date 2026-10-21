import PinomadChat
import SwiftUI
import UIKit

/// The composer's text field with `$name` mentions painted blue. SwiftUI's
/// TextField takes only plain text; its attributed TextEditor owns the rich
/// text and offers no in-place recolor, so painting through the binding can
/// reset the selection or an IME composition. A UIKit text view lets us
/// recolor the existing text storage while the draft stays a plain String.
/// The blue is the only mark: no chip, underline or background (issue
/// #143's visual decision).
struct SkillComposerText: View {
    @Binding var text: String
    @Binding var selection: NSRange
    @Binding var focused: Bool
    let placeholder: String
    let names: [String]?
    let enabled: Bool
    let minLines: Int
    let maxLines: Int

    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        // Read the environment so a text-size change re-runs the representable.
        let _ = dynamicTypeSize
        ZStack(alignment: .topLeading) {
            ComposerTextView(
                text: $text,
                selection: $selection,
                focused: $focused,
                placeholder: placeholder,
                names: names,
                enabled: enabled,
                minLines: minLines,
                maxLines: maxLines
            )
            if text.isEmpty {
                Text(placeholder)
                    .font(.body)
                    .foregroundStyle(.tertiary)
                    .allowsHitTesting(false)
            }
        }
    }
}

private struct ComposerTextView: UIViewRepresentable {
    @Binding var text: String
    @Binding var selection: NSRange
    @Binding var focused: Bool
    let placeholder: String
    let names: [String]?
    let enabled: Bool
    let minLines: Int
    let maxLines: Int

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeUIView(context: Context) -> ComposerUITextView {
        let view = ComposerUITextView()
        view.delegate = context.coordinator
        view.backgroundColor = .clear
        view.isScrollEnabled = false
        view.textContainerInset = .zero
        view.textContainer.lineFragmentPadding = 0
        view.contentInset = .zero
        view.contentInsetAdjustmentBehavior = .never
        view.scrollIndicatorInsets = .zero
        view.adjustsFontForContentSizeCategory = true
        view.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        view.setContentHuggingPriority(.defaultLow, for: .horizontal)
        view.accessibilityLabel = placeholder
        applyMetrics(to: view)
        // A restored draft has to be in the storage before ranges are
        // applied; otherwise the first paint points past an empty buffer.
        view.text = text
        view.selectedRange = clamped(selection, length: (text as NSString).length)
        context.coordinator.apply(to: view, text: text, names: names)
        return view
    }

    func updateUIView(_ view: ComposerUITextView, context: Context) {
        context.coordinator.parent = self
        applyMetrics(to: view)
        view.isEditable = enabled
        view.accessibilityLabel = placeholder

        let length = (text as NSString).length
        if view.text != text {
            view.text = text
            view.selectedRange = clamped(selection, length: length)
        } else if view.selectedRange != selection {
            view.selectedRange = clamped(selection, length: length)
        }

        context.coordinator.apply(to: view, text: text, names: names)
        view.updateScrolling()
        view.invalidateIntrinsicContentSize()

        if enabled {
            if focused, !view.isFirstResponder { view.becomeFirstResponder() }
            if !focused, view.isFirstResponder { view.resignFirstResponder() }
        } else if view.isFirstResponder {
            view.resignFirstResponder()
        }
    }

    func sizeThatFits(
        _ proposal: ProposedViewSize,
        uiView: ComposerUITextView,
        context: Context
    ) -> CGSize? {
        guard let width = proposal.width else { return nil }
        return CGSize(width: width, height: uiView.measuredHeight(forWidth: width))
    }

    private func applyMetrics(to view: ComposerUITextView) {
        let font = UIFont.preferredFont(forTextStyle: .body)
        view.font = font
        view.minVisibleHeight = ceil(font.lineHeight) * CGFloat(minLines)
        view.maxVisibleHeight = ceil(font.lineHeight) * CGFloat(maxLines)
    }

    private func clamped(_ range: NSRange, length: Int) -> NSRange {
        let location = min(max(range.location, 0), length)
        return NSRange(location: location, length: min(max(range.length, 0), length - location))
    }

    @MainActor
    final class Coordinator: NSObject, UITextViewDelegate {
        var parent: ComposerTextView
        private var appliedText: String?
        private var appliedNames: [String]?
        private var appliedPointSize: CGFloat?

        init(_ parent: ComposerTextView) {
            self.parent = parent
        }

        func textViewDidChange(_ textView: UITextView) {
            let text = textView.text ?? ""
            if parent.text != text { parent.text = text }
            if parent.selection != textView.selectedRange { parent.selection = textView.selectedRange }
            apply(to: textView, text: text, names: parent.names)
        }

        func textViewDidChangeSelection(_ textView: UITextView) {
            if parent.selection != textView.selectedRange {
                parent.selection = textView.selectedRange
            }
            textView.typingAttributes = baseAttributes
        }

        func textViewDidBeginEditing(_ textView: UITextView) {
            if !parent.focused { parent.focused = true }
        }

        func textViewDidEndEditing(_ textView: UITextView) {
            if parent.focused { parent.focused = false }
        }

        /// Recolor the existing storage, never the text itself — so the
        /// selection, undo stack and IME composition survive. While an IME
        /// has marked text, leave it alone; the next change applies it.
        func apply(to textView: UITextView, text: String, names: [String]?) {
            guard textView.markedTextRange == nil else { return }
            // UIKit can still hold the previous storage while SwiftUI is
            // applying a restored draft. Painting by the bound length would
            // throw, and caching a skipped paint would lose the color.
            guard textView.text == text else { return }
            let length = textView.textStorage.length
            guard length == (text as NSString).length else { return }
            let pointSize = UIFont.preferredFont(forTextStyle: .body).pointSize
            if appliedText == text, appliedNames == names, appliedPointSize == pointSize {
                return
            }

            let attributes = baseAttributes
            if length > 0 {
                textView.textStorage.beginEditing()
                textView.textStorage.setAttributes(
                    attributes, range: NSRange(location: 0, length: length))
                if let names, !names.isEmpty {
                    for range in SkillMentionHighlight.ranges(
                        in: text, names: names, limit: length) {
                        textView.textStorage.addAttribute(
                            .foregroundColor, value: UIColor.systemBlue, range: range)
                    }
                }
                textView.textStorage.endEditing()
            }
            textView.typingAttributes = attributes
            appliedText = text
            appliedNames = names
            appliedPointSize = pointSize
        }

        private var baseAttributes: [NSAttributedString.Key: Any] {
            [
                .font: UIFont.preferredFont(forTextStyle: .body),
                .foregroundColor: UIColor.label,
            ]
        }
    }
}

/// Grows with its text up to `maxVisibleHeight`, then scrolls. The height
/// comes from the same body font the placeholder and sent bubbles use, so
/// the composer keeps the old TextField's line rhythm.
private final class ComposerUITextView: UITextView {
    var minVisibleHeight: CGFloat = 22
    var maxVisibleHeight: CGFloat = 132

    private var lastWidth: CGFloat = 0

    override func layoutSubviews() {
        super.layoutSubviews()
        if bounds.width != lastWidth {
            lastWidth = bounds.width
            updateScrolling()
            invalidateIntrinsicContentSize()
        }
    }

    override var intrinsicContentSize: CGSize {
        CGSize(
            width: UIView.noIntrinsicMetric,
            height: measuredHeight(forWidth: bounds.width)
        )
    }

    func measuredHeight(forWidth width: CGFloat) -> CGFloat {
        let font = font ?? UIFont.preferredFont(forTextStyle: .body)
        let line = ceil(font.lineHeight)
        guard width > 0 else { return max(minVisibleHeight, line) }
        let text = text ?? ""
        let rect = (text as NSString).boundingRect(
            with: CGSize(width: width, height: .greatestFiniteMagnitude),
            options: [.usesLineFragmentOrigin, .usesFontLeading],
            attributes: [.font: font],
            context: nil
        )
        // boundingRect already counts the empty line after a trailing
        // newline (and reports one line for empty text), so adding more
        // would double-count it.
        let content = ceil(rect.height)
        return max(min(content, maxVisibleHeight), minVisibleHeight)
    }

    func updateScrolling() {
        let needsScroll = measuredHeight(forWidth: bounds.width) >= maxVisibleHeight - 0.5
        if isScrollEnabled != needsScroll { isScrollEnabled = needsScroll }
    }
}
