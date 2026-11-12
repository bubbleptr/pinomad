import type { ReactElement, ReactNode } from "react"
import { cn } from "cn"

import { Check, Copy } from "@/shared/ui/icons"

// Both glyphs share one grid cell, so the swap cross-fades in place
// instead of the button's content jumping.
const layer =
  "col-start-1 row-start-1 flex transition-[opacity,scale] duration-(--duration-fast) ease-(--ease-standard) motion-reduce:transition-none"

/** Shows `icon`, or `swappedIcon` once `swapped`; the two cross-fade. */
function IconSwap({
  swapped,
  icon,
  swappedIcon,
}: {
  swapped: boolean
  icon: ReactNode
  swappedIcon: ReactNode
}): ReactElement {
  return (
    <span aria-hidden="true" className="inline-grid">
      <span className={cn(layer, swapped && "scale-75 opacity-0")}>{icon}</span>
      <span className={cn(layer, !swapped && "scale-75 opacity-0")}>{swappedIcon}</span>
    </span>
  )
}

/** A copy button's icon: Copy, turning into a check once `copied`. */
function CopyIcon({ copied }: { copied: boolean }): ReactElement {
  return <IconSwap swapped={copied} icon={<Copy />} swappedIcon={<Check />} />
}

export { CopyIcon, IconSwap }
