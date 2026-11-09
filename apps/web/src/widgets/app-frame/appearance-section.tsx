import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl";
import { setAppearance, useAppearance, type Appearance } from "../../entities/appearance/appearance.ts";

/** Light, dark, or whatever the system uses; remembered on this device only. */
export function AppearanceSection() {
  const appearance = useAppearance();
  return (
    <SegmentedControl
      className="self-start"
      label="Theme"
      value={appearance}
      onChange={(next) => setAppearance(next as Appearance)}
    >
      <SegmentedControlItem value="light" label="Light" />
      <SegmentedControlItem value="dark" label="Dark" />
      <SegmentedControlItem value="system" label="System" />
    </SegmentedControl>
  );
}
