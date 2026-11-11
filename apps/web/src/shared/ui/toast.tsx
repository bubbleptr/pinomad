import { Toast as ToastPrimitive, type UseToastManagerReturnValue } from "@base-ui/react/toast";
import { cn } from "cn";
import { createContext, useContext, useEffect, useMemo, useRef, type ReactElement, type ReactNode } from "react";
import { IconButton } from "@/shared/ui/icon-button";
import { Cancel } from "@/shared/ui/icons";

// Transient notices in a stack at the top right of the window, newest on
// top. `useToast()` shows one and returns its dismiss. An info toast hides
// after 5s (paused while hovered, focused or the window is in the
// background); an error toast and one with `timeout: 0` wait to be dismissed.
// F6 moves focus into the stack.

interface ToastOptions {
  description: ReactNode;
  /** An error is announced assertively, painted red and kept until dismissed. */
  type?: "info" | "error";
  /** Milliseconds before it hides; 0 keeps it. Defaults to 5000, or 0 for an error. */
  timeout?: number;
  /** Showing a toast with the id of one still shown replaces it. */
  id?: string;
  /** Controls before the dismiss button, e.g. a Remove button. */
  action?: ReactNode;
  /** Called once when it closes, by timeout, its button or the returned dismiss. */
  onClose?: () => void;
}

type ShowToast = (options: ToastOptions) => () => void;

interface ToastData {
  action?: ReactNode;
}

type Manager = Pick<UseToastManagerReturnValue<ToastData>, "add" | "close">;

const ToastManagerContext = createContext<Manager | null>(null);

let warned = false;

/** Shows a toast in the nearest `Toaster`. */
function useToast(): ShowToast {
  const manager = useContext(ToastManagerContext);
  return useMemo<ShowToast>(
    () =>
      ({ description, type = "info", timeout, id, action, onClose }) => {
        if (manager === null) {
          if (!warned && import.meta.env.DEV) console.warn("useToast() outside a <Toaster>; the toast was dropped.");
          warned = true;
          return () => {};
        }
        const toastId = manager.add({
          id,
          description,
          type,
          timeout: timeout ?? (type === "error" ? 0 : 5000),
          priority: type === "error" ? "high" : "low",
          onClose,
          data: { action },
        });
        return () => manager.close(toastId);
      },
    [manager],
  );
}

/** Hands the provider's add/close to `useToast` without re-rendering the app on every toast. */
function ManagerBridge({ children }: { children: ReactNode }): ReactElement {
  const { add, close } = ToastPrimitive.useToastManager<ToastData>();
  const manager = useMemo(() => ({ add, close }), [add, close]);
  return <ToastManagerContext value={manager}>{children}</ToastManagerContext>;
}

function ToastItem({ toast }: { toast: ToastPrimitive.Root.ToastObject<ToastData> }): ReactElement {
  const error = toast.type === "error";
  return (
    <ToastPrimitive.Root
      toast={toast}
      swipeDirection={[]}
      data-toast-id={toast.id}
      // A status, not Base UI's dialog: tests and screen readers look for
      // the app's dialogs by role, and a notice sitting beside one isn't one.
      role={error ? "alert" : "status"}
      className={cn(
        "group/toast pointer-events-auto grid grid-rows-[1fr] pb-3 transition-[grid-template-rows,padding] duration-(--duration-fast) ease-(--ease-standard) motion-reduce:duration-[0.01ms]",
        "data-starting-style:grid-rows-[0fr] data-starting-style:pb-0 data-ending-style:grid-rows-[0fr] data-ending-style:pb-0",
        "data-limited:hidden",
      )}
    >
      <div className="overflow-hidden">
        <div
          className={cn(
            "w-[400px] max-w-[min(100%,calc(100vw-32px))] rounded-[calc(var(--radius)+2px)] p-4 text-sm/5",
            "shadow-[0_2px_4px_light-dark(oklch(0_0_0/5%),oklch(0_0_0/35%)),0_4px_12px_light-dark(oklch(0_0_0/10%),oklch(0_0_0/50%)),inset_0_0_0_1px_light-dark(transparent,oklch(1_0_0/12%))]",
            "transition-[opacity,translate] duration-(--duration-fast) ease-(--ease-standard) motion-reduce:duration-[0.01ms]",
            "group-data-starting-style/toast:translate-y-2 group-data-starting-style/toast:opacity-0 group-data-ending-style/toast:-translate-y-2 group-data-ending-style/toast:opacity-0",
            error ? "bg-destructive-inverse text-white" : "bg-inverse text-inverse-foreground",
          )}
        >
          {/* Controls inside take the inverted scheme, so a button reads as it would on that surface. */}
          <div
            className={cn(
              "flex w-full items-start gap-3",
              error ? "[color-scheme:dark]" : "[color-scheme:dark] dark:[color-scheme:light]",
            )}
          >
            <ToastPrimitive.Description className="min-w-0 flex-1" />
            <div className="-my-1 -me-1 flex shrink-0 items-center gap-2">
              {toast.data?.action}
              <ToastPrimitive.Close
                render={<IconButton size="sm" label="Dismiss notification" icon={<Cancel aria-hidden="true" />} />}
              />
            </div>
          </div>
        </div>
      </div>
    </ToastPrimitive.Root>
  );
}

function ToastList(): ReactNode {
  const { toasts } = ToastPrimitive.useToastManager<ToastData>();
  return toasts.map((toast) => <ToastItem key={toast.id} toast={toast} />);
}

/**
 * Hosts the toasts of everything inside it. The stack is a manual popover,
 * so it sits in the top layer over an open Astryx dialog too. Inside another
 * Toaster it adds nothing: one stack per window, so AppFrame keeps its own
 * for stories and tests while the app's root one serves both.
 */
function Toaster({ className, children }: { className?: string; children?: ReactNode }): ReactElement {
  const outer = useContext(ToastManagerContext);
  const viewport = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = viewport.current;
    if (element === null || typeof element.showPopover !== "function") return;
    try {
      element.showPopover();
    } catch {
      // Already showing.
    }
  }, []);
  if (outer !== null) return <>{children}</>;
  return (
    <ToastPrimitive.Provider limit={5}>
      <ManagerBridge>{children}</ManagerBridge>
      <ToastPrimitive.Viewport
        ref={viewport}
        popover="manual"
        className={cn(
          "pointer-events-none fixed inset-auto top-0 right-0 z-500 m-0 flex flex-col items-end overflow-visible border-0 bg-transparent p-4 text-inherit outline-none",
          className,
        )}
      >
        <ToastList />
      </ToastPrimitive.Viewport>
    </ToastPrimitive.Provider>
  );
}

export { Toaster, useToast, type ToastOptions };
