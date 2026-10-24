import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { RemoteDurable } from "@pinomad/protocol/remote-durable.ts";
import { useFileAttachments } from "./use-file-attachments.ts";

const file = (name: string, bytes: string, type = "text/plain"): File => {
  const data = new TextEncoder().encode(bytes);
  return {
    name,
    type,
    size: data.length,
    slice: (start: number, end: number) => ({
      arrayBuffer: async () => data.slice(start, end).buffer,
    }),
  } as unknown as File;
};

const remoteWith = (controller: {
  beginAttachment: (name: string, size: number) => Promise<string>;
  appendAttachment: (id: string, offset: number, data: string) => Promise<{ received: number; complete: boolean }>;
}) => ({ controller } as unknown as RemoteDurable);

describe("useFileAttachments", () => {
  it("refuses files when the host predates 5.19", () => {
    const { result } = renderHook(() => useFileAttachments(remoteWith({ beginAttachment: vi.fn(), appendAttachment: vi.fn() }), false));
    act(() => result.current.add([file("a.txt", "hello")]));
    expect(result.current.entries).toHaveLength(0);
    expect(result.current.error).toMatch(/5\.19/);
  });

  it("pre-checks size and count before uploading", () => {
    const beginAttachment = vi.fn(async () => "A".repeat(22));
    const { result } = renderHook(() => useFileAttachments(remoteWith({ beginAttachment, appendAttachment: vi.fn() }), true));
    act(() => result.current.add([{ ...file("huge.bin", ""), size: 10 * 1024 * 1024 + 1 } as File]));
    expect(result.current.entries).toHaveLength(0);
    expect(result.current.error).toMatch(/10 MB/);
    expect(beginAttachment).not.toHaveBeenCalled();
  });

  it("tracks progress and exposes finished ids", async () => {
    let finish!: (value: { received: number; complete: boolean }) => void;
    const appendAttachment = vi.fn(
      () =>
        new Promise<{ received: number; complete: boolean }>((resolve) => {
          finish = resolve;
        }),
    );
    const remote = remoteWith({ beginAttachment: async () => "A".repeat(22), appendAttachment });
    const { result } = renderHook(() => useFileAttachments(remote, true));
    act(() => result.current.add([file("a.txt", "hello")]));
    await waitFor(() => expect(result.current.uploading).toBe(true));
    expect(result.current.ids()).toEqual([]);

    const waiting = result.current.waitForUploads();
    await act(async () => finish({ received: 5, complete: true }));
    await waiting;
    expect(result.current.uploading).toBe(false);
    expect(result.current.ids()).toEqual(["A".repeat(22)]);
    expect(result.current.entries[0]).toMatchObject({ status: "done", received: 5 });
  });

  it("retries a failed upload from the same id and offset", async () => {
    const appendAttachment = vi
      .fn()
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce({ received: 5, complete: true });
    const beginAttachment = vi.fn(async () => "B".repeat(22));
    const { result } = renderHook(() => useFileAttachments(remoteWith({ beginAttachment, appendAttachment }), true));
    act(() => result.current.add([file("a.txt", "hello")]));
    await waitFor(() => expect(result.current.entries[0]?.status).toBe("failed"));
    expect(result.current.failed).toBe(true);

    act(() => result.current.retry(result.current.entries[0]!.key));
    await waitFor(() => expect(result.current.entries[0]?.status).toBe("done"));
    expect(beginAttachment).toHaveBeenCalledTimes(1);
    expect(appendAttachment.mock.calls.map((call) => call[1])).toEqual([0, 0]);
  });

  it("starts a fresh upload when the host cleaned the old id", async () => {
    const appendAttachment = vi
      .fn()
      .mockRejectedValueOnce(new Error("Attachment not found or expired; attach it again"))
      .mockResolvedValueOnce({ received: 5, complete: true });
    const beginAttachment = vi
      .fn()
      .mockResolvedValueOnce("A".repeat(22))
      .mockResolvedValueOnce("B".repeat(22));
    const { result } = renderHook(() => useFileAttachments(remoteWith({ beginAttachment, appendAttachment }), true));
    act(() => result.current.add([file("a.txt", "hello")]));
    await waitFor(() => expect(result.current.entries[0]?.status).toBe("failed"));

    act(() => result.current.retry(result.current.entries[0]!.key));
    await waitFor(() => expect(result.current.entries[0]?.status).toBe("done"));
    expect(beginAttachment).toHaveBeenCalledTimes(2);
    expect(result.current.ids()).toEqual(["B".repeat(22)]);
  });

  it("completes a zero-byte file without an append", async () => {
    const appendAttachment = vi.fn();
    const { result } = renderHook(() =>
      useFileAttachments(remoteWith({ beginAttachment: async () => "C".repeat(22), appendAttachment }), true),
    );
    act(() => result.current.add([file("empty.txt", "")]));
    await waitFor(() => expect(result.current.entries[0]?.status).toBe("done"));
    expect(appendAttachment).not.toHaveBeenCalled();
    expect(result.current.ids()).toEqual(["C".repeat(22)]);
  });

  it("stops updating when a chip is removed mid-upload", async () => {
    let finish!: (value: { received: number; complete: boolean }) => void;
    const appendAttachment = vi.fn(
      () =>
        new Promise<{ received: number; complete: boolean }>((resolve) => {
          finish = resolve;
        }),
    );
    const { result } = renderHook(() =>
      useFileAttachments(remoteWith({ beginAttachment: async () => "D".repeat(22), appendAttachment }), true),
    );
    act(() => result.current.add([file("a.txt", "hello")]));
    await waitFor(() => expect(result.current.uploading).toBe(true));
    act(() => result.current.remove(result.current.entries[0]!.key));
    expect(result.current.entries).toHaveLength(0);
    await act(async () => finish({ received: 5, complete: true }));
    expect(result.current.entries).toHaveLength(0);
  });

  it("restores a queued edit's ids without bytes", () => {
    const { result } = renderHook(() => useFileAttachments(remoteWith({ beginAttachment: vi.fn(), appendAttachment: vi.fn() }), true));
    act(() => result.current.restore([{ id: "E".repeat(22), name: "old.log", size: 42 }]));
    expect(result.current.entries[0]).toMatchObject({ status: "done", attachmentId: "E".repeat(22), received: 42 });
    expect(result.current.ids()).toEqual(["E".repeat(22)]);
  });
});
