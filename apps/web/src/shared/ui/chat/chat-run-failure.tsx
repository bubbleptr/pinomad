import { useRef, useState, type ComponentProps, type ReactNode } from "react";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "../button.tsx";
import { Collapsible } from "@astryxdesign/core/Collapsible";
import { cn } from "cn";
import { classifyProviderFailure } from "@pinomad/client/provider-failure.ts";

function describeFailure(error: string) {
  const kind = classifyProviderFailure(error);
  if (kind === "auth") {
    return {
      title: "Provider authentication failed",
      description: "The provider rejected the credentials. Sign in again or update them in Provider settings, then retry. You can also choose another model.",
    };
  }
  if (kind === "entitlement") {
    return {
      title: "This model is not included in your subscription plan",
      description: "Test the connection in Settings → Providers.",
    };
  }
  if (/\b429\b|rate.?limit|quota.?exceeded/i.test(error)) {
    return {
      title: "Provider limit reached",
      description: "Wait a moment, or choose another model and retry.",
    };
  }
  return {
    title: "Run failed",
    description: /[{}\n]/.test(error)
      ? "The provider could not complete this request. Check the error details, then retry or choose another model."
      : error,
  };
}

type ChatRunFailureOwnProps = {
  error: string;
  onRetry?: () => Promise<void>;
  onOpenProviderSettings?: () => void;
  modelControl?: ReactNode;
};

export type ChatRunFailureProps = Omit<
  ComponentProps<"div">,
  keyof ChatRunFailureOwnProps | "children"
> &
  ChatRunFailureOwnProps;

export function ChatRunFailure({
  error,
  onRetry,
  onOpenProviderSettings,
  modelControl,
  className,
  ...rest
}: ChatRunFailureProps) {
  const [retrying, setRetrying] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const retryInFlight = useRef(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const summary = describeFailure(error);
  const retry = async () => {
    if (!onRetry || retryInFlight.current) return;
    retryInFlight.current = true;
    setRetrying(true);
    setRetryError(null);
    try {
      await onRetry();
    } catch (reason) {
      setRetryError(reason instanceof Error ? reason.message : "Retry could not start.");
    } finally {
      retryInFlight.current = false;
      setRetrying(false);
    }
  };

  return (
    <div className={cn("flex flex-col gap-2", className)} {...rest}>
      <Banner status="error" title={summary.title} description={summary.description} />
      <div className="flex flex-wrap gap-2">
        {onOpenProviderSettings ? (
          <Button size="sm" variant="secondary" onClick={onOpenProviderSettings}>Provider settings</Button>
        ) : null}
        {modelControl}
        {onRetry ? (
          <Button size="sm" variant="secondary" disabled={retrying} onClick={() => void retry()}>Retry request</Button>
        ) : null}
      </div>
      {retryError ? (
        <span className="text-sm/5" role="alert" style={{ color: "var(--destructive)" }}>{retryError}</span>
      ) : null}
      <Collapsible
        trigger={<span className="text-xs leading-[1.4286] font-normal text-muted-foreground">Error details</span>}
        isOpen={detailsOpen}
        onOpenChange={setDetailsOpen}
      >
        {detailsOpen ? (
          <div className="text-xs leading-[1.4286]" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
            {error}
          </div>
        ) : null}
      </Collapsible>
    </div>
  );
}
