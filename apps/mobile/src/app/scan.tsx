// Scan a host's pairing QR — the code encodes the same link the paste form
// accepts, so pairingFragment(data) produces the fragment /pair consumes.
import { CameraView, useCameraPermissions } from "expo-camera";
import { useRouter } from "expo-router";
import { useRef, useState } from "react";
import { Linking, Text, View } from "react-native";
import { Button, Spinner } from "heroui-native";
import { pairingFragment } from "@pinomad/protocol/pairing-link.ts";

export default function ScanScreen() {
  const router = useRouter();
  const [permission, requestPermission] = useCameraPermissions();
  // Only the first valid scan navigates; the camera keeps firing meanwhile.
  const consumed = useRef(false);
  // Invalid codes get a quiet inline hint, keyed on the data so repeats don't spam.
  const [badScan, setBadScan] = useState<string>();

  const onScanned = ({ data }: { data: string }): void => {
    if (consumed.current) return;
    const fragment = pairingFragment(data);
    if (fragment !== undefined) {
      consumed.current = true;
      router.replace({ pathname: "/pair", params: { fragment } });
      return;
    }
    setBadScan((previous) => (previous === data ? previous : data));
  };

  if (permission === null || !permission.granted) {
    const canAsk = permission === null || permission.canAskAgain;
    return (
      <View className="bg-background" style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 16, padding: 24 }}>
        {permission === null ? (
          <Spinner />
        ) : (
          <>
            <Text className="text-foreground" style={{ fontSize: 17, fontWeight: "600" }}>
              Camera access needed
            </Text>
            <Text className="text-muted" style={{ textAlign: "center" }}>
              PiNomad uses the camera only to scan a host's pairing QR code.
            </Text>
            {canAsk ? (
              <Button onPress={() => void requestPermission()}>Allow camera access</Button>
            ) : (
              <Button onPress={() => void Linking.openSettings()}>Open Settings</Button>
            )}
            <Button variant="secondary" onPress={() => router.back()}>
              Back
            </Button>
          </>
        )}
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: "#000" }}>
      <CameraView
        style={{ flex: 1 }}
        barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
        onBarcodeScanned={onScanned}
      />
      {badScan === undefined ? null : (
        <View style={{ position: "absolute", bottom: 48, left: 24, right: 24, alignItems: "center" }}>
          <View className="bg-surface-tertiary" style={{ borderRadius: 10, paddingHorizontal: 14, paddingVertical: 8 }}>
            <Text className="text-foreground" style={{ fontSize: 13 }}>
              Not a PiNomad pairing code
            </Text>
          </View>
        </View>
      )}
    </View>
  );
}
