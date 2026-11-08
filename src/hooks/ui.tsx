// RHODES · cross-section UI actions (shared modals)
import { createContext, useContext } from "react";

export interface UiActions {
  openMeetingForm: (meetingId?: string) => void;
  openQuickNote: () => void;
  openTaskForm: (meetingId?: string) => void;
}

export const UiContext = createContext<UiActions>({
  openMeetingForm: () => {},
  openQuickNote: () => {},
  openTaskForm: () => {},
});

export const useUi = () => useContext(UiContext);
