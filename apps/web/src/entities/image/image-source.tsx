// Image refs resolve through the connected host. The provider keeps the
// loader and a retry key that changes on reconnect; hooks retry then, and on
// remount, but never cache a failure as "this image is gone".
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
import type { MessageImage, ViewImage } from "@pinomad/protocol/images.ts";
import type { ConnectionState } from "@pinomad/protocol/view.ts";
import { imageCache, type ImageLoader } from "./image-cache.ts";
import { imageSrc } from "./image-url.ts";

type ImageSource = {
  readonly load: ImageLoader;
  readonly retryKey: number;
};

const ImageSourceContext = createContext<ImageSource | undefined>(undefined);

export function ImageSourceProvider({
  load,
  connection,
  children,
}: {
  load: ImageLoader;
  /** When given, every reconnection to the host bumps the hooks' retry key. */
  connection?: ConnectionState;
  children: ReactNode;
}) {
  const [retryKey, setRetryKey] = useState(0);
  const previous = useRef(connection);
  useEffect(() => {
    if (connection === "connected" && previous.current !== undefined && previous.current !== "connected") {
      setRetryKey((key) => key + 1);
    }
    previous.current = connection;
  }, [connection]);
  const value = useMemo(() => ({ load, retryKey }), [load, retryKey]);
  return <ImageSourceContext.Provider value={value}>{children}</ImageSourceContext.Provider>;
}

export type ImageSrc =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly src: string }
  | { readonly status: "error" };

type Loaded =
  | { readonly ref: string; readonly image: MessageImage }
  | { readonly ref: string; readonly failed: true };

/**
 * The data URL for one image. Inline bytes render immediately; a ref loads
 * only once `visible` says it is near the viewport (or the caller otherwise
 * wants it now).
 */
export function useImageSrc(image: ViewImage | undefined, visible: boolean): ImageSrc {
  const source = useContext(ImageSourceContext);
  const ref = image !== undefined && "ref" in image ? image.ref : undefined;
  const [loaded, setLoaded] = useState<Loaded | undefined>(undefined);
  const retryKey = source?.retryKey ?? 0;
  const load = source?.load;

  useEffect(() => {
    if (ref === undefined) return;
    const cached = imageCache.get(ref);
    if (cached !== undefined) {
      setLoaded({ ref, image: cached });
      return;
    }
    if (!visible || load === undefined) return;
    let cancelled = false;
    // A fresh request replaces a previous failure for this same ref.
    setLoaded(undefined);
    imageCache.load(ref, load).then(
      (bytes) => {
        if (!cancelled) setLoaded({ ref, image: bytes });
      },
      () => {
        if (!cancelled) setLoaded({ ref, failed: true });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [ref, visible, retryKey, load]);

  if (image === undefined) return { status: "loading" };
  if ("data" in image) return { status: "ready", src: imageSrc(image) };
  const current = loaded?.ref === ref ? loaded : undefined;
  if (current !== undefined) {
    return "image" in current
      ? { status: "ready", src: imageSrc(current.image) }
      : { status: "error" };
  }
  if (ref === undefined) return { status: "loading" };
  const cached = imageCache.peek(ref);
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
export function cachedImageSrc(image: ViewImage): string | undefined {
  if ("data" in image) return imageSrc(image);
  const cached = imageCache.peek(image.ref);
  return cached === undefined ? undefined : imageSrc(cached);
}
