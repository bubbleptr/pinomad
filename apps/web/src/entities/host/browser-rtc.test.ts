import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RTC_GATHER_MS, RTC_LOW_WATER_BYTES } from "@pinomad/protocol/rtc-carrier.ts";
import { RTC_DATA_CHANNEL_LABEL } from "@pinomad/protocol/rtc.ts";
import { browserRtcAvailable, createBrowserRtcPlatform } from "./browser-rtc.ts";

const BASE_SDP = "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n";

class FakeDataChannel {
  binaryType = "blob";
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  readyState: RTCDataChannelState = "connecting";
  sent: Uint8Array[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onbufferedamountlow: (() => void) | null = null;

  send(data: ArrayBufferView): void {
    this.sent.push(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  }

  close(): void {
    this.readyState = "closed";
    this.onclose?.({ reason: "closed locally" } as CloseEvent);
  }

  open(): void {
    this.readyState = "open";
    this.onopen?.();
  }

  receive(data: ArrayBuffer): void {
    this.onmessage?.({ data } as MessageEvent);
  }

  low(): void {
    this.onbufferedamountlow?.();
  }
}

type FakeStats = { id: string; type: string } & Record<string, unknown>;

class FakePeerConnection {
  static instances: FakePeerConnection[] = [];
  connectionState: RTCPeerConnectionState = "new";
  iceConnectionState: RTCIceConnectionState = "new";
  iceGatheringState: RTCIceGatheringState = "new";
  localDescription: RTCSessionDescriptionInit | null = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;
  stats: FakeStats[] = [];
  channel = new FakeDataChannel();
  channelLabel: string | undefined;
  channelOptions: RTCDataChannelInit | undefined;
  onicecandidate: ((event: RTCPeerConnectionIceEvent) => void) | null = null;
  onicegatheringstatechange: (() => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;

  configuration: RTCConfiguration;

  constructor(configuration: RTCConfiguration) {
    this.configuration = configuration;
    FakePeerConnection.instances.push(this);
  }

  createDataChannel(label: string, options?: RTCDataChannelInit): FakeDataChannel {
    this.channelLabel = label;
    this.channelOptions = options;
    return this.channel;
  }

  createOffer(): Promise<RTCSessionDescriptionInit> {
    return Promise.resolve({ type: "offer", sdp: BASE_SDP });
  }

  setLocalDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.localDescription = { type: "offer", sdp: description.sdp ?? "" };
    return Promise.resolve();
  }

  setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.remoteDescription = { type: "answer", sdp: description.sdp ?? "" };
    return Promise.resolve();
  }

  getStats(): Promise<Map<string, FakeStats>> {
    return Promise.resolve(new Map(this.stats.map((report) => [report.id, report])));
  }

  close(): void {
    this.connectionState = "closed";
    this.onconnectionstatechange?.();
  }

  emitCandidate(candidate: string): void {
    this.onicecandidate?.({ candidate: { candidate } } as RTCPeerConnectionIceEvent);
  }

  completeGathering(): void {
    this.iceGatheringState = "complete";
    this.onicegatheringstatechange?.();
    this.onicecandidate?.({ candidate: null } as RTCPeerConnectionIceEvent);
  }

  failConnection(): void {
    this.connectionState = "failed";
    this.onconnectionstatechange?.();
  }
}

const flush = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0);
};

async function peerWithoutGathering() {
  const platform = createBrowserRtcPlatform()!;
  const pending = platform.createPeer(["stun:stun.example.com:3478"]);
  await flush();
  const connection = FakePeerConnection.instances.at(-1)!;
  connection.emitCandidate("candidate:1 1 UDP 2122260223 192.0.2.10 41000 typ host");
  connection.completeGathering();
  const peer = await pending;
  return { peer, connection };
}

beforeEach(() => {
  vi.useFakeTimers();
  FakePeerConnection.instances = [];
  vi.stubGlobal("RTCPeerConnection", FakePeerConnection as unknown as typeof RTCPeerConnection);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("browser RTC platform", () => {
  it("returns no platform where the renderer has no RTCPeerConnection", () => {
    vi.unstubAllGlobals();
    expect(browserRtcAvailable()).toBe(false);
    expect(createBrowserRtcPlatform()).toBeUndefined();
  });

  it("offers a reliable ordered binary channel and maps a successful send to queued", async () => {
    const { peer, connection } = await peerWithoutGathering();
    expect(connection.channelLabel).toBe(RTC_DATA_CHANNEL_LABEL);
    expect(connection.channelOptions).toEqual({ ordered: true });
    expect(connection.channel.binaryType).toBe("arraybuffer");
    expect(connection.channel.bufferedAmountLowThreshold).toBe(RTC_LOW_WATER_BYTES);
    expect(peer.offerSdp).toContain("a=candidate:1 1 UDP 2122260223 192.0.2.10 41000 typ host");

    const opened = vi.fn();
    const low = vi.fn();
    peer.channel.onOpen(opened);
    peer.channel.onBufferedAmountLow(low);
    connection.channel.open();
    await flush();
    expect(opened).toHaveBeenCalledTimes(1);

    connection.channel.bufferedAmount = 300_000;
    expect(peer.channel.bufferedAmount).toBe(300_000);
    const record = new Uint8Array([1, 2, 3]);
    expect(peer.channel.send(record)).toBe("queued");
    expect(connection.channel.sent).toEqual([record]);

    connection.channel.low();
    expect(low).toHaveBeenCalledTimes(1);
  });

  it("accepts the host answer", async () => {
    const { peer, connection } = await peerWithoutGathering();
    peer.acceptAnswer("v=0\r\na=max-message-size:65536\r\n");
    await flush();
    expect(connection.remoteDescription).toEqual({ type: "answer", sdp: "v=0\r\na=max-message-size:65536\r\n" });
  });

  it("collects candidates for the default 2s window and submits what it has", async () => {
    const platform = createBrowserRtcPlatform()!;
    const pending = platform.createPeer([]);
    await flush();
    const connection = FakePeerConnection.instances.at(-1)!;
    connection.emitCandidate("candidate:2 1 UDP 1 198.51.100.1 5000 typ srflx");
    await vi.advanceTimersByTimeAsync(RTC_GATHER_MS);
    const peer = await pending;
    expect(peer.offerSdp).toContain("typ srflx");
    expect(peer.offerSdp).toContain("a=end-of-candidates");
  });

  it("fails when no candidate was gathered before the window closes", async () => {
    const platform = createBrowserRtcPlatform()!;
    const pending = platform.createPeer([]);
    const rejected = expect(pending).rejects.toThrow(/gathered no ICE candidates/);
    await flush();
    await vi.advanceTimersByTimeAsync(RTC_GATHER_MS);
    await rejected;
  });

  it("maps a DataChannel close to one close notification", async () => {
    const { peer, connection } = await peerWithoutGathering();
    const closed = vi.fn();
    peer.channel.onClosed(closed);
    connection.channel.close();
    expect(closed).toHaveBeenCalledWith("closed locally");
    // The PeerConnection's later closed state must not report a second time.
    connection.close();
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it("maps a PeerConnection failure to the carrier's close", async () => {
    const { peer, connection } = await peerWithoutGathering();
    const closed = vi.fn();
    peer.channel.onClosed(closed);
    connection.failConnection();
    expect(closed).toHaveBeenCalledWith("the PeerConnection failed");
    expect(connection.connectionState).toBe("closed");
  });

  it("does not report a close the caller asked for", async () => {
    const { peer, connection } = await peerWithoutGathering();
    const closed = vi.fn();
    peer.channel.onClosed(closed);
    peer.close();
    expect(closed).not.toHaveBeenCalled();
    expect(connection.connectionState).toBe("closed");
  });

  it("reports both ends of the selected candidate pair from getStats", async () => {
    const { peer, connection } = await peerWithoutGathering();
    connection.stats = [
      { id: "transport", type: "transport", selectedCandidatePairId: "pair" },
      {
        id: "pair",
        type: "candidate-pair",
        state: "succeeded",
        nominated: true,
        localCandidateId: "local",
        remoteCandidateId: "remote",
      },
      { id: "local", type: "local-candidate", candidateType: "host", address: "9a2b.local" },
      { id: "remote", type: "remote-candidate", candidateType: "srflx", address: "192.168.1.8" },
    ];
    const opened = vi.fn();
    peer.channel.onOpen(opened);
    connection.channel.open();
    await flush();
    expect(peer.selectedPair?.()).toEqual({
      local: { type: "host", address: "9a2b.local" },
      remote: { type: "srflx", address: "192.168.1.8" },
    });
    expect(opened).toHaveBeenCalledTimes(1);
  });

  it("falls back to the old getStats ip field", async () => {
    const { peer, connection } = await peerWithoutGathering();
    connection.stats = [
      { id: "pair", type: "candidate-pair", state: "succeeded", nominated: true, localCandidateId: "local" },
      { id: "local", type: "local-candidate", candidateType: "host", ip: "10.0.0.2" },
    ];
    connection.channel.open();
    await flush();
    expect(peer.selectedPair?.()).toEqual({ local: { type: "host", address: "10.0.0.2" }, remote: {} });
  });

  it("delivers a binary record as bytes", async () => {
    const { peer, connection } = await peerWithoutGathering();
    const received: Uint8Array[] = [];
    peer.channel.onMessage((record) => received.push(record));
    const source = new Uint8Array([4, 5, 6]);
    connection.channel.receive(source.buffer);
    expect(received).toHaveLength(1);
    expect([...received[0]!]).toEqual([4, 5, 6]);
  });
});
