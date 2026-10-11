import { useState } from "react";
import { Text, View } from "react-native";
import { Button, FieldError, Input, Label, TextField } from "heroui-native";
import { pairingFragment } from "@pinomad/protocol/pairing-link.ts";

/** Paste a pairing link (web `http(s)://…#pair=…` or `pinomad://pair#…`) to reach the confirm step. */
export function PairingForm({ onFragment }: { onFragment: (fragment: string) => void }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string>();
  const submit = (): void => {
    const fragment = pairingFragment(value);
    if (fragment === undefined) {
      setError("Not a valid pairing link — paste the full link `pinomad pair` prints.");
      return;
    }
    onFragment(fragment);
  };
  return (
    <View style={{ gap: 16, width: "100%" }}>
      <View style={{ gap: 6 }}>
        <Text className="text-foreground" style={{ fontSize: 20, fontWeight: "600" }}>
          Pair with a host
        </Text>
        <Text className="text-muted">Paste a pairing link from `pinomad pair` or Devices → Pair a device.</Text>
      </View>
      <TextField isInvalid={error !== undefined}>
        <Label>Pairing link</Label>
        <Input
          testID="pairing-link-input"
          value={value}
          onChangeText={(text) => {
            setValue(text);
            setError(undefined);
          }}
          placeholder="http://…#pair=… or pinomad://pair#…"
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="off"
          onSubmitEditing={submit}
        />
        <FieldError>{error}</FieldError>
      </TextField>
      <Button onPress={submit} isDisabled={value.trim() === ""}>
        Continue
      </Button>
    </View>
  );
}
