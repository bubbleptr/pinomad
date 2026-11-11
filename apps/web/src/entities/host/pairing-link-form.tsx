import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { TextInput } from "@astryxdesign/core/TextInput";
import { useState } from "react";
import { pairingFragment } from "../../address.ts";

/**
 * Paste-a-pairing-link form: a valid link becomes the location fragment and a
 * reload re-resolves the address into the pair-confirm flow. Shared by the
 * no-link screen, Settings → Hosts, and the connection-failure screens.
 */
export function PairingLinkForm({
  connectVariant = "primary",
}: {
  /** Secondary where another action is the screen's primary one. */
  connectVariant?: "primary" | "secondary";
} = {}) {
  const [pasted, setPasted] = useState("");
  const [error, setError] = useState<string>();
  const connect = (): void => {
    const fragment = pairingFragment(pasted);
    if (fragment === undefined) {
      // Token links deserve the specific hint: they exist, they just can't pair.
      setError(
        /[#?&]token=/.test(pasted)
          ? "Token links can't pair a device — paste a pairing link instead (pinomad pair, or Settings → Devices → Pair a device)."
          : "That isn't a pairing link — paste one like http://<host>/#pair=… or pinomad://pair#pair=…",
      );
      return;
    }
    window.location.hash = fragment;
    window.location.reload();
  };
  return (
    <>
      <div className="flex items-end gap-2" style={{ width: "100%" }}>
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
        <Button label="Connect" variant={connectVariant} isDisabled={pasted.trim() === ""} onClick={connect} />
      </div>
      {error === undefined ? null : <Banner status="error" title="Not a pairing link" description={error} />}
    </>
  );
}
