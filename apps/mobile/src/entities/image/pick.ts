// The three ways an image reaches the composer: photo library, camera,
// clipboard. Each resolves to ImageSource[] for the attachment store; an
// empty array means the user cancelled, a thrown Error carries the reason
// to show by the input.
import * as ImagePicker from "expo-image-picker";
import * as Clipboard from "expo-clipboard";
import type { ImageSource } from "./attachment-store.ts";

const toSource = (asset: ImagePicker.ImagePickerAsset): ImageSource => ({
  uri: asset.uri,
  // The picker can report 0×0; prepare probes the real size then.
  ...(asset.width > 0 && asset.height > 0 ? { width: asset.width, height: asset.height } : {}),
});

export async function pickFromLibrary(freeSlots: number): Promise<ImageSource[]> {
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ["images"],
    allowsMultipleSelection: true,
    // Asking the picker for more than the free slots would just be discarded.
    selectionLimit: Math.max(1, freeSlots),
    orderedSelection: true,
    exif: false,
  });
  if (result.canceled) return [];
  return result.assets.filter((asset) => asset.type === "image" || asset.type == null).map(toSource);
}

export async function takePhoto(): Promise<ImageSource[]> {
  const permission = await ImagePicker.requestCameraPermissionsAsync();
  if (!permission.granted) throw new Error("Camera access is off — enable it in Settings");
  const result = await ImagePicker.launchCameraAsync({ mediaTypes: ["images"], exif: false });
  if (result.canceled) return [];
  return result.assets.map(toSource);
}

export async function pasteClipboard(): Promise<ImageSource[]> {
  if (!(await Clipboard.hasImageAsync())) throw new Error("Clipboard has no image");
  const image = await Clipboard.getImageAsync({ format: "png" });
  if (image === null) throw new Error("Clipboard has no image");
  // `data` is already a data URI, which the manipulator reads directly.
  return [{ uri: image.data, width: image.size.width, height: image.size.height }];
}
