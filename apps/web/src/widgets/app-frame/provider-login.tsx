import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Link } from "../../shared/ui/link.tsx";
import { RadioList, RadioListItem } from "@astryxdesign/core/RadioList";
import { Spinner } from "@astryxdesign/core/Spinner";
import { TextInput } from "@astryxdesign/core/TextInput";
import { useEffect, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from "react";
import type { LoginEvent, LoginFlow, LoginMethod, LoginPrompt } from "@pinomad/protocol/auth.ts";
import { DisconnectedError, type RemoteDurable } from "@pinomad/protocol/remote-durable.ts";
import { Check, Copy, LinkExternal } from "../../shared/ui/icons.tsx";

const iconSize: CSSProperties = { width: "var(--spacing-4)", height: "var(--spacing-4)" };

const messageOf = (reason: unknown): string => (reason instanceof Error ? reason.message : String(reason));

const openInNewTab = (url: string): void => void window.open(url, "_blank", "noopener,noreferrer");

/**
 * One login, driven by pi's own events and prompts (ADR-0031): the host
 * pushes the flow in `providers.logins`, this form shows its events and
 * current prompt, and each answer goes back by prompt id. The next prompt
 * replaces the answered one in place.
 *
 * A flow this panel started is cancelled when the panel goes away while it
 * still runs — leaving the page abandons the login. OAuth waits for the
 * user to press `signIn`; an API key login starts on arrival.
 */
export function LoginPanel({
  providerId,
  method,
  logins,
  remote,
  connected,
  intro,
  signIn,
  onDone,
  onCancel,
}: {
  providerId: string;
  method: LoginMethod;
  logins: readonly LoginFlow[];
  remote: RemoteDurable;
  connected: boolean;
  /** Shown above the sign-in button before an OAuth login starts. */
  intro?: ReactNode;
  /** The OAuth start button's label. */
  signIn?: string;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [loginId, setLoginId] = useState<string>();
  const [starting, setStarting] = useState(false);
  // The start was cut off by a disconnect, so the host may have begun it.
  const [cutOff, setCutOff] = useState(false);
  const [startError, setStartError] = useState<string>();
  const flow = loginId === undefined ? undefined : logins.find((entry) => entry.id === loginId);

  // The login to cancel if the panel unmounts: set once begun, cleared once
  // the flow ends or the user cancels it. A start that resolves after its
  // panel went away (a quick Back) is cancelled on arrival.
  const running = useRef<string | undefined>(undefined);
  const generation = useRef(0);
  const mounted = useRef(false);

  const start = (): void => {
    const mine = ++generation.current;
    setStarting(true);
    setCutOff(false);
    setStartError(undefined);
    remote.controller.beginLogin(providerId, method).then(
      (id) => {
        if (mine !== generation.current) {
          void remote.controller.cancelLogin(id).catch(() => undefined);
          return;
        }
        running.current = id;
        setLoginId(id);
        setStarting(false);
      },
      (reason: unknown) => {
        if (mine !== generation.current) return;
        setCutOff(reason instanceof DisconnectedError);
        setStartError(messageOf(reason));
        setStarting(false);
      },
    );
  };

  useEffect(() => {
    mounted.current = true;
    // StrictMode's dev remount keeps this instance and its first start: the
    // host runs one login per provider, so a second begin would be refused.
    if (method === "api_key" && generation.current === 0) start();
    return () => {
      mounted.current = false;
      // That remount happens synchronously after this cleanup; only a panel
      // still unmounted a microtask later has really gone away.
      queueMicrotask(() => {
        if (mounted.current) return;
        generation.current++;
        const id = running.current;
        running.current = undefined;
        if (id !== undefined) void remote.controller.cancelLogin(id).catch(() => undefined);
      });
    };
    // Mount/unmount only: the page keys this panel by provider and method.
  }, []);

  // A begin whose result never arrived (the connection dropped after the host
  // started the login) leaves the flow running with no id here, so take over
  // the provider's running flow from the stream. Not after the host refused
  // the start: a flow it lists then is another device's login.
  const orphan =
    cutOff && !starting && loginId === undefined
      ? logins.find((entry) => entry.providerId === providerId && entry.method === method && entry.state === "running")
      : undefined;
  useEffect(() => {
    if (orphan === undefined) return;
    running.current = orphan.id;
    setLoginId(orphan.id);
    setStartError(undefined);
  }, [orphan?.id]);

  // The host drops an ended flow after a while; if this page missed the end
  // (say, across a reconnect), a flow that was listed and is gone has ended.
  const seen = useRef(false);
  if (flow !== undefined) seen.current = true;
  const dropped = loginId !== undefined && flow === undefined && seen.current;
  useEffect(() => {
    if (!dropped) return;
    running.current = undefined;
    onCancel();
  }, [dropped]);

  const state = flow?.state;
  useEffect(() => {
    if (state === undefined || state === "running") return;
    running.current = undefined;
    if (state === "succeeded") onDone();
    else if (state === "cancelled") onCancel();
  }, [state]);

  const [cancelError, setCancelError] = useState<string>();
  const cancel = (): void => {
    const id = running.current;
    if (id === undefined) return onCancel();
    running.current = undefined;
    setCancelError(undefined);
    remote.controller.cancelLogin(id).then(onCancel, (reason: unknown) => {
      running.current = id;
      setCancelError(messageOf(reason));
    });
  };

  if (loginId === undefined) {
    if (method === "api_key" && startError === undefined) return <Status label="Starting…" />;
    return (
      <div className="flex flex-col gap-3">
        {intro}
        {startError === undefined ? null : <Banner status="error" title="Couldn't start the login" description={startError} />}
        <div className="flex flex-wrap gap-2">
          <Button
            label={method === "api_key" ? "Try again" : (signIn ?? "Sign in")}
            variant="primary"
            isLoading={starting}
            isDisabled={!connected}
            onClick={start}
          />
          <Button label="Cancel" variant="secondary" onClick={onCancel} />
        </div>
      </div>
    );
  }

  if (flow === undefined) return <Status label="Starting…" />;

  if (flow.state === "failed") {
    return (
      <Banner
        status="error"
        title={method === "api_key" ? "The key wasn't saved" : "Sign-in failed"}
        description={flow.error}
        endContent={<Button label="Try again" size="sm" isDisabled={!connected} isLoading={starting} onClick={start} />}
      />
    );
  }

  if (flow.state !== "running") return <Status label={flow.state === "succeeded" ? "Saved" : "Cancelled"} />;

  return (
    <div className="flex flex-col gap-4">
      <LoginEvents events={flow.events} />
      {flow.prompt === undefined ? (
        <div className="flex flex-col gap-3">
          <Status label={waitingLabel(flow.events)} />
          <CancelRow error={cancelError} onCancel={cancel} />
        </div>
      ) : (
        <PromptForm
          key={flow.prompt.id}
          prompt={flow.prompt}
          connected={connected}
          onAnswer={(value) => remote.controller.answerLogin(flow.id, flow.prompt!.id, value)}
          cancelError={cancelError}
          onCancel={cancel}
        />
      )}
    </div>
  );
}

/** What a running login without a prompt is doing: approving a device code, or pi's latest progress note. */
const waitingLabel = (events: readonly LoginEvent[]): string => {
  const last = events.findLast((event) => event.type === "progress" || event.type === "device_code");
  if (last?.type === "progress") return last.message;
  return last?.type === "device_code" ? "Waiting for you to approve…" : "Working…";
};

function Status({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2">
      <Spinner size="sm" />
      <span className="text-xs/5 text-muted-foreground" role="status">
        {label}
      </span>
    </div>
  );
}

function CancelRow({ error, onCancel }: { error?: string; onCancel: () => void }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button label="Cancel" variant="secondary" onClick={onCancel} />
      {error === undefined ? null : <InlineError message={error} />}
    </div>
  );
}

export function InlineError({ message }: { message: string }) {
  return (
    <span className="text-xs/5 text-muted-foreground" role="alert" style={{ color: "var(--destructive)" }}>
      {message}
    </span>
  );
}

/**
 * The flow's events oldest first. Only the latest sign-in page and device
 * code count — a retry supersedes the earlier one — and progress notes show
 * as the waiting status instead.
 */
function LoginEvents({ events }: { events: readonly LoginEvent[] }) {
  const lastAuthUrl = events.findLastIndex((event) => event.type === "auth_url");
  const lastDeviceCode = events.findLastIndex((event) => event.type === "device_code");
  const shown = events
    .map((event, index) => ({ event, index }))
    .filter(
      ({ event, index }) =>
        event.type === "info" ||
        (event.type === "auth_url" && index === lastAuthUrl) ||
        (event.type === "device_code" && index === lastDeviceCode),
    );
  if (shown.length === 0) return null;
  return (
    <div className="flex flex-col gap-4">
      {shown.map(({ event, index }) => (
        <LoginEventView key={index} event={event} />
      ))}
    </div>
  );
}

function LoginEventView({ event }: { event: LoginEvent }) {
  switch (event.type) {
    case "info":
      return (
        <div className="flex flex-col gap-1">
          <p className="text-xs/5 text-muted-foreground">
            {event.message}
          </p>
          {event.links === undefined || event.links.length === 0 ? null : (
            <div className="flex flex-wrap gap-3">
              {event.links.map((link) => (
                <Link key={link.url} href={link.url} external className="text-sm/5">
                  {link.label ?? link.url}
                </Link>
              ))}
            </div>
          )}
        </div>
      );
    case "auth_url":
      return (
        <div className="flex flex-col gap-2">
          <p className="text-sm/5">{event.instructions ?? "Open the sign-in page and approve access."}</p>
          <div className="flex gap-2">
            <Button
              label="Open sign-in page"
              icon={<LinkExternal aria-hidden="true" style={iconSize} />}
              size="sm"
              onClick={() => openInNewTab(event.url)}
            />
          </div>
        </div>
      );
    case "device_code":
      return <DeviceCode code={event.userCode} url={event.verificationUri} />;
    case "progress":
      return null;
  }
}

const hostOf = (url: string): { host: string; display: string } => {
  try {
    const parsed = new URL(url);
    return { host: parsed.host, display: `${parsed.host}${parsed.pathname === "/" ? "" : parsed.pathname}` };
  } catch {
    return { host: url, display: url };
  }
};

function DeviceCode({ code, url }: { code: string; url: string }) {
  const [copied, setCopied] = useState(false);
  const { host, display } = hostOf(url);
  return (
    <ol className="providers-steps">
      <li>
        <div className="flex flex-col gap-2">
          <span className="text-sm/5">Copy this code.</span>
          <div className="flex flex-wrap items-center gap-3">
            <span className="providers-code">{code}</span>
            <Button
              label={copied ? "Copied" : "Copy"}
              size="sm"
              icon={copied ? <Check aria-hidden="true" style={iconSize} /> : <Copy aria-hidden="true" style={iconSize} />}
              onClick={() => {
                void navigator.clipboard?.writeText(code).then(() => setCopied(true), () => undefined);
              }}
            />
          </div>
        </div>
      </li>
      <li>
        <div className="flex flex-col gap-2">
          <span className="text-sm/5">
            Enter it at <span className="providers-mono">{display}</span>
          </span>
          <div className="flex gap-2">
            <Button
              label={`Open ${host}`}
              icon={<LinkExternal aria-hidden="true" style={iconSize} />}
              size="sm"
              onClick={() => openInNewTab(url)}
            />
          </div>
        </div>
      </li>
    </ol>
  );
}

/** pi phrases prompts as questions ending in ":"; a field label reads better without it. */
const labelOf = (prompt: LoginPrompt): string => prompt.message.replace(/:\s*$/, "");

/**
 * The current prompt as one field. Text prompts may be answered empty —
 * pi uses that for "blank for the default" — secrets and pasted codes may not.
 */
function PromptForm({
  prompt,
  connected,
  onAnswer,
  cancelError,
  onCancel,
}: {
  prompt: LoginPrompt;
  connected: boolean;
  onAnswer: (value: string) => Promise<void>;
  cancelError?: string;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(prompt.type === "select" ? (prompt.options[0]?.id ?? "") : "");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();
  const required = prompt.type === "secret" || prompt.type === "manual_code" || prompt.type === "select";
  const canSubmit = connected && !sending && (!required || value.trim() !== "");

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (!canSubmit) return;
    setSending(true);
    setError(undefined);
    // Success leaves `sending` on: the host replaces this prompt next.
    onAnswer(prompt.type === "text" ? value : value.trim()).catch((reason: unknown) => {
      setError(messageOf(reason));
      setSending(false);
    });
  };

  const status = error === undefined ? undefined : { type: "error" as const, message: error };
  return (
    <form onSubmit={submit} autoComplete="off">
      <div className="flex flex-col gap-3">
        {prompt.type === "select" ? (
          <RadioList label={labelOf(prompt)} value={value} onChange={setValue} isDisabled={!connected} status={status}>
            {prompt.options.map((option) => (
              <RadioListItem key={option.id} value={option.id} label={option.label} description={option.description} />
            ))}
          </RadioList>
        ) : (
          <TextInput
            label={labelOf(prompt)}
            type={prompt.type === "secret" ? "password" : "text"}
            value={value}
            onChange={(next) => {
              setValue(next);
              setError(undefined);
            }}
            placeholder={prompt.placeholder}
            hasAutoFocus
            isDisabled={!connected}
            status={status}
            width="100%"
          />
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button label="Continue" variant="primary" type="submit" isLoading={sending} isDisabled={!canSubmit} />
          <Button label="Cancel" variant="secondary" onClick={onCancel} />
          {cancelError === undefined ? null : <InlineError message={cancelError} />}
        </div>
      </div>
    </form>
  );
}
