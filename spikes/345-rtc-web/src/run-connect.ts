import { parseArgs } from "node:util";
import { boolValue, numberValue, roleValue, stunList } from "./cli.ts";
import { runSession, summarize } from "./server/run.ts";

const { values } = parseArgs({
  options: {
    name: { type: "string" },
    host: { type: "string", default: "local" },
    browser: { type: "string", default: "local" },
    stun: { type: "string", default: "none" },
    mdns: { type: "string", default: "on" },
    "bind-address": { type: "string" },
    "timeout-ms": { type: "string" },
  },
});

const host = roleValue(values.host, "host");
const browser = roleValue(values.browser, "browser");
const stun = stunList(values.stun);
const mdns = boolValue(values.mdns, "mdns");
const scenario = browser === "mbp" && host === "local"
  ? "lan"
  : browser === "local" && host === "mbp"
    ? "lan-host-mbp"
    : browser === "mbp" && host === "mbp"
      ? "mbp-local"
      : "loopback";
const name = values.name ?? ["connect", scenario, stun.length > 0 ? "stun" : "host", mdns ? "" : "rawip"].filter(Boolean).join("-");

const result = await runSession({
  name,
  mode: "connect",
  host,
  browser,
  stun,
  mdns,
  ...(values["bind-address"] === undefined ? {} : { bindAddress: values["bind-address"] }),
  ...(values["timeout-ms"] === undefined ? {} : { timeoutMs: numberValue(values["timeout-ms"], 150_000, "timeout-ms") }),
});
console.log(JSON.stringify(summarize(result), null, 2));
