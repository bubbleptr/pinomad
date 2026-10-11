import { useEffect, useState } from "react";
import { Keyboard } from "react-native";

/**
 * Whether the software keyboard is up. Screens drop their bottom safe-area
 * padding while it is so the composer doesn't sit an inset above the keys.
 */
export function useKeyboardVisible(): boolean {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const show = Keyboard.addListener("keyboardDidShow", () => setVisible(true));
    const hide = Keyboard.addListener("keyboardDidHide", () => setVisible(false));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  return visible;
}
