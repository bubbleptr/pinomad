import { Button } from "../../shared/ui/button.tsx";
import { Field, FieldDescription, FieldLabel } from "../../shared/ui/field.tsx";
import { Input } from "../../shared/ui/input.tsx";
import { useEffect, useState } from "react";
import type { AccountError, HostLinkRequest } from "@pinomad/client/account.ts";
import { useAccountModel } from "../../entities/account/account-context.tsx";
import { formatUserCode, isCompleteUserCode, normalizeUserCode } from "../../entities/account/host-link-code.ts";
import { browserKnownHosts, type KnownHostsStore } from "../../entities/account/known-hosts.ts";
import { CopyIcon } from "../../shared/ui/icon-swap.tsx";
import { useNow } from "../../shared/use-now.ts";
import { accountErrorMessage } from "./account-error.ts";
import { Alert, AlertDescription, AlertTitle } from "../../shared/ui/alert.tsx";
import { Spinner } from "../../shared/ui/spinner.tsx";

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
        <div className="flex items-center gap-2">
          <Spinner size="sm" />
          <span className="text-xs/5 text-muted-foreground">{step.kind === "looking" ? "Looking up the host…" : "Handing the answer back to the host…"}</span>
        </div>
      );
    case "missing":
      return (
        <div className="flex flex-col gap-3" style={{ width: "100%" }}>
          <Alert variant="destructive">
            <AlertTitle>Couldn't find this host</AlertTitle>
            <AlertDescription>
              {step.error.code === "not_found"
                ? "It's no longer waiting: it timed out, or it was confirmed or denied already. Run pinomad up on it again."
                : accountErrorMessage(step.error)}
            </AlertDescription>
          </Alert>
          {onClose === undefined ? null : (
            <div className="flex">
              <Button variant="secondary" onClick={onClose}>Close</Button>
            </div>
          )}
        </div>
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
    <div className="flex flex-col gap-3" style={{ width: "100%" }}>
      <Field>
        <FieldLabel>Code from the host</FieldLabel>
        <FieldDescription>The host's terminal shows it, like KXHN-BWCV.</FieldDescription>
        <Input
          placeholder="XXXX-XXXX"
          value={formatUserCode(code)}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") onSubmit();
          }}
        />
      </Field>
      {error === undefined ? null : (
        <Alert variant="destructive">
          <AlertTitle>Couldn't find that host</AlertTitle>
          <AlertDescription>{hostLinkErrorMessage(error, "lookup")}</AlertDescription>
        </Alert>
      )}
      <div className="flex items-center gap-2">
        <Button variant="primary" loading={isBusy} disabled={!isCompleteUserCode(code)} onClick={onSubmit}>Continue</Button>
        {onCancel === undefined ? null : <Button variant="secondary" onClick={onCancel}>Cancel</Button>}
      </div>
    </div>
  );
}

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
    <div className="flex flex-col gap-4" style={{ width: "100%" }}>
      <div className="flex flex-col gap-1">
        <h3 className="text-[1.0625rem]/6 font-bold">Add this host to your account?</h3>
        <span className="text-xs/5 text-muted-foreground">Only confirm a computer you are setting up yourself right now.</span>
      </div>
      {request.ipDiffers ? (
        <Alert variant="warning">
          <AlertTitle>This request came from a different network address than this device</AlertTitle>
          <AlertDescription>{`The host asked from ${request.sourceIp}. If you aren't setting it up on another network yourself, deny it.`}</AlertDescription>
        </Alert>
      ) : null}
      <dl className="m-0 grid grid-cols-[auto_1fr] items-baseline gap-x-4 gap-y-2 text-sm/5 *:min-h-6 [&>dd]:m-0 [&>dd]:break-words [&>dt]:flex [&>dt]:items-center [&>dt]:font-medium [&>dt]:text-muted-foreground">
        <dt>Name</dt>
        <dd>
          <span className="text-sm/5 font-semibold">{request.name}</span>
        </dd>
        <dt>System</dt>
        <dd>
          <span className="text-sm/5">{request.os}</span>
        </dd>
        <dt>Asked from</dt>
        <dd>
          <span className="font-mono text-sm/5">{request.sourceIp}</span>
        </dd>
        <dt>Host ID</dt>
        <dd>
          <div className="flex flex-wrap items-center gap-2">
            {/* In full: it is compared against the host's terminal. */}
            <span className="font-mono text-sm/5 break-all">{request.hostId}</span>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                void navigator.clipboard?.writeText(request.hostId).then(() => setCopied(true), () => undefined);
              }}
            >
              <CopyIcon copied={copied} />
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
        </dd>
      </dl>
      {expired ? (
        <Alert variant="warning">
          <AlertTitle>This request has expired</AlertTitle>
          <AlertDescription>Run pinomad up on the host again.</AlertDescription>
        </Alert>
      ) : (
        <span className="text-xs/5 text-muted-foreground tabular-nums">
          The host's terminal should show the same name and ID. Expires in {Math.floor(seconds / 60)}:
          {String(seconds % 60).padStart(2, "0")}
        </span>
      )}
      {error === undefined ? null : (
        <Alert variant="destructive">
          <AlertTitle>Couldn't answer the host</AlertTitle>
          <AlertDescription>{hostLinkErrorMessage(error, "answer")}</AlertDescription>
        </Alert>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex gap-2">
          <Button
            variant="primary"
            loading={busy === "confirm"}
            disabled={expired || busy === "deny"}
            onClick={onConfirm}
          >
            Confirm
          </Button>
          <Button variant="secondary" loading={busy === "deny"} disabled={busy === "confirm"} onClick={onDeny}>Deny</Button>
        </div>
        {onBack === undefined ? null : (
          <Button variant="ghost" disabled={busy !== undefined} onClick={onBack}>Enter another code</Button>
        )}
      </div>
    </div>
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
    <div className="flex flex-col gap-3" style={{ width: "100%" }}>
      {outcome === "confirmed" ? (
        <Alert variant="success">
          <AlertTitle>{`${name} joined your account`}</AlertTitle>
          <AlertDescription>It will appear in your hosts and connect on its own once its terminal finishes setting up.</AlertDescription>
        </Alert>
      ) : (
        <Alert variant="info">
          <AlertTitle>{`Turned ${name} away`}</AlertTitle>
          <AlertDescription>Its terminal will say the join was denied.</AlertDescription>
        </Alert>
      )}
      <div className="flex">
        <Button variant="secondary" onClick={onDone}>Done</Button>
      </div>
    </div>
  );
}
