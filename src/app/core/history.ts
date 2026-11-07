// Undo / redo: a list of past states and one of undone states either side of the current one.
// Rapid changes (a knob drag, a note dragged across the roll, a take being recorded) group into
// one step: a change within `COALESCE_MS` of the last one replaces the current state instead of
// pushing a new step. Pure and generic, tested in tests/history.test.ts.

/** Changes closer together than this are one undo step. */
export const COALESCE_MS = 600;
/** Oldest steps fall off past this many. */
export const HISTORY_LIMIT = 200;

export interface History<T> {
  past: T[];
  /** The state as it is now. */
  present: T;
  /** Undone states, the next one to redo last. */
  future: T[];
  /** When the present state last changed (ms), for grouping rapid changes. */
  at: number;
  /** The group the last change belonged to (see `record`). */
  group?: string;
}

export const startHistory = <T>(present: T, at = -Infinity): History<T> => ({
  past: [],
  present,
  future: [],
  at,
});

/**
 * Records a new state. Within `COALESCE_MS` of the last change, or in the same `group` as it (a
 * key such as one recording pass), it joins the current step; otherwise the old state becomes an
 * undo step. Either way the redo list is dropped, as in any editor.
 */
export function record<T>(h: History<T>, next: T, now: number, group?: string): History<T> {
  if (next === h.present) return h;
  const join = now - h.at < COALESCE_MS || (group !== undefined && group === h.group);
  // A step joined onto still needs an undo point: the very first change has nothing before it.
  const past = join && h.past.length ? h.past : [...h.past, h.present].slice(-HISTORY_LIMIT);
  return { past, present: next, future: [], at: now, group };
}

/** Replaces the present without making a step (changes that aren't undoable, e.g. arming). */
export const replace = <T>(h: History<T>, present: T): History<T> => ({ ...h, present });

export function undo<T>(h: History<T>): History<T> {
  if (!h.past.length) return h;
  return {
    past: h.past.slice(0, -1),
    present: h.past[h.past.length - 1],
    future: [...h.future, h.present],
    at: -Infinity,
    group: undefined,
  };
}

export function redo<T>(h: History<T>): History<T> {
  if (!h.future.length) return h;
  return {
    past: [...h.past, h.present],
    present: h.future[h.future.length - 1],
    future: h.future.slice(0, -1),
    at: -Infinity,
    group: undefined,
  };
}

export const canUndo = (h: History<unknown>) => h.past.length > 0;
export const canRedo = (h: History<unknown>) => h.future.length > 0;
