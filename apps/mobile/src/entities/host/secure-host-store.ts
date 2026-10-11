import * as SecureStore from "expo-secure-store";
import { createHostStore, type HostStore, type KeyValueStorage } from "./host-store.ts";

// The device key must never leave this device — THIS_DEVICE_ONLY keeps the
// item out of iCloud Keychain sync and backups.
const secureStorage: KeyValueStorage = {
  getItemAsync: (key) => SecureStore.getItemAsync(key),
  setItemAsync: (key, value) =>
    SecureStore.setItemAsync(key, value, {
      keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
    }),
  deleteItemAsync: (key) => SecureStore.deleteItemAsync(key),
};

/** The host store backed by the iOS Keychain (expo-secure-store). */
export const hostStore: HostStore = createHostStore(secureStorage);
