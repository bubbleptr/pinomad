
import { parseArgs } from "node:util";

export function stunList(value: string): string[] {
  if (value === "none" || value === "") return [];
  if (value === "cloudflare") return ["stun:stun.cloudflare.com:3478"];
  return value.split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0);
}

export function boolValue(value: string, name: string): boolean {
  if (value === "on" || value === "true") return true;
  if (value === "off" || value === "false") return false;
  throw new Error(name + " must be on or off");
}

export function roleValue(value: string, name: string): "local" | "mbp" {
  if (value === "local" || value === "mbp") return value;
  throw new Error(name + " must be local or mbp");
}

export function numberValue(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(name + " must be a positive number");
  return parsed;
}
