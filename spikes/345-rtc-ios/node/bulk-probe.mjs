import ndc from "node-datachannel";
const bindAddress = process.env.RTC_SPIKE_BIND ?? "0.0.0.0";
const p1 = new ndc.PeerConnection("p1", { iceServers: [], maxMessageSize: 262144, bindAddress });
const p2 = new ndc.PeerConnection("p2", { iceServers: [], maxMessageSize: 262144, bindAddress });
let dc2, received = 0, firsts = new Map(), duplicates = 0, done = false;
function wire(a, b) {
  a.onLocalDescription((sdp, type) => b.setRemoteDescription(sdp, type));
  a.onLocalCandidate((candidate, mid) => b.addRemoteCandidate(candidate, mid));
}
wire(p1, p2); wire(p2, p1);
p2.onDataChannel((dc) => {
  dc2 = dc;
  dc.onOpen(() => console.log("receiver open"));
  dc.onMessage((msg) => {
    const b = Buffer.from(msg);
    const key = b.subarray(0, 8).toString("hex") + ":" + b.length;
    received++;
    if (firsts.has(key)) { duplicates++; console.log("DUP", received, key); } else firsts.set(key, 1);
    if (received === 65) { done = true; console.log("RECEIVED", received, "duplicates", duplicates, "unique", firsts.size); p1.close(); p2.close(); ndc.cleanup(); setTimeout(() => process.exit(0), 200); }
  });
});
const dc1 = p1.createDataChannel("bulk");
let sent = 0;
dc1.onOpen(() => {
  console.log("sender open", dc1.maxMessageSize());
  const timer = setInterval(() => {
    if (sent >= 65) { clearInterval(timer); return; }
    const b = Buffer.alloc(65535, 65);
    b.writeUInt32LE(sent, 0);
    const ok = dc1.sendMessageBinary(b);
    if (ok) { sent++; console.log("sent", sent); }
  }, 20);
});
setTimeout(() => { console.log("TIMEOUT", { received, sent, duplicates, unique: firsts.size }); p1.close(); p2.close(); ndc.cleanup(); process.exit(1); }, 20000);
