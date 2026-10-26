// Mimics the host's lazy native-RTC load: never imported at CLI startup. On
// failure the host/server/--version keep running and this one-line diagnostic
// is what goes into the host log; the full loader error stays available too.
try {
  const { default: ndc } = await import("node-datachannel");
  console.log("rtc: available (libdatachannel " + ndc.getLibraryVersion() + ")");
} catch (error) {
  const firstLine = error instanceof Error ? error.message.split("\n")[0] : String(error);
  console.error("rtc: unavailable: " + firstLine);
  console.error("rtc: install without --omit=optional, or build node-datachannel locally; host continues without hello.rtc");
}
