import { describe, expect, it } from "vitest";
import { ImageRefs } from "../../../apps/host/src/image-refs.ts";
import { imageProblem, imageRef, type MessageImage, outgoingImage } from "../src/images.ts";
import { IMAGE_CASES, png } from "./images-cases.ts";

const CASE = (name: string) => IMAGE_CASES.find((c) => c.name === name)!;

describe("imageProblem", () => {
  it("accepts no images and up to four small ones", () => {
    for (const name of ["empty", "one", "four"]) {
      expect(imageProblem(CASE(name).images), name).toBeUndefined();
    }
  });

  it("rejects a fifth image before checking anything else", () => {
    expect(imageProblem(CASE("five").images)).toBe("At most 4 images per message");
  });

  it("rejects an unsupported mime type", () => {
    expect(imageProblem(CASE("unsupported-first").images)).toBe(
      "Unsupported image type: image/heic (use JPEG, PNG, GIF or WebP)",
    );
    expect(imageProblem(CASE("unsupported-second").images)).toBe(
      "Unsupported image type: image/svg+xml (use JPEG, PNG, GIF or WebP)",
    );
  });

  it("rejects malformed base64, naming the 1-based image", () => {
    expect(imageProblem(CASE("empty-data").images)).toBe("Image 1 is not valid base64");
    // Not a multiple of 4.
    expect(imageProblem(CASE("length-3").images)).toBe("Image 1 is not valid base64");
    // Characters outside the base64 alphabet.
    expect(imageProblem(CASE("bad-chars").images)).toBe("Image 1 is not valid base64");
    expect(imageProblem(CASE("second-invalid").images)).toBe("Image 2 is not valid base64");
    expect(imageProblem(CASE("pad-middle").images)).toBe("Image 1 is not valid base64");
  });

  it("accepts exactly 5 MB decoded and rejects one byte over", () => {
    expect(imageProblem(CASE("exact-5mb").images)).toBeUndefined();
    expect(imageProblem(CASE("over-5mb").images)).toBe("Image 1 is larger than 5 MB");
  });

  it("keeps the shared case table in sync with png()", () => {
    expect(png()).toEqual({ data: "aGVsbG8=", mimeType: "image/png" });
  });
});

describe("outgoingImage", () => {
  it("sends bytes as they are and names only the ref otherwise", () => {
    const bytes: MessageImage = { data: "aGVsbG8=", mimeType: "image/png" };
    expect(outgoingImage(bytes)).toBe(bytes);
    expect(outgoingImage({ ref: "abc123", mimeType: "image/png" })).toEqual({ ref: "abc123" });
  });
});

describe("imageRef", () => {
  it("hashes the type and the bytes exactly like the host", async () => {
    const image: MessageImage = { data: "aGVsbG8=", mimeType: "image/png" };
    const imageRefs = new ImageRefs();
    const rewritten = (await imageRefs.value({
      entries: [
        {
          id: 1,
          kind: "pi.user",
          model: [{ role: "user", content: [{ type: "image", data: image.data, mimeType: image.mimeType }] }],
        },
      ],
      docs: {},
    })) as {
      entries: { model: { content: { type: string; ref?: string }[] }[] }[];
    };
    const hostRef = rewritten.entries[0]!.model[0]!.content[0]!.ref;
    expect(hostRef).toMatch(/^[0-9a-f]{64}$/);
    expect(await imageRef(image)).toBe(hostRef);
  });

  it("binds the mime type as well as the bytes", async () => {
    const asPng = await imageRef({ data: "aGVsbG8=", mimeType: "image/png" });
    const asJpeg = await imageRef({ data: "aGVsbG8=", mimeType: "image/jpeg" });
    expect(asJpeg).not.toBe(asPng);
  });
});
