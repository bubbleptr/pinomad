import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/** Joins class names; a later Tailwind class overrides an earlier one for the same property. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
