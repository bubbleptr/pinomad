// Markdown for chat text, themed to the HeroUI tokens — foreground/muted
// colors, monospace inline code and blocks (which scroll horizontally in the
// library's own renderer), no syntax highlighting. Links open with
// Linking.openURL (react-native-marked's default handler). useMarkdown is
// used rather than the <Markdown> component: that one renders its own
// hard-coded-background FlatList, which must not nest inside the transcript.
import { Platform, View } from "react-native";
import { useMarkdown, type MarkedStyles } from "react-native-marked";
import { useCSSVariable } from "uniwind";
import { useMemo } from "react";

/** Monospace family shared with other surfaces that print raw JSON/tool output. */
export const MONOSPACE = Platform.select({ ios: "Menlo", default: "monospace" });

export function MarkdownText({ value, muted = false }: { value: string; muted?: boolean }) {
  const [foreground, mutedColor, accent, surfaceTertiary] = useCSSVariable([
    "--foreground",
    "--muted",
    "--accent",
    "--surface-tertiary",
  ]) as Array<string | number | undefined>;

  const styles = useMemo<MarkedStyles>(() => {
    const textColor = muted ? mutedColor : foreground;
    return {
      text: { color: String(textColor), fontSize: 15, lineHeight: 21 },
      link: { color: String(accent) },
      codespan: { color: String(textColor), fontFamily: MONOSPACE, fontSize: 13, backgroundColor: String(surfaceTertiary) },
      code: {
        backgroundColor: String(surfaceTertiary),
        borderRadius: 8,
        padding: 10,
        marginVertical: 4,
      },
      codeText: { color: String(textColor), fontFamily: MONOSPACE, fontSize: 13 },
      blockquote: { borderLeftColor: String(mutedColor), borderLeftWidth: 2, paddingLeft: 10 },
      paragraph: { marginBottom: 4 },
      h1: { color: String(textColor), fontSize: 22, fontWeight: "700" },
      h2: { color: String(textColor), fontSize: 19, fontWeight: "700" },
      h3: { color: String(textColor), fontSize: 17, fontWeight: "600" },
      h4: { color: String(textColor), fontSize: 15, fontWeight: "600" },
      hr: { backgroundColor: String(mutedColor), marginVertical: 8 },
    };
  }, [foreground, mutedColor, accent, surfaceTertiary, muted]);

  const elements = useMarkdown(value, { styles, selectable: true });
  return <View>{elements}</View>;
}
