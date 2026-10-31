// This install's account device id (ADR-0037 §1): 128 random bits, generated
// once and sent with every login and sign-up so the server keeps one account
// device per install across sessions. It lives in the renderer's
// localStorage, which on desktop persists in userData under the app://
// origin. Storage that is blocked or full costs only the reuse: the page
// keeps one id of its own, and the next sign-in from a fresh page shows up
// as another device.
import { toBase64Url } from "@pinomad/protocol/secure-channel.ts";

export const DEVICE_ID_KEY = "pinomad.accountDeviceId";

// What the server accepts; a stored value outside it would 400 every login.
const DEVICE_ID = /^[A-Za-z0-9_-]{22,64}$/;

type DeviceIdStorage = Pick<Storage, "getItem" | "setItem">;

/** `storage` is a getter: merely touching `localStorage` throws where it's blocked. */
export function createDeviceIdSource(storage: () => DeviceIdStorage): () => string {
  let pageId: string | undefined;
  return () => {
    let store: DeviceIdStorage | undefined;
    try {
      store = storage();
      const stored = store.getItem(DEVICE_ID_KEY);
      if (stored !== null && DEVICE_ID.test(stored)) return stored;
    } catch {
      // Unreadable storage: fall through to this page's own id.
    }
    pageId ??= toBase64Url(crypto.getRandomValues(new Uint8Array(16)));
    try {
      store?.setItem(DEVICE_ID_KEY, pageId);
    } catch {
      // Full or read-only: the id still holds for this page.
    }
    return pageId;
  };
}

export const browserDeviceId = createDeviceIdSource(() => localStorage);
