import { chromium } from "playwright-core";
const args = process.argv.slice(2);
const browser = await chromium.launch({ channel: "chrome", headless: true, args });
const page = await browser.newPage();
await page.goto("data:text/html,<title>candidates</title>");
const result = await page.evaluate(async () => {
  const pc = new RTCPeerConnection({ iceServers: [] });
  pc.createDataChannel("x");
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await new Promise((resolve) => {
    if (pc.iceGatheringState === "complete") return resolve(undefined);
    pc.onicegatheringstatechange = () => { if (pc.iceGatheringState === "complete") resolve(undefined); };
    setTimeout(resolve, 6000);
  });
  return pc.localDescription.sdp.split(/\r?\n/).filter((line) => line.startsWith("a=candidate:")).map((line) => line.split(" ").slice(4, 6).join(" "));
});
console.log(JSON.stringify({ args, candidates: result }));
await browser.close();
