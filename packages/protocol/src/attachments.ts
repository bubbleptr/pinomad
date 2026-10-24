// Host-stored file attachments (protocol 5.19, issue #321): a client uploads
// a file in chunks through two unbound calls, then references its host-generated
// id from submit/createConversation. This module is shared by the host, the
// browser clients and tests — no Buffer, no Node-only APIs.

/** Decoded bytes of one attachment; the base64 wire form is larger. */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
/** Attachments one message may reference. */
export const MAX_ATTACHMENTS_PER_MESSAGE = 10;
/** Decoded bytes per appendAttachment call. */
export const ATTACHMENT_CHUNK_BYTES = 512 * 1024;
/** Host-wide budget: attachments in uploading/complete state (not yet used). */
export const MAX_PENDING_ATTACHMENTS = 20;
export const MAX_PENDING_ATTACHMENT_BYTES = 200 * 1024 * 1024;
/** Unused uploads expire 24 hours after beginAttachment. */
export const ATTACHMENT_TTL_MS = 24 * 60 * 60 * 1000;
/** Original display names are only truncated, never rewritten. */
export const MAX_ATTACHMENT_NAME_LENGTH = 255;

/** A host-generated id: 128 random bits as unpadded base64url. */
export const ATTACHMENT_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;
export function isAttachmentId(value: string): boolean {
  return ATTACHMENT_ID_PATTERN.test(value);
}

export type AttachmentState = "uploading" | "complete" | "used";

/** The persisted `meta.json` of one attachment directory (format v1). */
export interface AttachmentMeta {
  readonly v: 1;
  /** The original display name, truncated to MAX_ATTACHMENT_NAME_LENGTH. */
  readonly name: string;
  /** The sanitized basename stored beside meta.json. */
  readonly fileName: string;
  /** Decoded bytes the upload promised. */
  readonly size: number;
  readonly state: AttachmentState;
  readonly createdAt: number;
  readonly expiresAt: number;
}

/** What the model sees about one referenced attachment. */
export interface AttachmentFile {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly size: number;
}

/** The parsed identity of an attachment block; path is display-irrelevant. */
export interface UserAttachment {
  readonly id: string;
  readonly name: string;
  readonly size: number;
}

export const ATTACHMENTS_OPEN = '<attachments v="1">';
export const ATTACHMENTS_INSTRUCTION =
  "The user attached these files. They are read-only originals on this machine: read them with your tools when relevant, and copy one into the working directory before changing it.";
export const ATTACHMENTS_CLOSE = "</attachments>";

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** Decoded length of a strict, padded base64 string, or undefined when invalid. */
export function base64DecodedLength(data: string): number | undefined {
  if (data.length % 4 !== 0 || !BASE64.test(data)) return undefined;
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return (data.length * 3) / 4 - padding;
}

/** Why a beginAttachment size/name can't be admitted, or undefined. */
export function attachmentBeginProblem(name: string, size: number): string | undefined {
  if (name.trim() === "") return "Attachment name cannot be empty";
  if (!Number.isSafeInteger(size) || size < 0) return "Attachment size must be a non-negative integer";
  if (size > MAX_ATTACHMENT_BYTES) return `Attachment is larger than ${MAX_ATTACHMENT_BYTES / (1024 * 1024)} MB`;
  return undefined;
}

/** Why one appendAttachment chunk can't be admitted, or undefined. */
export function attachmentChunkProblem(data: string): string | undefined {
  const size = base64DecodedLength(data);
  if (size === undefined) return "Attachment chunk is not valid base64";
  if (size > ATTACHMENT_CHUNK_BYTES) return `Attachment chunk is larger than ${ATTACHMENT_CHUNK_BYTES / 1024} KiB`;
  return undefined;
}

/**
 * One XML attribute value: the four structural characters plus control
 * characters, which XML forbids literally even in attributes.
 */
export function xmlAttribute(value: string): string {
  let out = "";
  for (let i = 0; i < value.length; i++) {
    const unit = value.charCodeAt(i);
    if (unit === 0x26) out += "&amp;";
    else if (unit === 0x3c) out += "&lt;";
    else if (unit === 0x3e) out += "&gt;";
    else if (unit === 0x22) out += "&quot;";
    else if (unit < 0x20 || unit === 0x7f) out += `&#x${unit.toString(16)};`;
    else out += value[i];
  }
  return out;
}

/** The exact v1 block the model reads; one text block, before the images. */
export function attachmentBlock(files: readonly AttachmentFile[]): string {
  const lines = [
    ATTACHMENTS_OPEN,
    ATTACHMENTS_INSTRUCTION,
    ...files.map(
      (file) =>
        `<file id="${xmlAttribute(file.id)}" name="${xmlAttribute(file.name)}" path="${xmlAttribute(file.path)}" size="${file.size}"/>`,
    ),
    ATTACHMENTS_CLOSE,
  ];
  return lines.join("\n");
}

const FILE_OPEN = '<file id="';
const FILE_NAME = '" name="';
const FILE_PATH = '" path="';
const FILE_SIZE = '" size="';
const FILE_END = '"/>';
const SIZE = /^(?:0|[1-9][0-9]*)$/;

/** Decode the entities xmlAttribute writes, leaving anything else literal. */
function decodeXmlAttribute(value: string): string {
  return value.replace(/&(amp|lt|gt|quot|apos|#x[0-9A-Fa-f]+|#[0-9]+);/g, (entity, body: string) => {
    if (body === "amp") return "&";
    if (body === "lt") return "<";
    if (body === "gt") return ">";
    if (body === "quot") return '"';
    if (body === "apos") return "'";
    const code = body.startsWith("#x") ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
    return code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
  });
}

/** The value up to the next literal quote, given it starts at `at`. */
function quoted(text: string, at: number, marker: string): { value: string; next: number } | undefined {
  if (!text.startsWith(marker, at)) return undefined;
  const start = at + marker.length;
  const end = text.indexOf('"', start);
  if (end === -1) return undefined;
  return { value: text.slice(start, end), next: end };
}

function parseFileLine(line: string): UserAttachment | undefined {
  const id = quoted(line, 0, FILE_OPEN);
  if (id === undefined) return undefined;
  const name = quoted(line, id.next, FILE_NAME);
  if (name === undefined) return undefined;
  const path = quoted(line, name.next, FILE_PATH);
  if (path === undefined) return undefined;
  const size = quoted(line, path.next, FILE_SIZE);
  if (size === undefined || !line.startsWith(FILE_END, size.next) || size.next + FILE_END.length !== line.length) {
    return undefined;
  }
  if (!isAttachmentId(id.value) || !SIZE.test(size.value)) return undefined;
  const bytes = Number(size.value);
  if (!Number.isSafeInteger(bytes)) return undefined;
  return { id: id.value, name: decodeXmlAttribute(name.value), size: bytes };
}

/**
 * The attachments of an exact v1 block, or undefined when `text` is not one.
 * The block must be the whole text: the host stores it as its own text block,
 * so a user message's typed text never becomes attachments by accident.
 */
export function parseAttachmentBlock(text: string): readonly UserAttachment[] | undefined {
  if (!text.startsWith(ATTACHMENTS_OPEN + "\n") || !text.endsWith("\n" + ATTACHMENTS_CLOSE)) return undefined;
  const lines = text.slice(ATTACHMENTS_OPEN.length + 1, -(ATTACHMENTS_CLOSE.length + 1)).split("\n");
  if (lines[0] !== ATTACHMENTS_INSTRUCTION || lines.length < 2) return undefined;
  const files: UserAttachment[] = [];
  for (const line of lines.slice(1)) {
    const file = parseFileLine(line);
    if (file === undefined) return undefined;
    files.push(file);
  }
  return files;
}
