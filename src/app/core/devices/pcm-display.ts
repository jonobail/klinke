// "Which parameter is being edited?" for the PCM-70 / PCM-80 displays. On the hardware the display
// shows the program, then the parameter the soft knob / ADJUST is changing (PCM-70 service manual
// §2.1.1 item 3; PCM-80 service manual p. 1-2, "Display"). A catalog `display(params)` only sees
// the current settings, so this remembers recent settings and reports the one that just moved.

type Params = Record<string, number>;

/**
 * Returns a function mapping settings to the id of the control that changed last. Recent settings
 * are kept (several units of the same model may be on the floor); a new set of settings is matched
 * to the closest earlier one, and the control that differs is the one in focus.
 */
export function focusTracker(fallback: string, ignore: string[] = ['bypass'], keep = 16) {
  const recent: { p: Params; focus: string }[] = [];
  const seen = new WeakMap<object, string>();
  return (p: Params): string => {
    const known = seen.get(p);
    if (known) return known;
    let best = -1;
    let bestDiff: string[] = [];
    recent.forEach((r, i) => {
      const diff = Object.keys(p).filter((k) => !ignore.includes(k) && r.p[k] !== p[k]);
      const all = Object.keys(p).filter((k) => r.p[k] !== p[k]);
      if (all.length > 2) return;
      if (best < 0 || diff.length < bestDiff.length) {
        best = i;
        bestDiff = diff;
      }
    });
    const focus = best < 0 ? fallback : bestDiff.length ? bestDiff[0] : recent[best].focus;
    if (best >= 0) recent.splice(best, 1);
    recent.push({ p: { ...p }, focus });
    if (recent.length > keep) recent.shift();
    seen.set(p, focus);
    return focus;
  };
}
