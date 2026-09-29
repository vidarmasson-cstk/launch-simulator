import { create } from 'zustand';

/** Second currently hovered on the timeline charts (null when none); read by the flow diagram. */
interface HoverState {
  second: number | null;
  setSecond: (s: number | null) => void;
}

export const useHoverStore = create<HoverState>((set, get) => ({
  second: null,
  setSecond: (second) => {
    if (get().second !== second) set({ second });
  },
}));
