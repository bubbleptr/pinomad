import { useEffect, useState } from "react";

/** False on the first render, true from the commit after it: lets content
 * present at mount skip an entrance that later additions play. */
export function useMounted(): boolean {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return mounted;
}
