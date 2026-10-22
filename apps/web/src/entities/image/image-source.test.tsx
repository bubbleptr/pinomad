import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MessageImage, ViewImage } from "@pinomad/protocol/images.ts";
import { imageCache } from "./image-cache.ts";
import { ImageSourceProvider, useImageSrc } from "./image-source.tsx";

const BYTES: MessageImage = { data: "aGVsbG8=", mimeType: "image/png" };
const REF: ViewImage = { ref: "ref-1", mimeType: "image/png" };

function Probe({ visible }: { visible: boolean }) {
  const state = useImageSrc(REF, visible);
  return <span>{state.status === "ready" ? `ready:${state.src}` : state.status}</span>;
}

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
    await waitFor(() => expect(screen.getByText("ready:data:image/png;base64,aGVsbG8=")).toBeInTheDocument());
    expect(load).toHaveBeenCalledWith("ref-1");
  });

  it("tries a failed ref again when the connection comes back", async () => {
    let attempts = 0;
    const load = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("host offline");
      return BYTES;
    });
    const { rerender } = render(
      <ImageSourceProvider load={load} connection="connected">
        <Probe visible />
      </ImageSourceProvider>,
    );
    await waitFor(() => expect(screen.getByText("error")).toBeInTheDocument());

    rerender(
      <ImageSourceProvider load={load} connection="reconnecting">
        <Probe visible />
      </ImageSourceProvider>,
    );
    rerender(
      <ImageSourceProvider load={load} connection="connected">
        <Probe visible />
      </ImageSourceProvider>,
    );
    await waitFor(() => expect(screen.getByText("ready:data:image/png;base64,aGVsbG8=")).toBeInTheDocument());
    expect(load).toHaveBeenCalledTimes(2);
  });
});
