import { useCallback, useEffect, useState } from "react";

const ANIMATION_MS = 220;

/**
 * Manages mount/unmount with enter and exit animations.
 *
 * - `mounted`: whether the modal DOM should be rendered
 * - `closing`: true during the exit animation (apply the closing CSS class)
 * - `requestClose()`: triggers the exit animation, then unmounts after the duration
 */
export function useModalTransition(open: boolean) {
  const [mounted, setMounted] = useState(open);
  const [closing, setClosing] = useState(false);

  useEffect(() => {
    if (open) {
      setMounted(true);
      setClosing(false);
    }
  }, [open]);

  const requestClose = useCallback((onClosed: () => void) => {
    setClosing(true);
    const timer = window.setTimeout(() => {
      setMounted(false);
      setClosing(false);
      onClosed();
    }, ANIMATION_MS);
    return () => window.clearTimeout(timer);
  }, []);

  return { mounted, closing, requestClose };
}
