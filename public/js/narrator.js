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
    a.onended = () => { playing = false; pump(); };
    a.onerror = () => { playing = false; pump(); };
    const p = a.play();
    if (p && typeof p.then === 'function') p.catch(() => { playing = false; pump(); });
  } catch (_) {
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

// Call on every phase change so stale reminders never fire into a new phase.
export function cancelNarratorPending() {
  phaseToken++;
}

// Fresh game in the same room: allow the per-round keys to fire again.
export function resetNarratorKeys() {
  seenKeys = new Set();
  queue.length = 0;
  phaseToken++;
}
