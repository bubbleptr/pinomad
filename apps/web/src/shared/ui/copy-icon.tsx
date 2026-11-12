import type { ReactElement } from "react"
import { cn } from "cn"

import { Check, Copy } from "@/shared/ui/icons"

// Both glyphs share one grid cell, so the swap cross-fades in place
// instead of the button's content jumping.
const layer =
  "col-start-1 row-start-1 transition-[opacity,scale] duration-(--duration-fast) ease-(--ease-standard) motion-reduce:transition-none"

/** A copy button's icon: Copy, turning into a check once `copied`. */
function CopyIcon({ copied }: { copied: boolean }): ReactElement {
  return (
    <span aria-hidden="true" className="inline-grid">
      <Copy className={cn(layer, copied && "scale-75 opacity-0")} />
      <Check className={cn(layer, !copied && "scale-75 opacity-0")} />
    </span>
  )
}

export { CopyIcon }
