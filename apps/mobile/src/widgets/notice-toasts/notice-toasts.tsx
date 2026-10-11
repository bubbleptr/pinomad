// Host notices → toasts. Command failures (submit, answer, create, switch…)
// resolve silently and only land here, so this is how refused work surfaces.
// Notices present at mount are history; afterwards each new id toasts once.
import { useEffect, useRef } from "react";
import { useToast } from "heroui-native";
import type { Notice } from "@pinomad/protocol/view.ts";

export function NoticeToasts({ notices }: { notices: readonly Notice[] }) {
  const { toast } = useToast();
  const seenRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    const latest = notices[notices.length - 1]?.id;
    if (seenRef.current === undefined) {
      seenRef.current = latest ?? -1;
      return;
    }
    for (const notice of notices) {
      if (notice.id <= seenRef.current) continue;
      toast.show({
        id: `notice-${notice.id}`,
        variant: notice.level === "error" ? "danger" : "default",
        label: notice.message,
      });
    }
    if (latest !== undefined) seenRef.current = latest;
  }, [notices, toast]);
  return null;
}
