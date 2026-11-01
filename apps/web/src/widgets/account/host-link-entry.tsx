import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { MetadataList, MetadataListItem } from "@astryxdesign/core/MetadataList";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Tooltip } from "@astryxdesign/core/Tooltip";
import { useState, type CSSProperties } from "react";
import type { AccountError, HostLinkRequest } from "@pinomad/client/account.ts";
import { useAccountModel } from "../../entities/account/account-context.tsx";
import { formatUserCode, isCompleteUserCode, normalizeUserCode } from "../../entities/account/host-link-code.ts";
import { browserKnownHosts, type KnownHostsStore } from "../../entities/account/known-hosts.ts";
import { Check, Copy } from "../../shared/ui/icons.tsx";
import { useNow } from "../../shared/use-now.ts";
import { accountErrorMessage } from "./account-error.ts";

/** What a refused lookup means; confirm and deny refuse the same way, after the user saw the host. */
export function hostLinkErrorMessage(error: AccountError, step: "lookup" | "answer"): string {
  switch (error.code) {
    case "not_found":
      return step === "lookup"
        ? "No host is waiting with this code. Check it against the host's terminal; codes expire after 10 minutes."
        : "This host is no longer waiting: its code expired, or it was confirmed or denied elsewhere. Run pinomad join on it again.";
    case "rate_limited":
      return "Too many wrong codes. Wait 15 minutes and try again.";
    case "invalid_request":
      return "Enter the 8-letter code from the host's terminal.";
    default:
      return accountErrorMessage(error);
  }
}

type Step =
  | { readonly kind: "entry"; readonly error?: AccountError }
  | { readonly kind: "confirm"; readonly code: string; readonly request: HostLinkRequest; readonly error?: AccountError }
  | { readonly kind: "confirmed" | "denied"; readonly name: string };

/**
 * Confirm a host that ran `pinomad join <origin>` without a token (#496):
 * type the code its terminal shows, see which machine is asking, then
 * Confirm or Deny. The code is only ever typed, never taken from the address
 * or a link: a code handed over by someone else is the phishing path.
 *
 * `onSettled` fires once the server took the answer; `onClose`, where given,
 * puts a Cancel on the entry and makes Done close instead of starting over.
 */
export function HostLinkEntry({
  knownHosts = browserKnownHosts,
  onSettled,
  onClose,
}: {
  knownHosts?: KnownHostsStore;
  onSettled?: () => void;
  onClose?: () => void;
}) {
  const account = useAccountModel();
  const [code, setCode] = useState("");
  const [step, setStep] = useState<Step>({ kind: "entry" });
  const [busy, setBusy] = useState<"lookup" | "confirm" | "deny">();
  const reset = (): void => {
    setCode("");
    setStep({ kind: "entry" });
  };

  const lookUp = (): void => {
    if (!isCompleteUserCode(code) || busy !== undefined) return;
    const typed = formatUserCode(code);
    setBusy("lookup");
    void account.lookupHostLink(typed).then((result) => {
      setBusy(undefined);
      setStep(result.ok ? { kind: "confirm", code: typed, request: result.value } : { kind: "entry", error: result.error });
    });
  };

  const answer = (confirm: boolean): void => {
    if (step.kind !== "confirm" || busy !== undefined) return;
    const { code: typed, request } = step;
    setBusy(confirm ? "confirm" : "deny");
    void (confirm ? account.confirmHostLink(typed) : account.denyHostLink(typed)).then((result) => {
      setBusy(undefined);
      if (!result.ok) {
        setStep({ ...step, error: result.error });
        return;
      }
      if (confirm && account.state.status === "signed-in") {
        // This device asked for it; the notice is for hosts someone else let in.
        knownHosts.add({ serverOrigin: account.state.serverOrigin, user: account.state.user }, request.hostId);
        void account.refreshHosts();
      }
      setStep({ kind: confirm ? "confirmed" : "denied", name: request.name });
      onSettled?.();
    });
  };

  switch (step.kind) {
    case "entry":
      return (
        <HostLinkCodeForm
          code={code}
          error={step.error}
          isBusy={busy === "lookup"}
          onChange={(value) => setCode(normalizeUserCode(value))}
          onSubmit={lookUp}
          {...(onClose === undefined ? {} : { onCancel: onClose })}
        />
      );
    case "confirm":
      return (
        <HostLinkConfirm
          request={step.request}
          error={step.error}
          busy={busy === "confirm" || busy === "deny" ? busy : undefined}
          onConfirm={() => answer(true)}
          onDeny={() => answer(false)}
          onBack={reset}
        />
      );
    case "confirmed":
    case "denied":
      return <HostLinkOutcome outcome={step.kind} name={step.name} onDone={onClose ?? reset} />;
  }
}

/** The code input: one field that takes the code however it's typed and shows it as XXXX-XXXX. */
export function HostLinkCodeForm({
  code,
  error,
  isBusy = false,
  onChange,
  onSubmit,
  onCancel,
}: {
  /** Normalized letters; shown formatted. */
  code: string;
  error?: AccountError | undefined;
  isBusy?: boolean;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onCancel?: () => void;
}) {
  return (
    <VStack gap={3} style={{ width: "100%" }}>
      <TextInput
        label="Code from the host"
        description="The pinomad join command prints it, like KXHN-BWCV."
        placeholder="XXXX-XXXX"
        value={formatUserCode(code)}
        onChange={onChange}
        onEnter={onSubmit}
        width="100%"
      />
      {error === undefined ? null : (
        <Banner status="error" title="Couldn't find that host" description={hostLinkErrorMessage(error, "lookup")} />
      )}
      <HStack gap={2} vAlign="center">
        <Button label="Continue" variant="primary" isLoading={isBusy} isDisabled={!isCompleteUserCode(code)} onClick={onSubmit} />
        {onCancel === undefined ? null : <Button label="Cancel" variant="ghost" onClick={onCancel} />}
      </HStack>
    </VStack>
  );
}

const iconSize: CSSProperties = { width: "var(--spacing-4)", height: "var(--spacing-4)" };

/** The hostId's ends, enough to compare with the terminal; the full id is in the tooltip and on Copy. */
const shortHostId = (hostId: string): string => (hostId.length > 16 ? `${hostId.slice(0, 8)}…${hostId.slice(-6)}` : hostId);

/** Which machine is asking, and the two answers. */
export function HostLinkConfirm({
  request,
  error,
  busy,
  onConfirm,
  onDeny,
  onBack,
}: {
  request: HostLinkRequest;
  error?: AccountError | undefined;
  busy?: "confirm" | "deny" | undefined;
  onConfirm: () => void;
  onDeny: () => void;
  onBack: () => void;
}) {
  const now = useNow(1000);
  const [copied, setCopied] = useState(false);
  const seconds = Math.max(0, Math.ceil((request.expiresAt - now) / 1000));
  const expired = seconds === 0;
  return (
    <VStack gap={4} style={{ width: "100%" }}>
      <VStack gap={1}>
        <Heading level={3}>Add this host to your account?</Heading>
        <Text type="supporting">Only confirm a computer you are setting up yourself right now.</Text>
      </VStack>
      {request.ipDiffers ? (
        <Banner
          status="warning"
          title="This request came from a different network address than this device"
          description={`The host asked from ${request.sourceIp}. If you aren't setting it up on another network yourself, deny it.`}
        />
      ) : null}
      <MetadataList>
        <MetadataListItem label="Name">
          <Text weight="semibold">{request.name}</Text>
        </MetadataListItem>
        <MetadataListItem label="System">
          <Text>{request.os}</Text>
        </MetadataListItem>
        <MetadataListItem label="Asked from">
          <Text type="code">{request.sourceIp}</Text>
        </MetadataListItem>
        <MetadataListItem label="Host ID">
          <HStack gap={2} vAlign="center" wrap="wrap">
            <Tooltip content={request.hostId}>
              {/* Focusable so keyboard users reach the full id too. */}
              <span tabIndex={0} aria-label={`Host ID ${request.hostId}`}>
                <Text type="code">{shortHostId(request.hostId)}</Text>
              </span>
            </Tooltip>
            <Button
              label={copied ? "Copied" : "Copy"}
              variant="ghost"
              size="sm"
              icon={copied ? <Check aria-hidden="true" style={iconSize} /> : <Copy aria-hidden="true" style={iconSize} />}
              onClick={() => {
                void navigator.clipboard?.writeText(request.hostId).then(() => setCopied(true), () => undefined);
              }}
            />
          </HStack>
        </MetadataListItem>
      </MetadataList>
      {expired ? (
        <Banner status="warning" title="This code has expired" description="Run pinomad join on the host again for a new one." />
      ) : (
        <Text type="supporting" hasTabularNumbers>
          The host's terminal should show the same name and ID. Expires in {Math.floor(seconds / 60)}:
          {String(seconds % 60).padStart(2, "0")}
        </Text>
      )}
      {error === undefined ? null : (
        <Banner status="error" title="Couldn't answer the host" description={hostLinkErrorMessage(error, "answer")} />
      )}
      <HStack gap={2} vAlign="center" hAlign="between" wrap="wrap">
        <HStack gap={2}>
          <Button
            label="Confirm"
            variant="primary"
            isLoading={busy === "confirm"}
            isDisabled={expired || busy === "deny"}
            onClick={onConfirm}
          />
          <Button label="Deny" variant="secondary" isLoading={busy === "deny"} isDisabled={busy === "confirm"} onClick={onDeny} />
        </HStack>
        <Button label="Enter another code" variant="ghost" isDisabled={busy !== undefined} onClick={onBack} />
      </HStack>
    </VStack>
  );
}

/** After the answer: what happens next on the host. */
export function HostLinkOutcome({
  outcome,
  name,
  onDone,
}: {
  outcome: "confirmed" | "denied";
  name: string;
  onDone: () => void;
}) {
  return (
    <VStack gap={3} style={{ width: "100%" }}>
      {outcome === "confirmed" ? (
        <Banner
          status="success"
          title={`${name} joined your account`}
          description="It will appear in your hosts and connect on its own once its terminal finishes setting up."
        />
      ) : (
        <Banner status="info" title={`Turned ${name} away`} description="Its terminal will say the join was denied." />
      )}
      <HStack>
        <Button label="Done" variant="secondary" onClick={onDone} />
      </HStack>
    </VStack>
  );
}
