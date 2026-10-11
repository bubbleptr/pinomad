/**
 * Ask for permission inside a user gesture — browsers ignore requests outside
 * one, so the ask piggybacks on sending a prompt rather than firing at
 * startup. No-op where the API is missing or the answer is already decided.
 */
export function requestNotificationPermission(): void {
  if (typeof Notification === "undefined" || Notification.permission !== "default") return;
  void Notification.requestPermission();
}
