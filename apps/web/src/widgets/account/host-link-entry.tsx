import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { MetadataList, MetadataListItem } from "@astryxdesign/core/MetadataList";
import { Spinner } from "@astryxdesign/core/Spinner";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Tooltip } from "@astryxdesign/core/Tooltip";
import { useEffect, useState, type CSSProperties } from "react";
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
        : "This host is no longer waiting: it timed out, or it was confirmed or denied elsewhere. Run pinomad up on it again.";
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
 * `onSettled` fires with the answer once the server took it; `onClose`, where given,
 * puts a Cancel on the entry and makes Done close instead of starting over.
 */
export function HostLinkEntry({
  knownHosts = browserKnownHosts,
  onSettled,
  onClose,
}: {
  knownHosts?: KnownHostsStore;
  onSettled?: (outcome: "confirmed" | "denied") => void;
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
        account.watchForHost(request.hostId);
      }
      setStep({ kind: confirm ? "confirmed" : "denied", name: request.name });
      onSettled?.(confirm ? "confirmed" : "denied");
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

type RequestStep =
  | { readonly kind: "looking" }
  | { readonly kind: "missing"; readonly error: AccountError }
  | { readonly kind: "confirm"; readonly request: HostLinkRequest; readonly error?: AccountError }
  | { readonly kind: "leaving" };

/**
 * Confirm a host whose `pinomad up` opened this page on its own computer
 * (#513): the request id comes in the address, the host is looked up right
 * away, and the answer goes back to the host by sending the browser to its
 * listener on 127.0.0.1. Unlike a code, the id may come from a link: a
 * request someone else started redirects to 127.0.0.1 on this device, where
 * their host isn't listening, so confirming it hands them nothing.
 */
export function HostLinkRequestEntry({
  requestId,
  navigate,
  knownHosts = browserKnownHosts,
  onSettled,
  onClose,
}: {
  requestId: string;
  /** Leaves for the host's redirect; `window.location.assign` in the app. */
  navigate: (url: string) => void;
  knownHosts?: KnownHostsStore;
  onSettled?: () => void;
  onClose?: () => void;
}) {
  const account = useAccountModel();
  const [step, setStep] = useState<RequestStep>({ kind: "looking" });
  const [busy, setBusy] = useState<"confirm" | "deny">();

  useEffect(() => {
    let live = true;
    void account.lookupHostLinkRequest(requestId).then((result) => {
      if (live) setStep(result.ok ? { kind: "confirm", request: result.value } : { kind: "missing", error: result.error });
    });
    return () => {
      live = false;
    };
  }, [account, requestId]);

  const answer = (confirm: boolean): void => {
    if (step.kind !== "confirm" || busy !== undefined) return;
    const { request } = step;
    setBusy(confirm ? "confirm" : "deny");
    void (confirm ? account.confirmHostLinkRequest(requestId) : account.denyHostLinkRequest(requestId)).then((result) => {
      setBusy(undefined);
      if (!result.ok) {
        setStep({ ...step, error: result.error });
        return;
      }
      if (confirm && account.state.status === "signed-in") {
        knownHosts.add({ serverOrigin: account.state.serverOrigin, user: account.state.user }, request.hostId);
        account.watchForHost(request.hostId);
      }
      setStep({ kind: "leaving" });
      onSettled?.();
      navigate(result.value);
    });
  };

  switch (step.kind) {
    case "looking":
    case "leaving":
      return (
        <HStack gap={2} vAlign="center">
          <Spinner size="sm" />
          <Text type="supporting">{step.kind === "looking" ? "Looking up the host…" : "Handing the answer back to the host…"}</Text>
        </HStack>
      );
    case "missing":
      return (
        <VStack gap={3} style={{ width: "100%" }}>
          <Banner
            status="error"
            title="Couldn't find this host"
            description={
              step.error.code === "not_found"
                ? "It's no longer waiting: it timed out, or it was confirmed or denied already. Run pinomad up on it again."
                : accountErrorMessage(step.error)
            }
          />
          {onClose === undefined ? null : (
            <HStack>
              <Button label="Close" variant="secondary" onClick={onClose} />
            </HStack>
          )}
        </VStack>
      );
    case "confirm":
      return (
        <HostLinkConfirm
          request={step.request}
          error={step.error}
          busy={busy}
          onConfirm={() => answer(true)}
          onDeny={() => answer(false)}
        />
      );
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
        description="The host's terminal shows it, like KXHN-BWCV."
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
  /** Back to the code field; a loopback request (#513) has none to go back to. */
  onBack?: () => void;
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
        <Banner status="warning" title="This request has expired" description="Run pinomad up on the host again." />
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
        {onBack === undefined ? null : (
          <Button label="Enter another code" variant="ghost" isDisabled={busy !== undefined} onClick={onBack} />
        )}
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
