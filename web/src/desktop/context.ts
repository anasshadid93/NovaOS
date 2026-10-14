import { createContext, useContext } from 'react';

/** Present when a screen renders inside a desktop window rather than full-screen on a phone. */
export interface WindowCtx {
  id: string;
  /** Route the window was opened with: its "home". */
  start: string;
  canGoBack: () => boolean;
  back: () => void;
}

export const WindowContext = createContext<WindowCtx | null>(null);
export const useWindowCtx = () => useContext(WindowContext);
