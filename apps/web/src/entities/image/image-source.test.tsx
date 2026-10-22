import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MessageImage, ViewImage } from "@pinomad/protocol/images.ts";
import type { DurableView } from "@pinomad/protocol/view.ts";
import { imageCache } from "./image-cache.ts";
import { ImageSourceProvider, useImageRetryKey, useImageSrc } from "./image-source.tsx";

const BYTES: MessageImage = { data: "aGVsbG8=", mimeType: "image/png" };
const REF: ViewImage = { ref: "ref-1", mimeType: "image/png" };
const READY = "ready:data:image/png;base64,aGVsbG8=";

function Probe({ visible }: { visible: boolean }) {
  const state = useImageSrc(REF, visible);
  return <span>{state.status === "ready" ? `ready:${state.src}` : state.status}</span>;
}

const view = (patch: Partial<DurableView>): DurableView => ({ connection: "connected", ...patch }) as DurableView;
const conversation = (id: number) =>
  ({ conversation: { id } }) as NonNullable<DurableView["conversation"]>;
const side = (id: number) =>
  ({ id, conversation: conversation(id), docs: [] }) as unknown as NonNullable<DurableView["side"]>;

function KeyProbe({ view }: { view: DurableView }) {
  return <span data-testid="key">{useImageRetryKey(view)}</span>;
}

const key = (): number => Number(screen.getByTestId("key").textContent);

describe("useImageSrc", () => {
  beforeEach(() => {
    imageCache.clear();
  });

  it("waits for visibility before asking the host for a ref", async () => {
    const load = vi.fn(async () => BYTES);
    const { rerender } = render(
      <ImageSourceProvider load={load}>
        <Probe visible={false} />
      </ImageSourceProvider>,
    );
    await waitFor(() => expect(screen.getByText("loading")).toBeInTheDocument());
    expect(load).not.toHaveBeenCalled();

    rerender(
      <ImageSourceProvider load={load}>
        <Probe visible />
      </ImageSourceProvider>,
    );
    await waitFor(() => expect(screen.getByText(READY)).toBeInTheDocument());
    expect(load).toHaveBeenCalledWith("ref-1");
  });

  it("tries a failed ref again when its retry key changes", async () => {
    let attempts = 0;
    const load = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("host offline");
      return BYTES;
    });
    const { rerender } = render(
      <ImageSourceProvider load={load} retryKey={0}>
        <Probe visible />
      </ImageSourceProvider>,
    );
    await waitFor(() => expect(screen.getByText("error")).toBeInTheDocument());

    rerender(
      <ImageSourceProvider load={load} retryKey={1}>
        <Probe visible />
      </ImageSourceProvider>,
    );
    await waitFor(() => expect(screen.getByText(READY)).toBeInTheDocument());
    expect(load).toHaveBeenCalledTimes(2);
  });
});

describe("useImageRetryKey", () => {
  it("does not bump on hello; it waits for the new conversation snapshot", () => {
    const first = conversation(1);
    const { rerender } = render(<KeyProbe view={view({ conversation: first })} />);
    expect(key()).toBe(0);

    rerender(<KeyProbe view={view({ connection: "reconnecting", conversation: first })} />);
    rerender(<KeyProbe view={view({ connection: "connected", conversation: first })} />);
    expect(key()).toBe(0);

    rerender(<KeyProbe view={view({ conversation: conversation(1) })} />);
    expect(key()).toBe(1);

    // A later ops batch replaces the object too; the reconnect retry already
    // happened, so it must not bump again.
    rerender(<KeyProbe view={view({ conversation: conversation(1) })} />);
    expect(key()).toBe(1);
  });

  it("bumps again when the side's own snapshot lands after the main's", () => {
    const main = conversation(1);
    const firstSide = side(2);
    const { rerender } = render(<KeyProbe view={view({ conversation: main, side: firstSide })} />);

    rerender(<KeyProbe view={view({ connection: "reconnecting", conversation: main, side: firstSide })} />);
    rerender(<KeyProbe view={view({ connection: "connected", conversation: main, side: firstSide })} />);
    expect(key()).toBe(0);

    rerender(<KeyProbe view={view({ conversation: conversation(1), side: firstSide })} />);
    expect(key()).toBe(1);
    rerender(<KeyProbe view={view({ conversation: conversation(1), side: side(2) })} />);
    expect(key()).toBe(2);

    rerender(<KeyProbe view={view({ conversation: conversation(1), side: side(2) })} />);
    expect(key()).toBe(2);
  });
});
