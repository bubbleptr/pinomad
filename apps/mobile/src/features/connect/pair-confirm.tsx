import { Text, View } from "react-native";
import { Button, Card } from "heroui-native";

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * Confirm before pairing — a drive-by link must never register this device
 * without the user seeing which host it is.
 */
export function PairConfirm({ url, onPair, onCancel }: { url: string; onPair(): void; onCancel(): void }) {
  return (
    <View style={{ gap: 16, width: "100%" }}>
      <Card>
        <Card.Header>
          <Card.Title>Pair with this host?</Card.Title>
          <Card.Description>This device will pair with {hostOf(url)}.</Card.Description>
        </Card.Header>
        <Card.Body>
          <Text className="text-muted" style={{ fontSize: 13 }} selectable>
            {url}
          </Text>
        </Card.Body>
        <Card.Footer style={{ flexDirection: "row", gap: 12, justifyContent: "flex-end" }}>
          <Button variant="secondary" onPress={onCancel}>
            Cancel
          </Button>
          <Button variant="primary" onPress={onPair}>
            Pair
          </Button>
        </Card.Footer>
      </Card>
    </View>
  );
}
