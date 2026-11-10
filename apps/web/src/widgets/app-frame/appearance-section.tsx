import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl";
import { SettingsGroup, SettingsRow } from "../../shared/ui/settings-group.tsx";
import { setAppearance, useAppearance, type Appearance } from "../../entities/appearance/appearance.ts";

/** Light, dark, or whatever the system uses; remembered on this device only. */
export function AppearanceSection() {
  const appearance = useAppearance();
  return (
    <SettingsGroup>
      <SettingsRow label="Theme" description="Remembered on this device only">
        <SegmentedControl label="Theme" size="sm" value={appearance} onChange={(next) => setAppearance(next as Appearance)}>
          <SegmentedControlItem value="light" label="Light" />
          <SegmentedControlItem value="dark" label="Dark" />
          <SegmentedControlItem value="system" label="System" />
        </SegmentedControl>
      </SettingsRow>
    </SettingsGroup>
  );
}
