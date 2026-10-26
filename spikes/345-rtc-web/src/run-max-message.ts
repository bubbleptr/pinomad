import { parseArgs } from "node:util";
import { roleValue, stunList } from "./cli.ts";
import { runSession, summarize } from "./server/run.ts";

const { values } = parseArgs({
  options: {
    name: { type: "string" },
    variant: { type: "string", default: "missing" },
    host: { type: "string", default: "local" },
    browser: { type: "string", default: "local" },
    stun: { type: "string", default: "none" },
    sizes: { type: "string", default: "65535,65536,65537,131072,262144,262145" },
    "bind-address": { type: "string" },
    "timeout-ms": { type: "string" },
  },
});

const variant = values.variant;
if (variant !== "missing" && variant !== "0" && variant !== "65536" && variant !== "default") {
  throw new Error("variant must be missing, 0, 65536, or default");
}
const host = roleValue(values.host, "host");
const browser = roleValue(values.browser, "browser");
const stun = stunList(values.stun);
const sizes = values.sizes.split(",").map((entry) => Number(entry.trim())).filter((entry) => Number.isFinite(entry) && entry > 0);
if (sizes.length === 0) throw new Error("sizes must contain at least one positive integer");
const name = values.name ?? ["maxmsg", "sdp-" + variant, stun.length > 0 ? "stun" : "host"].join("-");

const result = await runSession({
  name,
  mode: "maxmsg",
  host,
  browser,
  stun,
  mdns: true,
  sdpMaxMessageSize: variant,
  sizes,
  ...(values["bind-address"] === undefined ? {} : { bindAddress: values["bind-address"] }),
  ...(values["timeout-ms"] === undefined ? {} : { timeoutMs: Number(values["timeout-ms"]) || 150_000 }),
});
console.log(JSON.stringify(summarize(result), null, 2));
