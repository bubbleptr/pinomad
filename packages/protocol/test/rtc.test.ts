import { describe, expect, it } from "vitest";
import { encodeClientHello, encodeHostHello, SECURE_PROLOGUE, SIGNAL_PROLOGUE } from "../src/secure-channel.ts";
import { generateKeyPair, initiateIK, respondIK } from "../src/noise.ts";
import {
  isRtcHello,
  parseRtcMaxMessageSize,
  RTC_DEFAULT_MAX_MESSAGE_SIZE,
  RTC_DEFAULT_STUN,
  rtcCandidateType,
  sdpCandidates,
  withRtcCandidates,
} from "../src/rtc.ts";

describe("rtc SDP helpers", () => {
  it("reads the peer's max-message-size, treating absent as the browser default and 0 as unlimited", () => {
    expect(parseRtcMaxMessageSize("v=0\r\n")).toEqual({ kind: "bounded", bytes: RTC_DEFAULT_MAX_MESSAGE_SIZE });
    expect(parseRtcMaxMessageSize("v=0\r\na=max-message-size:0\r\n")).toEqual({ kind: "unlimited" });
    expect(parseRtcMaxMessageSize("v=0\r\na=max-message-size:65536\r\n")).toEqual({
      kind: "bounded",
      bytes: 65536,
    });
    expect(parseRtcMaxMessageSize("v=0\r\na=max-message-size:65534\r\n")).toMatchObject({ kind: "invalid" });
    expect(parseRtcMaxMessageSize("v=0\r\na=max-message-size:-1\r\n")).toMatchObject({ kind: "invalid" });
    expect(parseRtcMaxMessageSize("v=0\r\na=max-message-size:lots\r\n")).toMatchObject({ kind: "invalid" });
  });

  it("filters candidates by type and composes a non-trickle SDP", () => {
    const candidate = (type: string, port: number) =>
      `candidate:1 1 UDP 1 192.0.2.1 ${port} typ ${type} generation 0`;
    expect(rtcCandidateType(candidate("host", 1))).toBe("host");
    expect(rtcCandidateType("not a candidate")).toBeUndefined();
    const sdp = [
      "v=0",
      "m=application 9 UDP/DTLS/SCTP webrtc-datachannel",
      `a=${candidate("host", 1)}`,
      `a=${candidate("relay", 2)}`,
      `a=${candidate("srflx", 3)}`,
      "a=end-of-candidates",
      "",
    ].join("\r\n");
    expect(sdpCandidates(sdp)).toEqual([
      candidate("host", 1),
      candidate("relay", 2),
      candidate("srflx", 3),
    ]);
    const composed = withRtcCandidates(sdp, [candidate("host", 1), candidate("prflx", 4), candidate("host", 1)]);
    expect(composed).toContain(`a=${candidate("host", 1)}\r\n`);
    expect(composed).toContain(`a=${candidate("prflx", 4)}\r\n`);
    expect(composed).not.toContain(candidate("relay", 2));
    expect(composed.split(`a=${candidate("host", 1)}`).length - 1).toBe(1);
    expect(composed.endsWith("a=end-of-candidates\r\n")).toBe(true);
  });

  it("validates hello.rtc without accepting a lookalike", () => {
    expect(isRtcHello({ stun: [...RTC_DEFAULT_STUN], signalOnly: true })).toBe(true);
    expect(isRtcHello({ stun: [], signalOnly: true })).toBe(true);
    expect(isRtcHello({ stun: [...RTC_DEFAULT_STUN] })).toBe(false);
    expect(isRtcHello({ stun: [1], signalOnly: true })).toBe(false);
    expect(isRtcHello({ stun: [""], signalOnly: true })).toBe(false);
    expect(isRtcHello({ stun: [...RTC_DEFAULT_STUN], signalOnly: "true" })).toBe(false);
    expect(isRtcHello(null)).toBe(false);
  });
});

describe("signal prologue", () => {
  it("authenticates only with the signal responder, never with the business one", () => {
    expect(new TextDecoder().decode(SIGNAL_PROLOGUE)).toBe("pinomad-signal/1");
    const hostKey = generateKeyPair();
    const device = generateKeyPair();
    const initiator = initiateIK({ prologue: SIGNAL_PROLOGUE, static: device, remoteStatic: hostKey.publicKey });
    const message1 = initiator.writeMessage1(encodeClientHello({ v: 1 }));

    const business = respondIK({ prologue: SECURE_PROLOGUE, static: hostKey });
    expect(() => business.readMessage1(message1)).toThrow();

    const signal = respondIK({ prologue: SIGNAL_PROLOGUE, static: hostKey });
    const opened = signal.readMessage1(message1);
    expect(Array.from(opened.payload)).toEqual(Array.from(encodeClientHello({ v: 1 })));
    expect(Array.from(opened.remoteStatic)).toEqual(Array.from(device.publicKey));
    expect(signal.writeMessage2(encodeHostHello({ v: 1 })).message.length).toBeGreaterThan(0);
  });
});
