import { Dialog as DialogPrimitive } from "@base-ui/react/dialog"
import { useState } from "react"

import { overlayClassName } from "@/shared/ui/dialog"
import { IconButton } from "@/shared/ui/icon-button"
import { Cancel, ChevronRight } from "@/shared/ui/icons"
import { usePortalContainer } from "@/shared/ui/portal-container"

interface LightboxImage {
  readonly src: string
  readonly alt: string
}

/**
 * Images over a dimmed page, one at a time. A gallery adds previous/next
 * buttons (kept mounted, disabled at the ends, so focus isn't dropped), the
 * arrow keys and a counter; each move is announced. A click on the dimmed
 * area, Escape or the close button closes it.
 */
function Lightbox({
  open,
  onOpenChange,
  images,
  index,
  onIndexChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  images: readonly LightboxImage[]
  index: number
  onIndexChange: (index: number) => void
}) {
  const [announcement, setAnnouncement] = useState("")
  const current = images[Math.min(index, images.length - 1)]
  if (current === undefined) return null
  const gallery = images.length > 1
  const go = (next: number): void => {
    if (next < 0 || next >= images.length) return
    onIndexChange(next)
    setAnnouncement(`${images[next]!.alt}, ${next + 1} of ${images.length}`)
  }
  return (
    <DialogPrimitive.Root open={open} onOpenChange={(next) => onOpenChange(next)}>
      <DialogPrimitive.Portal container={usePortalContainer()}>
        <DialogPrimitive.Backdrop data-slot="lightbox-overlay" className={overlayClassName} />
        <DialogPrimitive.Popup
          data-slot="lightbox"
          aria-label={current.alt}
          className="fixed inset-0 z-50 flex items-center justify-center text-white outline-none"
          onClick={(event) => {
            // The popup fills the viewport: a click on it, not on the image or
            // a control, is a click on the dimmed area.
            if (event.target === event.currentTarget) onOpenChange(false)
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowLeft") {
              event.preventDefault()
              go(index - 1)
            } else if (event.key === "ArrowRight") {
              event.preventDefault()
              go(index + 1)
            }
          }}
        >
          <img src={current.src} alt={current.alt} draggable={false} className="pointer-events-none max-h-full max-w-full object-contain select-none" />
          <DialogPrimitive.Close
            render={
              <IconButton
                className="absolute top-3 right-3 text-white"
                label="Close"
                icon={<Cancel aria-hidden="true" />}
              />
            }
          />
          {gallery ? (
            <>
              <IconButton
                className="absolute top-1/2 left-3 -translate-y-1/2 text-white"
                label="Previous"
                icon={<ChevronRight aria-hidden="true" className="-scale-x-100" />}
                disabled={index === 0}
                onClick={() => go(index - 1)}
              />
              <IconButton
                className="absolute top-1/2 right-3 -translate-y-1/2 text-white"
                label="Next"
                icon={<ChevronRight aria-hidden="true" />}
                disabled={index === images.length - 1}
                onClick={() => go(index + 1)}
              />
              <div className="absolute top-3 left-3 text-sm/5">
                {index + 1} / {images.length}
              </div>
              <span className="sr-only" aria-live="polite">{announcement}</span>
            </>
          ) : null}
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

export { Lightbox, type LightboxImage }
