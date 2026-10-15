// Message images as thumbnails; a tap opens the full-screen viewer, which a
// tap or a downward pull dismisses. The composer's staged attachments reuse
// the same data-URI form. Web parity: entities/image/message-images.tsx.
import { useEffect, useState } from "react";
import { Image, Modal, Pressable, StyleSheet, View } from "react-native";
import { Spinner } from "heroui-native";
import { Gesture, GestureDetector, GestureHandlerRootView } from "react-native-gesture-handler";
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { useCSSVariable } from "uniwind";
import type { MessageImage } from "@pinomad/protocol/images.ts";
import { Cancel } from "../../shared/ui/icons.tsx";

export const imageUri = (image: { data: string; mimeType: string }): string =>
  `data:${image.mimeType};base64,${image.data}`;

const THUMB = 72;

/** Full-screen single image; tap or swipe down to dismiss. */
export function ImageViewer({ image, onClose }: { image: { data: string; mimeType: string } | undefined; onClose(): void }) {
  const translateY = useSharedValue(0);
  // The next open starts centered, not where the last dismiss left off.
  useEffect(() => {
    if (image !== undefined) translateY.value = 0;
  }, [image, translateY]);
  const pan = Gesture.Pan()
    .activeOffsetY(10)
    .onUpdate((e) => {
      "worklet";
      translateY.value = e.translationY;
    })
    .onEnd((e) => {
      "worklet";
      if (Math.abs(e.translationY) > 80 || Math.abs(e.velocityY) > 800) scheduleOnRN(onClose);
      else translateY.value = withTiming(0, { duration: 150 });
    });
  const tap = Gesture.Tap().onEnd(() => {
    "worklet";
    scheduleOnRN(onClose);
  });
  const style = useAnimatedStyle(() => ({
    transform: [{ translateY: translateY.value }],
    // The backdrop dims as the image travels, like the sheet gestures do.
    opacity: 1 - Math.min(0.4, Math.abs(translateY.value) / 600),
  }));
  return (
    <Modal visible={image !== undefined} transparent animationType="fade" statusBarTranslucent onRequestClose={onClose}>
      {/* Modals open a new window; Android needs a gesture root inside it. */}
      <GestureHandlerRootView style={{ flex: 1 }}>
        <GestureDetector gesture={Gesture.Exclusive(pan, tap)}>
          <Animated.View style={[styles.viewer, style]}>
            {image === undefined ? null : (
              <Image source={{ uri: imageUri(image) }} style={styles.full} resizeMode="contain" />
            )}
          </Animated.View>
        </GestureDetector>
      </GestureHandlerRootView>
    </Modal>
  );
}

/** A message's images as thumbnails; a tap opens the viewer at that image. */
export function MessageImages({
  images,
  align = "end",
}: {
  images: readonly { data: string; mimeType: string }[];
  /** User bubbles align right; tool cards align left. */
  align?: "start" | "end";
}) {
  const [open, setOpen] = useState<number | undefined>(undefined);
  if (images.length === 0) return null;
  return (
    <>
      <View style={[styles.thumbs, align === "end" ? styles.thumbsEnd : null]} testID="message-images">
        {images.map((image, index) => (
          <Pressable key={index} onPress={() => setOpen(index)} accessibilityRole="imagebutton" accessibilityLabel={`Image ${index + 1}`}>
            <Image source={{ uri: imageUri(image) }} style={styles.thumb} />
          </Pressable>
        ))}
      </View>
      <ImageViewer image={open === undefined ? undefined : images[open]} onClose={() => setOpen(undefined)} />
    </>
  );
}

/** Staged attachments above the input: thumbnails with remove badges, a spinner slot while preparing. */
export function AttachmentStrip({
  images,
  pending,
  onRemove,
}: {
  images: readonly MessageImage[];
  pending: boolean;
  onRemove(index: number): void;
}) {
  const [surfaceTertiary, foreground] = useCSSVariable(["--surface-tertiary", "--foreground"]) as Array<
    string | undefined
  >;
  if (images.length === 0 && !pending) return null;
  return (
    <View style={styles.thumbs} testID="composer-attachments">
      {images.map((image, index) => (
        <View key={index}>
          <Image source={{ uri: imageUri(image) }} style={styles.staged} />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Remove image ${index + 1}`}
            hitSlop={6}
            onPress={() => onRemove(index)}
            style={[styles.removeBadge, { backgroundColor: surfaceTertiary }]}
          >
            <Cancel size={10} color={foreground} />
          </Pressable>
        </View>
      ))}
      {pending ? (
        <View style={[styles.staged, styles.pending, { backgroundColor: surfaceTertiary }]}>
          <Spinner size="sm" />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  thumbs: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  thumbsEnd: {
    justifyContent: "flex-end",
  },
  thumb: {
    width: THUMB,
    height: THUMB,
    borderRadius: 10,
  },
  staged: {
    width: 56,
    height: 56,
    borderRadius: 10,
  },
  pending: {
    alignItems: "center",
    justifyContent: "center",
  },
  removeBadge: {
    position: "absolute",
    top: -5,
    right: -5,
    width: 18,
    height: 18,
    borderRadius: 9,
    alignItems: "center",
    justifyContent: "center",
  },
  viewer: {
    flex: 1,
    backgroundColor: "black",
    alignItems: "center",
    justifyContent: "center",
  },
  full: {
    width: "100%",
    height: "100%",
  },
});
