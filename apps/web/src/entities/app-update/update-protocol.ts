/**
 * Wire contract for in-app updates.
 *
 * Main owns the electron-updater client; preload and the renderer share only
 * this serializable status and the push channel, never electron-updater itself.
 * Copied and adapted from Pace at d7fe95c.
 */

export type UpdateState =
  | "disabled"
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "ready"
  | "error";

export type UpdateStatus = {
  state: UpdateState;
  currentVersion: string;
  availableVersion?: string;
  progressPercent?: number;
  reason?: string;
  message?: string;
};

/** Main → renderer push channel carrying the latest UpdateStatus on every change. */
export const updateEventChannel = "pinomad:updates:event";
