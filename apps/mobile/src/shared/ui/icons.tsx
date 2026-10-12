// Thin Hugeicons wrapper mirroring apps/web/src/shared/ui/icons.tsx: fixed
// stroke width, currentColor default so the `color` prop drives everything.
import { HugeiconsIcon, type HugeiconsProps, type IconSvgElement } from "@hugeicons/react-native";
import { Add01Icon, ArrowUp02Icon, FlashIcon, Queue02Icon, StopIcon } from "@hugeicons/core-free-icons";

type PinomadIconProps = Omit<HugeiconsProps, "icon" | "altIcon">;

const iconStrokeWidth = 1.5;

function iconComponent(icon: IconSvgElement, defaults?: Partial<HugeiconsProps>) {
  return function PinomadIcon(props: PinomadIconProps) {
    return (
      <HugeiconsIcon color="currentColor" icon={icon} strokeWidth={iconStrokeWidth} {...defaults} {...props} />
    );
  };
}

export const Plus = iconComponent(Add01Icon);
export const ArrowUp = iconComponent(ArrowUp02Icon);
// Steer lands in the running turn immediately; the bolt reads "now".
export const Steer = iconComponent(FlashIcon);
// Follow-up waits behind the running turn; stacked lines read "queued".
export const FollowUp = iconComponent(Queue02Icon);
// A solid rounded square like the iOS stop glyph, not the stroked outline.
export const Stop = iconComponent(StopIcon, { fill: "currentColor" });
