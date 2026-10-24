// Image refs resolve through the connected host. The provider keeps the
// loader and a retry key that changes when a reconnection's conversation
// snapshots land; hooks retry then, and on remount, but never cache a failure
// as "this image is gone".
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefCallback,
} from "react";
import type { ImageVariant, MessageImage, ViewImage } from "@pinomad/protocol/images.ts";
import type { DurableView } from "@pinomad/protocol/view.ts";
import { imageCache, type ImageLoader } from "./image-cache.ts";
import { imageSrc } from "./image-url.ts";

type ImageSource = {
  readonly load: ImageLoader;
  readonly retryKey: number;
};

const ImageSourceContext = createContext<ImageSource | undefined>(undefined);

export function ImageSourceProvider({
  load,
  retryKey = 0,
  children,
}: {
  load: ImageLoader;
  /** Bumped by `useImageRetryKey` once a reconnection's snapshots are usable. */
  retryKey?: number;
  children: ReactNode;
}) {
  const value = useMemo(() => ({ load, retryKey }), [load, retryKey]);
  return <ImageSourceContext.Provider value={value}>{children}</ImageSourceContext.Provider>;
}

/**
 * Retry ref loads when a reconnection's conversation snapshots arrive, not
 * when hello flips `connection` to connected. The host sets a subscription's
 * view before sending its snapshot, so an image call made after the snapshot
 * can be answered; one made right after hello may still get "Unknown image".
 *
 * Main and side streams arrive independently. Each new snapshot bumps the
 * key, so an image that raced its own stream is retried again when that
 * stream lands.
 */
export function useImageRetryKey(view: DurableView): number {
  const [retryKey, setRetryKey] = useState(0);
  const previous = useRef(view.connection);
  // What the last connected render showed. A reconnect compares against it,
  // so a snapshot that arrives in the same render as "connected" still bumps.
  const lastSeen = useRef<{
    main?: DurableView["conversation"];
    side?: DurableView["conversation"];
  } | undefined>(undefined);
  const waiting = useRef<{
    main?: DurableView["conversation"];
    side?: DurableView["conversation"];
  } | undefined>(undefined);

  useEffect(() => {
    if (view.connection === "connected" && previous.current !== "connected") {
      const seen = lastSeen.current;
      if (seen !== undefined && (seen.main !== undefined || seen.side !== undefined)) {
        waiting.current = { ...seen };
      } else {
        // Nothing was rendered before the reconnect; a shown conversation
        // mounts its hooks fresh, so there is nothing to retry yet.
        waiting.current = undefined;
      }
    }
    if (view.connection !== "connected") waiting.current = undefined;
    previous.current = view.connection;
  }, [view.connection]);

  useEffect(() => {
    if (view.connection !== "connected") return;
    const pending = waiting.current;
    if (pending !== undefined) {
      let arrived = false;
      if (pending.main !== undefined && view.conversation !== pending.main) {
        pending.main = undefined;
        arrived = true;
      }
      if (pending.side !== undefined && view.side?.conversation !== pending.side) {
        pending.side = undefined;
        arrived = true;
      }
      if (!arrived) return;
      if (pending.main === undefined && pending.side === undefined) waiting.current = undefined;
      setRetryKey((key) => key + 1);
    }
    if (waiting.current === undefined) {
      lastSeen.current = {
        ...(view.conversation === undefined ? {} : { main: view.conversation }),
        ...(view.side?.conversation === undefined ? {} : { side: view.side.conversation }),
      };
    }
  }, [view.connection, view.conversation, view.side?.conversation]);

  return retryKey;
}

export type ImageSrc =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly src: string }
  | { readonly status: "error" };

type Loaded =
  | { readonly key: string; readonly image: MessageImage }
  | { readonly key: string; readonly failed: true };

/**
 * The data URL for one image. Inline bytes render immediately; a ref loads
 * only once `visible` says it is near the viewport (or the caller otherwise
 * wants it now).
 */
export function useImageSrc(
  image: ViewImage | undefined,
  visible: boolean,
  variant: ImageVariant = "original",
  attempt = 0,
): ImageSrc {
  const source = useContext(ImageSourceContext);
  const ref = image !== undefined && "ref" in image ? image.ref : undefined;
  const requestKey = ref === undefined ? undefined : `${variant}:${ref}`;
  const [loaded, setLoaded] = useState<Loaded | undefined>(undefined);
  const retryKey = source?.retryKey ?? 0;
  const load = source?.load;

  useEffect(() => {
    if (ref === undefined || requestKey === undefined) return;
    const cached = imageCache.get(ref, variant);
    if (cached !== undefined) {
      setLoaded({ key: requestKey, image: cached });
      return;
    }
    if (!visible || load === undefined) return;
    let cancelled = false;
    // A fresh request replaces a previous failure for this same ref.
    setLoaded(undefined);
    const requested = variant === "original"
      ? imageCache.load(ref, load)
      : imageCache.load(ref, load, variant).catch(() => imageCache.load(ref, load));
    requested.then(
      (bytes) => {
        if (!cancelled) setLoaded({ key: requestKey, image: bytes });
      },
      () => {
        if (!cancelled) setLoaded({ key: requestKey, failed: true });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [ref, requestKey, visible, retryKey, load, variant, attempt]);

  if (image === undefined) return { status: "loading" };
  if ("data" in image) return { status: "ready", src: imageSrc(image) };
  const current = loaded?.key === requestKey ? loaded : undefined;
  if (current !== undefined) {
    return "image" in current
      ? { status: "ready", src: imageSrc(current.image) }
      : { status: "error" };
  }
  if (ref === undefined) return { status: "loading" };
  const cached = imageCache.peek(ref, variant);
  if (cached !== undefined) return { status: "ready", src: imageSrc(cached) };
  return { status: "loading" };
}

/**
 * Observe an element and report when it is at most one viewport away. Once
 * near, it stays near: scrolling away must not drop already-loaded bytes.
 */
export function useNearViewport<T extends Element>(): [RefCallback<T>, boolean] {
  const [element, setElement] = useState<T | null>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (element === null) return;
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        setVisible(true);
        observer.disconnect();
      },
      { rootMargin: "100% 0px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return [setElement, visible];
}

/** A ref's bytes if they are already in memory; never starts a fetch. */
export function cachedImageSrc(image: ViewImage, variant: ImageVariant = "original"): string | undefined {
  if ("data" in image) return imageSrc(image);
  const cached = imageCache.peek(image.ref, variant);
  return cached === undefined ? undefined : imageSrc(cached);
}
