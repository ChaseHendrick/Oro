// Bounce reminders (2.12). A small toast suggests a bounce, never a modal,
// at most once per 15 minutes: when dropouts happen while the transport plays
// (a bounce renders offline and cannot glitch), and after 20 minutes of
// playing with changes since the last bounce. The desktop app also asks
// gently when its window closes with unbounced changes. The browser adds no
// leave-page prompt for this. Settings > Audio > Remind me to bounce (per
// computer, on by default) turns all of it off.

export const BOUNCE_REMINDER_KEY = 'orograph.bounceReminder';
export const REMIND_GAP_MS = 15 * 60 * 1000;
export const REMIND_PLAY_MS = 20 * 60 * 1000;
export const REMIND_TICK_MS = 30 * 1000;

export function bounceReminderEnabled(storage = globalThis.localStorage) {
  try { return storage?.getItem(BOUNCE_REMINDER_KEY) !== '0'; } catch { return true; }
}
export function setBounceReminderEnabled(on, storage = globalThis.localStorage) {
  try { storage?.setItem(BOUNCE_REMINDER_KEY, on ? '1' : '0'); } catch { /* blocked: stays on for this session */ }
}

export const REMINDER_TEXT = Object.freeze({
  dropouts: { message: 'Hearing glitches? Try a bounce.', detail: "A bounce renders offline and can't glitch." },
  long: { message: 'Bounce what you have?', detail: 'You have been playing for 20 minutes with changes since your last bounce.' },
});

/**
 * The timing core, with an injected clock. notify(reason) shows the toast.
 * tick() runs every REMIND_TICK_MS; dropout() when the audio drops out.
 */
export function createBounceReminder({ now = () => Date.now(), enabled = () => true, notify = () => {} } = {}) {
  let changed = false, lastPrompt = -Infinity, playedMs = 0, playingSince = null;
  const played = () => playedMs + (playingSince != null ? now() - playingSince : 0);
  const resetPlayed = () => { playedMs = 0; if (playingSince != null) playingSince = now(); };
  function prompt(reason) {
    const t = now();
    if (!enabled() || t - lastPrompt < REMIND_GAP_MS) return false;
    lastPrompt = t;
    notify(reason);
    return true;
  }
  return {
    markChanged() { changed = true; },
    markBounced() { changed = false; resetPlayed(); },
    setPlaying(on) {
      const t = now();
      if (on && playingSince == null) playingSince = t;
      else if (!on && playingSince != null) { playedMs += t - playingSince; playingSince = null; }
    },
    tick() { if (changed && played() >= REMIND_PLAY_MS && prompt('long')) resetPlayed(); },
    dropout() { return playingSince != null && prompt('dropouts'); },
    /** The close flow should ask: on, with changes since the last bounce. */
    pendingOnClose() { return enabled() && changed; },
    played,
  };
}

/**
 * Wire the reminder to the app: undo history marks changes, a finished
 * bounce clears them, ui.playing tracks playing time. `desktop` is the
 * preload's session bridge (Electron only). Returns { dropout, refresh, openBounce, dispose }.
 */
export function installBounceReminder(ctx, { openBounce, storage = globalThis.localStorage, desktop = globalThis.orographDesktop?.session, timers = globalThis } = {}) {
  const { store, toast } = ctx;
  const offs = [];
  const reminder = createBounceReminder({
    enabled: () => bounceReminderEnabled(storage),
    notify: (reason) => {
      const text = REMINDER_TEXT[reason];
      toast(text.message, { kind: 'info', timeout: 15000, detail: text.detail, actions: [{ label: 'Bounce now', onClick: openBounce }, { label: 'Not now' }] });
    },
  });
  let sent = null;
  const refresh = () => {
    const pending = reminder.pendingOnClose();
    if (desktop && pending !== sent) { sent = pending; try { desktop.setUnbounced(pending); } catch { /* optional bridge */ } }
  };
  if (ctx.history && typeof ctx.history.on === 'function') offs.push(ctx.history.on(() => { reminder.markChanged(); refresh(); }));
  if (ctx.bus) offs.push(ctx.bus.on('bounce:done', () => { reminder.markBounced(); refresh(); }));
  offs.push(store.subscribe('ui.playing', () => reminder.setPlaying(!!store.get('ui.playing'))));
  reminder.setPlaying(!!store.get('ui.playing'));
  if (desktop && typeof desktop.onOpenBounce === 'function') offs.push(desktop.onOpenBounce(() => openBounce()));
  const timer = timers.setInterval(() => { reminder.tick(); refresh(); }, REMIND_TICK_MS);
  offs.push(() => timers.clearInterval(timer));
  return {
    reminder,
    dropout: () => reminder.dropout(),
    refresh,
    dispose() { for (const off of offs) { try { if (typeof off === 'function') off(); } catch { /* already gone */ } } },
  };
}
