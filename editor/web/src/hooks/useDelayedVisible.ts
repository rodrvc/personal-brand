import { useEffect, useRef, useState } from "react";

export interface DelayedVisibleOptions {
  /** How long `active` must stay true before the loader shows, for a passive load — avoids a flash on a request that resolves in a few ms. Ignored when `immediate` is true. */
  delayMs?: number;
  /** Once shown, the minimum time it stays visible — avoids a flash on the other end (shows, then vanishes a frame later because the request happened to finish right after the delay). */
  minShowMs?: number;
  /** An explicit user action (e.g. clicking "Nuevo carrusel") wants feedback right away, not after `delayMs` — show as soon as `active` flips true, `minShowMs` still applies on the way out. */
  immediate?: boolean;
}

const DEFAULT_DELAY_MS = 300;
const DEFAULT_MIN_SHOW_MS = 500;

/**
 * Anti-flicker gate for a loading indicator: `active` is the real
 * loading state (a fetch in flight); the returned boolean is *when to
 * actually show* a loader for it.
 *
 * - Passive load (`immediate` false/omitted): shown only once `active`
 *   has been true for `delayMs` — a load that resolves faster than that
 *   never shows anything.
 * - Once shown, stays shown for at least `minShowMs` even if `active`
 *   flips false sooner — never a one-frame flash.
 * - `immediate: true` skips the entry delay (shows on the next paint)
 *   but keeps the minimum-show floor on the way out.
 */
export function useDelayedVisible(active: boolean, options: DelayedVisibleOptions = {}): boolean {
  const { delayMs = DEFAULT_DELAY_MS, minShowMs = DEFAULT_MIN_SHOW_MS, immediate = false } = options;
  const [visible, setVisible] = useState(false);
  const shownAtRef = useRef<number | null>(null);

  useEffect(() => {
    let showTimer: ReturnType<typeof setTimeout> | undefined;
    let hideTimer: ReturnType<typeof setTimeout> | undefined;

    if (active) {
      const enterDelay = immediate ? 0 : delayMs;
      showTimer = setTimeout(() => {
        shownAtRef.current = Date.now();
        setVisible(true);
      }, enterDelay);
    } else if (shownAtRef.current !== null) {
      const elapsed = Date.now() - shownAtRef.current;
      const remaining = Math.max(0, minShowMs - elapsed);
      hideTimer = setTimeout(() => {
        shownAtRef.current = null;
        setVisible(false);
      }, remaining);
    } else {
      setVisible(false);
    }

    return () => {
      if (showTimer) clearTimeout(showTimer);
      if (hideTimer) clearTimeout(hideTimer);
    };
  }, [active, delayMs, minShowMs, immediate]);

  return visible;
}
