import { Button } from "@astryxdesign/core/Button";
import { IconButton } from "@astryxdesign/core/IconButton";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { List, ListItem } from "@astryxdesign/core/List";
import { Text } from "@astryxdesign/core/Text";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { ArrowLeft, MoreHorizontal } from "./icons.tsx";

// The four tiers from apps/web/DESIGN.md, each in the place it belongs.
const meta = {
  title: "Shared/ButtonTiers",
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const InContext: Story = {
  render: () => (
    <VStack gap={6}>
      <VStack gap={2}>
        <Text weight="semibold">Dialog footer: primary + secondary</Text>
        <HStack gap={2} hAlign="end">
          <Button label="Cancel" variant="secondary" />
          <Button label="Save" variant="primary" />
        </HStack>
      </VStack>
      <VStack gap={2}>
        <Text weight="semibold">Settings rows: secondary, sm</Text>
        <List>
          <ListItem
            label="MacBook Pro"
            description="Paired Oct 12"
            endContent={
              <HStack gap={2}>
                <Button label="Connection…" variant="secondary" size="sm" />
                <Button label="Unpair…" variant="secondary" size="sm" />
              </HStack>
            }
          />
        </List>
      </VStack>
      <VStack gap={2}>
        <Text weight="semibold">Confirming an irreversible action: destructive + secondary</Text>
        <HStack gap={2}>
          <Button label="Delete account" variant="destructive" />
          <Button label="Cancel" variant="secondary" />
        </HStack>
      </VStack>
      <VStack gap={2}>
        <Text weight="semibold">Chrome and flow switches: ghost</Text>
        <HStack gap={2} vAlign="center">
          <IconButton label="Back" icon={<ArrowLeft />} variant="ghost" size="sm" />
          <IconButton label="More" icon={<MoreHorizontal />} variant="ghost" size="sm" />
          <Button label="Sign in instead" variant="ghost" />
        </HStack>
      </VStack>
    </VStack>
  ),
};

export const Disabled: Story = {
  render: () => (
    <HStack gap={2}>
      <Button label="Primary" variant="primary" isDisabled />
      <Button label="Secondary" variant="secondary" isDisabled />
      <Button label="Ghost" variant="ghost" isDisabled />
      <Button label="Destructive" variant="destructive" isDisabled />
    </HStack>
  ),
};
