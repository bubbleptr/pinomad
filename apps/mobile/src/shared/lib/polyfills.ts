import { getRandomValues } from "expo-crypto";

// noble's randomSecretKey and remote-durable's call ids need
// crypto.getRandomValues; Hermes has no WebCrypto, so back it with
// expo-crypto's implementation. Everything else the protocol uses is
// expected native (TextEncoder/TextDecoder/URL/URLSearchParams, WebSocket).
if (typeof globalThis.crypto !== "object" || globalThis.crypto === null) {
  Object.defineProperty(globalThis, "crypto", { value: {}, writable: true, configurable: true });
}
if (typeof globalThis.crypto.getRandomValues !== "function") {
  Object.defineProperty(globalThis.crypto, "getRandomValues", { value: getRandomValues, writable: true, configurable: true });
}
