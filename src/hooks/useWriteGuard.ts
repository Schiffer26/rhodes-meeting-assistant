// ─────────────────────────────────────────────────────────────
// RHODES · "can this window actually write?" guard for handlers
//
// A handler that shows a success message is making a claim about storage. The
// store can refuse that write — another RHODES window owns editing, the lease
// has not been granted yet, or this browser cannot coordinate windows and the
// stored bytes have moved. Reporting success anyway is a lie the operator only
// discovers later, so every handler that registers or changes a record asks
// this first.
//
// It is deliberately *not* `readOnly`: `readOnly` drives the banner and is only
// true for a window that definitely lost the lease. `canWrite` is also false in
// the few milliseconds before the lease is decided, and while a document
// restored from the back/forward cache is queued again — both are moments in
// which a write would be refused.
// ─────────────────────────────────────────────────────────────
import { useCallback } from "react";
import { useToast } from "@/components/toast";
import { useAppData } from "@/hooks/store";

export function useWriteGuard(): (what: string) => boolean {
  const { canWrite, writeLease } = useAppData();
  const toast = useToast();
  return useCallback(
    (what: string) => {
      if (canWrite) return true;
      toast.error(
        writeLease === "waiting"
          ? `Another RHODES window owns editing access — ${what} was not saved. Nothing here was changed; close that window to edit these records.`
          : `This window has not been granted editing access yet — ${what} was not saved. Nothing here was changed; try again in a moment.`,
      );
      return false;
    },
    [canWrite, toast, writeLease],
  );
}
