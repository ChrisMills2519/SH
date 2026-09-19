// narrator.js — pre-recorded ElevenLabs voice pack for the board (shared display).
// Clips live in ../snd/narr/narr_XX.mp3 (mono 44.1kHz 64k, same spec as snd/*.mp3).
// Subtitles mirror the recorded lines; callers never pass free text, only clip ids,
// so audio and captions can't drift apart.
//
// Usage (board.js, host-only paths):
//   import { initNarratorToggle, narrate, narrateOnce, narrateDelayed, cancelNarratorPending } from './narrator.js';
//   initNarratorToggle();            // wires the narrator on/off button
//   narrate('narr_07');              // queue a clip (no-op when narrator off)
//   narrateOnce('nom-3', 'narr_07'); // same, but fires once per key (survives re-renders/reconnects)

export const NARR_SUBTITLES = {
  narr_01: 'Welcome to Secret Hitler.',
  narr_02: 'Liberals outnumber Fascists, but the Fascists know each other.',
  narr_03: 'Find Hitler. Stop the Fascist agenda. Trust no one.',
  narr_04: 'Check your phone to see your secret role. Shield your screen.',
  narr_05: 'Tap your role card to reveal it. Keep it hidden.',
  narr_06: 'The game begins. Good luck.',
  narr_07: 'Mister President, nominate your Chancellor.',
  narr_08: 'The President picks a Chancellor, then everyone votes. The last elected leaders cannot be picked again.',
  narr_09: 'Term limits apply. The last President and Chancellor are ineligible.',
  narr_10: 'Waiting for the nomination.',
  narr_11: 'The vote is open. Vote Ya, or Nein, on your phone now.',
  narr_12: 'Government elected. Presidency proceeds to legislation.',
  narr_13: 'Vote failed. The election tracker advances by one.',
  narr_14: 'Tracker at one of three.',
  narr_15: 'Tracker at two of three. One more failure means chaos.',
  narr_16: 'Waiting for all votes.',
  narr_17: 'Three failed votes. Chaos.',
  narr_18: 'The country is in turmoil. The top policy enacts itself.',
  narr_19: 'Term limits forgotten. Tracker reset.',
  narr_20: 'Mister President, discard one policy in secret. Pass two to your Chancellor.',
  narr_21: 'Never state exact tiles. You may lie, or tell the truth.',
  narr_22: 'Mister Chancellor, enact one policy in secret. Discard the other unseen.',
  narr_23: 'Waiting for legislation.',
  narr_24: 'Liberal policy enacted.',
  narr_25: 'One Liberal. Four to go.',
  narr_26: 'Two Liberals. Liberals are gaining ground.',
  narr_27: 'Three Liberals. The Fascists are nervous.',
  narr_28: 'Four Liberals. One more for a Liberal victory.',
  narr_29: 'Fascist policy enacted.',
  narr_30: 'Fascists advance. The presidency gains new power.',
  narr_31: 'Policy Peek. The President views the top three tiles in secret.',
  narr_32: 'Investigate Loyalty. The President learns one player\u2019s true allegiance.',
  narr_33: 'That result is private. Share it, or lie about it. Your choice.',
  narr_34: 'Special Election. The President chooses the next President.',
  narr_35: 'Execution. The President must execute one player.',
  narr_36: 'Waiting for the Presidential power.',
  narr_37: 'The peek is complete. Presidency passes.',
  narr_38: 'The investigation is complete. Presidency passes.',
  narr_39: 'A special election has been called. Normal rotation will resume after.',
  narr_40: 'A player has been executed. They were not Hitler.',
  narr_41: 'A player has been executed. The game continues without them.',
  narr_42: 'Veto power is now unlocked.',
  narr_43: 'After five Fascists, the Chancellor may propose discarding both tiles. The President must agree.',
  narr_44: 'Veto proposed. Mister President, agree or refuse.',
  narr_45: 'Veto agreed. Both policies discarded. Tracker advances.',
  narr_46: 'Veto refused. Chancellor, you must enact.',
  narr_47: 'Five Liberal policies. Liberals win.',
  narr_48: 'Six Fascist policies. Fascists win.',
  narr_49: 'Hitler has been elected Chancellor. Fascists win.',
  narr_50: 'Hitler has been executed. Liberals win.',
  narr_51: 'Game over. Thank you for playing. Start a new game to play again.',
};

const NARR_KEY = 'sh:narratorOn';
const queue = [];
let playing = false;
let unlocked = false;
let enabled = true;
let seenKeys = new Set();
let phaseToken = 0;
let subtitleFadeTimer = null;
// Skip-with-fade state: currentAudio is the live clip, fadingAudio is a
// previous clip still ramping to silence after a phase change.
let currentAudio = null;
let fadingAudio = null;
let fadeTimer = null;
const FADE_MS = 180;

function clearFade() {
  if (fadeTimer) {
    try { clearInterval(fadeTimer); } catch (_) {}
    fadeTimer = null;
  }
}

function stopAudioInstant(audio) {
  if (!audio) return;
  try { audio.onended = null; } catch (_) {}
  try { audio.onerror = null; } catch (_) {}
  try { audio.pause(); } catch (_) {}
}

// Instant stop of everything (toggle-off, new game). No fade.
function haltAllAudio() {
  clearFade();
  if (fadingAudio) { stopAudioInstant(fadingAudio); fadingAudio = null; }
  if (currentAudio) { stopAudioInstant(currentAudio); currentAudio = null; }
  playing = false;
}

// Phase-change skip: drop the backlog, fade the live clip out in the
// background (~180ms) while the new phase clip starts immediately.
function fadeOutCurrentForSkip() {
  // A previous fade still running: cut it instantly, its phase is long gone.
  if (fadingAudio) { stopAudioInstant(fadingAudio); fadingAudio = null; }
  clearFade();
  const old = currentAudio;
  currentAudio = null;
  playing = false;
  if (!old) return;
  try { old.onended = null; } catch (_) {}
  try { old.onerror = null; } catch (_) {}
  let startVol = 1;
  try { startVol = Number.isFinite(old.volume) ? old.volume : 1; } catch (_) {}
  fadingAudio = old;
  const steps = 6;
  const stepMs = Math.max(16, Math.round(FADE_MS / steps));
  let i = 0;
  fadeTimer = setInterval(() => {
    i++;
    try {
      if (fadingAudio !== old) { clearFade(); return; }
      old.volume = Math.max(0, startVol * (1 - i / steps));
    } catch (_) {}
    if (i >= steps) {
      clearFade();
      stopAudioInstant(old);
      if (fadingAudio === old) fadingAudio = null;
    }
  }, stepMs);
}

try {
  // Default ON; the toggle persists an explicit off.
  enabled = localStorage.getItem(NARR_KEY) !== '0';
} catch (_) { /* private mode */ }

function setSubtitle(text) {
  if (typeof document === 'undefined') return;
  const bar = document.getElementById('narrBar');
  const txt = document.getElementById('narrText');
  if (!bar || !txt) return;
  txt.textContent = text;
  bar.style.display = 'block';
  // Fresh line reads at full opacity, then fades to a whisper in place
  // (the bar is docked in-flow above the table, so it never covers seats
  // or boards). Hover (board has a mouse) restores it via CSS.
  try {
    bar.classList.remove('faded');
    if (subtitleFadeTimer) clearTimeout(subtitleFadeTimer);
    subtitleFadeTimer = setTimeout(() => bar.classList.add('faded'), 8000);
  } catch (_) {}
}

function unlock() {
  if (unlocked) return;
  unlocked = true;
}

if (typeof window !== 'undefined') {
  const opts = { passive: true };
  const once = () => unlock();
  window.addEventListener('pointerdown', once, opts);
  window.addEventListener('touchend', once, opts);
  window.addEventListener('keydown', once, opts);
}

export function isNarratorEnabled() {
  return enabled;
}

export function setNarratorEnabled(on) {
  enabled = !!on;
  try {
    localStorage.setItem(NARR_KEY, enabled ? '1' : '0');
  } catch (_) { /* ignore */ }
  if (!enabled) {
    queue.length = 0;
    phaseToken++; // cancel pending delayed reminders
    haltAllAudio();
  }
  refreshNarratorToggle();
}

let narrToggleBtn = null;

function refreshNarratorToggle() {
  if (!narrToggleBtn) return;
  narrToggleBtn.textContent = enabled ? '🎙️ Narrator on' : '🎙️ Narrator off';
  narrToggleBtn.setAttribute('aria-pressed', enabled ? 'true' : 'false');
}

export function initNarratorToggle(id = 'narratorBtn') {
  if (typeof document === 'undefined') return;
  narrToggleBtn = document.getElementById(id);
  if (!narrToggleBtn) return;
  refreshNarratorToggle();
  narrToggleBtn.addEventListener('click', () => {
    unlock();
    setNarratorEnabled(!enabled);
  });
}

function pump() {
  if (playing) return;
  const next = queue.shift();
  if (!next) return;
  if (!enabled || !unlocked) {
    // Still show subtitles when audio can't play yet; drop the audio.
    if (enabled) setSubtitle(next.subtitle);
    pump();
    return;
  }
  playing = true;
  setSubtitle(next.subtitle);
  try {
    const a = new Audio(`snd/narr/${next.clip}.mp3`);
    try { a.volume = 1; } catch (_) {}
    currentAudio = a;
    a.onended = () => { if (currentAudio !== a) return; currentAudio = null; playing = false; pump(); };
    a.onerror = () => { if (currentAudio !== a) return; currentAudio = null; playing = false; pump(); };
    const p = a.play();
    if (p && typeof p.then === 'function') p.catch(() => { if (currentAudio !== a) return; currentAudio = null; playing = false; pump(); });
  } catch (_) {
    currentAudio = null;
    playing = false;
    pump();
  }
}

// Queue a clip. Never throws; never breaks the game if audio fails.
export function narrate(clip) {
  const subtitle = NARR_SUBTITLES[clip];
  if (!subtitle) return;
  if (!enabled) return;
  queue.push({ clip, subtitle });
  pump();
}

// Same as narrate, but fires once per key — safe to call from render paths,
// reconnect replays, and duplicate watcher firings.
export function narrateOnce(key, clip) {
  if (seenKeys.has(key)) return;
  seenKeys.add(key);
  narrate(clip);
}

// Reminder line if the game is still in the same state after ms.
// stillValid() is polled at fire time; token cancels on phase change / toggle-off.
export function narrateDelayed(key, clip, ms, stillValid) {
  if (seenKeys.has(key)) return;
  seenKeys.add(key);
  const token = phaseToken;
  setTimeout(() => {
    if (token !== phaseToken) return;
    if (typeof stillValid === 'function' && !stillValid()) return;
    narrate(clip);
  }, ms);
}

// Call on every phase change: drop the stale backlog, fade the live clip
// (~180ms) and let the new phase clip start immediately.
export function cancelNarratorPending() {
  queue.length = 0;
  phaseToken++;
  fadeOutCurrentForSkip();
}

// Fresh game in the same room: allow the per-round keys to fire again.
export function resetNarratorKeys() {
  seenKeys = new Set();
  queue.length = 0;
  phaseToken++;
  haltAllAudio();
}
