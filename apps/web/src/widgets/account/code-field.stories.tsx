import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { CodeField, type CodeFieldProps } from "./code-field.tsx";

function Controlled(props: CodeFieldProps) {
  const [value, setValue] = useState(props.value);
  return <CodeField {...props} value={value} onValueChange={setValue} />;
}

const meta = {
  title: "Widgets/Account/CodeField",
  component: CodeField,
  render: (args) => <Controlled {...args} />,
  args: { label: "Code", value: "", onValueChange: () => {} },
} satisfies Meta<typeof CodeField>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Empty: Story = {};

export const Partial: Story = { args: { value: "123" } };

export const Invalid: Story = { args: { value: "123456", error: "That code is wrong or has expired." } };
