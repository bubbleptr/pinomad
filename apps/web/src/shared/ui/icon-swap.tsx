import type { ReactElement, ReactNode } from "react"
import { cn } from "cn"

import { Check, Copy } from "@/shared/ui/icons"

// Both glyphs share one grid cell, so the swap cross-fades in place
// instead of the button's content jumping. The outgoing glyph blurs as
// it fades, which hides the frames where the two overlap.
const layer =
  "col-start-1 row-start-1 flex transition-[opacity,scale,filter] duration-(--duration-fast) ease-(--ease-standard) motion-reduce:transition-none"
const hidden = "scale-75 opacity-0 blur-[2px]"

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
      <span className={cn(layer, swapped && hidden)}>{icon}</span>
      <span className={cn(layer, !swapped && hidden)}>{swappedIcon}</span>
    </span>
  )
}

/** A copy button's icon: Copy, turning into a check once `copied`. */
function CopyIcon({ copied }: { copied: boolean }): ReactElement {
  return <IconSwap swapped={copied} icon={<Copy />} swappedIcon={<Check />} />
}

export { CopyIcon, IconSwap }
