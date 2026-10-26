// Browser and Electron-renderer half of the RTC carrier (ADR-0033 §2-3).
// The protocol package owns the non-trickle offer text, Noise, and the record
// pump; this file maps the browser's always-enqueue DataChannel and promise
// based stats onto that platform seam.
import {
  RTC_GATHER_MS,
  RTC_LOW_WATER_BYTES,
  type RtcDataChannel,
  type RtcPeer,
  type RtcPlatform,
  type RtcSendOutcome,
} from "@pinomad/protocol/rtc-carrier.ts";
import { RTC_DATA_CHANNEL_LABEL, sdpCandidates, withRtcCandidates } from "@pinomad/protocol/rtc.ts";

/** Whether this window can offer a Peer at all; renderers share this code. */
export function browserRtcAvailable(): boolean {
  return typeof RTCPeerConnection !== "undefined";
}

interface Listeners {
  readonly open: Array<() => void>;
  readonly message: Array<(record: Uint8Array) => void>;
  readonly closed: Array<(reason?: string) => void>;
  readonly low: Array<() => void>;
}

interface ChannelState {
  locallyClosed: boolean;
  closed: boolean;
  openNotified?: boolean;
  candidateType?: string;
}

/** The selected pair's local candidate type, read from getStats once it settles. */
async function selectedCandidateType(connection: RTCPeerConnection): Promise<string | undefined> {
  try {
    const reports = await connection.getStats();
    const byId = new Map<string, RTCStats>();
    reports.forEach((report) => byId.set(report.id, report));
    let pair: RTCIceCandidatePairStats | undefined;
    reports.forEach((report) => {
      if (report.type !== "transport") return;
      const pairId = (report as RTCTransportStats).selectedCandidatePairId;
      if (pairId === undefined) return;
      const candidate = byId.get(pairId);
      if (candidate?.type === "candidate-pair") pair = candidate as RTCIceCandidatePairStats;
    });
    if (pair === undefined) {
      reports.forEach((report) => {
        if (report.type !== "candidate-pair") return;
        const candidate = report as RTCIceCandidatePairStats;
        const selected = (candidate as RTCIceCandidatePairStats & { selected?: boolean }).selected;
        if (selected === true || (candidate.state === "succeeded" && candidate.nominated === true)) {
          pair = candidate;
        }
      });
    }
    const localId = pair?.localCandidateId;
    const local = localId === undefined ? undefined : byId.get(localId);
    const type = (local as (RTCStats & { candidateType?: string }) | undefined)?.candidateType;
    return typeof type === "string" ? type : undefined;
  } catch {
    // Stats are diagnostics: losing them must not close a working carrier.
    return undefined;
  }
}

function wrapChannel(
  raw: RTCDataChannel,
  connection: RTCPeerConnection,
  listeners: Listeners,
  state: ChannelState,
  notifyClosed: (reason?: string) => void,
  fail: (reason: string) => void,
): RtcDataChannel {
  const notifyOpen = (): void => {
    if (state.closed || state.locallyClosed) return;
    // onOpen is a single registration point for the pump; repeated native
    // events must not start it twice.
    if (state.openNotified === true) return;
    state.openNotified = true;
    for (const listener of listeners.open) listener();
  };
  // The browser send() always queues. A throw (closed channel, oversized
  // message) is a real carrier failure, so it propagates to the shared pump.
  const channel: RtcDataChannel = {
    send(record: Uint8Array): RtcSendOutcome {
      // lib.dom types the view's buffer as ArrayBuffer, not ArrayBufferLike;
      // a record from the Noise layer always owns one.
      raw.send(record as unknown as ArrayBufferView<ArrayBuffer>);
      return "queued";
    },
    get bufferedAmount(): number {
      return raw.bufferedAmount;
    },
    close(): void {
      raw.close();
    },
    onOpen(listener): void {
      listeners.open.push(listener);
    },
    onMessage(listener): void {
      listeners.message.push(listener);
    },
    onClosed(listener): void {
      listeners.closed.push(listener);
    },
    onBufferedAmountLow(listener): void {
      listeners.low.push(listener);
    },
  };
  raw.binaryType = "arraybuffer";
  // The shared pump stops at the same high-water mark; the platform wakes it
  // at the matching low-water mark (ADR-0033 §3).
  raw.bufferedAmountLowThreshold = RTC_LOW_WATER_BYTES;
  raw.onbufferedamountlow = () => {
    for (const listener of listeners.low) listener();
  };
  raw.onmessage = (event: MessageEvent) => {
    if (state.closed || state.locallyClosed) return;
    const data: unknown = event.data;
    const bytes =
      data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : ArrayBuffer.isView(data)
          ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
          : undefined;
    if (bytes === undefined) {
      fail("the DataChannel delivered a non-binary message");
      return;
    }
    for (const listener of listeners.message) listener(bytes);
  };
  raw.onopen = () => {
    // getStats is the only browser API that names the selected pair. Resolve
    // it before telling the pump the channel is open, so the coordinator's
    // one diagnostic read sees the type instead of racing a promise.
    void selectedCandidateType(connection).then((type) => {
      if (type !== undefined) state.candidateType = type;
      notifyOpen();
    });
  };
  raw.onclose = (event: Event) => {
    if (state.locallyClosed || state.closed) return;
    const reason = (event as CloseEvent).reason;
    notifyClosed(reason === "" || reason === undefined ? "the DataChannel closed" : reason);
  };
  raw.onerror = (event: Event) => {
    const message = (event as RTCErrorEvent).error?.message;
    fail(message === undefined || message === "" ? "the DataChannel failed" : message);
  };
  connection.onconnectionstatechange = () => {
    if (connection.connectionState === "failed") fail("the PeerConnection failed");
    else if (connection.connectionState === "closed" && !state.locallyClosed) {
      notifyClosed("the PeerConnection closed");
    }
  };
  connection.oniceconnectionstatechange = () => {
    if (connection.iceConnectionState === "failed") fail("the ICE connection failed");
  };
  return channel;
}

async function offerWithCandidates(connection: RTCPeerConnection): Promise<string> {
  const gathered: string[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let settled = false;
  let resolveOffer!: (sdp: string) => void;
  let rejectOffer!: (error: Error) => void;
  const done = new Promise<string>((resolve, reject) => {
    resolveOffer = resolve;
    rejectOffer = reject;
  });
  const cleanup = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    connection.onicecandidate = null;
    connection.onicegatheringstatechange = null;
  };
  const fail = (reason: string): void => {
    if (settled) return;
    settled = true;
    cleanup();
    rejectOffer(new Error(reason));
  };
  const finish = (): void => {
    if (settled) return;
    const local = connection.localDescription;
    if (local === null) {
      fail("the browser produced no local offer description");
      return;
    }
    // Some browsers put gathered candidates straight into the local SDP and
    // omit the matching event, so the text is the fallback source of truth.
    const candidates = [...new Set([...gathered, ...sdpCandidates(local.sdp)])];
    if (candidates.length === 0) {
      fail("the browser gathered no ICE candidates");
      return;
    }
    settled = true;
    cleanup();
    resolveOffer(withRtcCandidates(local.sdp, candidates));
  };
  connection.onicecandidate = (event: RTCPeerConnectionIceEvent) => {
    if (settled) return;
    if (event.candidate === null) {
      finish();
      return;
    }
    gathered.push(event.candidate.candidate);
  };
  connection.onicegatheringstatechange = () => {
    if (connection.iceGatheringState === "complete") finish();
  };
  // The stage budget owns the ICE deadline; a non-trickle offer needs one
  // bounded collection window of its own (ADR-0033 §3).
  timer = setTimeout(finish, RTC_GATHER_MS);
  try {
    const offer = await connection.createOffer();
    await connection.setLocalDescription(offer);
    if (connection.iceGatheringState === "complete") finish();
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  return done;
}

async function createPeer(connection: RTCPeerConnection): Promise<RtcPeer> {
  const listeners: Listeners = { open: [], message: [], closed: [], low: [] };
  const state: ChannelState = { locallyClosed: false, closed: false };
  const notifyClosed = (reason?: string): void => {
    if (state.closed || state.locallyClosed) return;
    state.closed = true;
    for (const listener of listeners.closed) listener(reason);
  };
  const closeNative = (): void => {
    try {
      raw.close();
    } catch {
      // Already gone.
    }
    try {
      connection.close();
    } catch {
      // Already gone.
    }
  };
  const fail = (reason: string): void => {
    if (state.closed || state.locallyClosed) return;
    notifyClosed(reason);
    closeNative();
  };
  const raw = connection.createDataChannel(RTC_DATA_CHANNEL_LABEL, { ordered: true });
  const channel = wrapChannel(raw, connection, listeners, state, notifyClosed, fail);
  let offerSdp: string;
  try {
    offerSdp = await offerWithCandidates(connection);
  } catch (error) {
    state.locallyClosed = true;
    closeNative();
    throw error;
  }
  return {
    offerSdp,
    acceptAnswer(sdp: string): void {
      if (state.locallyClosed) return;
      void connection.setRemoteDescription({ type: "answer", sdp }).catch((error: unknown) => {
        fail(error instanceof Error ? error.message : String(error));
      });
    },
    channel,
    selectedCandidateType: () => state.candidateType,
    close(): void {
      if (state.locallyClosed) return;
      state.locallyClosed = true;
      closeNative();
    },
  };
}

/** The browser platform, or undefined where the renderer has no WebRTC. */
export function createBrowserRtcPlatform(): RtcPlatform | undefined {
  if (!browserRtcAvailable()) return undefined;
  return {
    createPeer(stun) {
      const connection = new RTCPeerConnection({ iceServers: stun.map((url) => ({ urls: url })) });
      return createPeer(connection);
    },
  };
}
