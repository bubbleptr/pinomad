import { SegmentedControl, SegmentedControlItem } from "../../shared/ui/segmented-control.tsx";
import { SettingsGroup, SettingsRow } from "../../shared/ui/settings-group.tsx";
import { setAppearance, useAppearance, type Appearance } from "../../entities/appearance/appearance.ts";

/** Light, dark, or whatever the system uses; remembered on this device only. */
export function AppearanceSection() {
  const appearance = useAppearance();
  return (
    <SettingsGroup>
      <SettingsRow label="Theme" description="Remembered on this device only">
        <SegmentedControl aria-label="Theme" value={appearance} onValueChange={(next) => setAppearance(next as Appearance)}>
          <SegmentedControlItem value="light">Light</SegmentedControlItem>
          <SegmentedControlItem value="dark">Dark</SegmentedControlItem>
          <SegmentedControlItem value="system">System</SegmentedControlItem>
        </SegmentedControl>
      </SettingsRow>
    </SettingsGroup>
  );
}
