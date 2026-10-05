import { CodingTools } from "@earendil-works/pi-durable/tools";
import type { BuiltinExtension } from "../builtin-extension.ts";

// Durable's read/write/edit/bash bundle; runs directly against the conversation env, no approval gate.
export const coding: BuiltinExtension = { extension: CodingTools };
