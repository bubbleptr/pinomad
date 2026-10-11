import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { HStack } from "@astryxdesign/core/Layout";
import { TextInput } from "@astryxdesign/core/TextInput";
import { useState } from "react";
import { pairingFragment } from "../../address.ts";

/**
 * Paste-a-pairing-link form: a valid link becomes the location fragment and a
 * reload re-resolves the address into the pair-confirm flow. Shared by the
 * no-link screen and the desktop's "Pair another host" dialog.
 */
export function PairingLinkForm() {
  const [pasted, setPasted] = useState("");
  const [error, setError] = useState<string>();
  const connect = (): void => {
    const fragment = pairingFragment(pasted);
    if (fragment === undefined) {
      // Token links deserve the specific hint: they exist, they just can't pair.
      setError(
        /[#?&]token=/.test(pasted)
          ? "Token links can't pair a device — paste a pairing link instead (pinomad pair, or Devices → Pair a device)."
          : "That isn't a pairing link — paste one like http://<host>/#pair=… or pinomad://pair#pair=…",
      );
      return;
    }
    window.location.hash = fragment;
    window.location.reload();
  };
  return (
    <>
      <HStack gap={2} vAlign="end" style={{ width: "100%" }}>
        <div className="min-w-0 flex-1">
          <TextInput
            label="Pairing link"
            isLabelHidden
            placeholder="http://…/#pair=… or pinomad://pair#…"
            value={pasted}
            onChange={(value) => {
              setError(undefined);
              setPasted(value);
            }}
            onEnter={connect}
            width="100%"
          />
        </div>
        <Button label="Connect" variant="primary" isDisabled={pasted.trim() === ""} onClick={connect} />
      </HStack>
      {error === undefined ? null : <Banner status="error" title="Not a pairing link" description={error} />}
    </>
  );
}
