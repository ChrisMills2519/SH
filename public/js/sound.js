// sound.js — tiny WebAudio-free SFX helper for board + phones.
// MP3s live in ../snd/<name>.mp3 (mono 44.1kHz ~64k). No dependencies.
//
// Usage:
//   import { playSound, initSoundToggle } from './sound.js';
//   initSoundToggle('soundBtn');   // wires a mute button (optional)
//   playSound('flip');             // no-op until first user gesture unlocks audio
//
// Mobile autoplay: browsers block Audio before a user gesture, so the first
// pointerdown/touchend/keydown unlocks (preloads) the pool. Calls before
// unlock are dropped silently — callers never need to await anything.

const SOUNDS = [
  'flip', 'tile-draw', 'vote-cast', 'election-pass', 'election-fail',
  'chaos', 'enact-liberal', 'enact-fascist', 'execution', 'scream', 'reveal',
  'your-turn', 'game-start', 'win-liberal', 'win-fascist',
];

const MUTE_KEY = 'sh:soundMuted';
const pool = new Map(); // name -> HTMLAudioElement
let unlocked = false;
let muted = false;

try {
  muted = localStorage.getItem(MUTE_KEY) === '1';
} catch (_) { /* private mode */ }

function makeAudio(name) {
  const a = new Audio(`snd/${name}.mp3`);
  a.preload = 'auto';
  return a;
}

function unlock() {
  if (unlocked) return;
  unlocked = true;
  for (const name of SOUNDS) {
    try {
      const a = makeAudio(name);
      // Prime the element so later play() is instant; catch() the
      // play-then-pause trick's rejection (still locked on some browsers).
      const p = a.play();
      if (p && typeof p.then === 'function') {
        p.then(() => a.pause()).catch(() => {});
      }
      a.currentTime = 0;
      pool.set(name, a);
    } catch (_) { /* ignore one bad file */ }
  }
}

if (typeof window !== 'undefined') {
  const opts = { passive: true };
  const once = () => unlock();
  window.addEventListener('pointerdown', once, opts);
  window.addEventListener('touchend', once, opts);
  window.addEventListener('keydown', once, opts);
}

export function isMuted() {
  return muted;
}

export function setMuted(m) {
  muted = !!m;
  try {
    localStorage.setItem(MUTE_KEY, muted ? '1' : '0');
  } catch (_) { /* ignore */ }
  for (const a of pool.values()) {
    try { if (!a.paused) a.pause(); } catch (_) { /* ignore */ }
  }
  refreshToggle();
}

let toggleBtn = null;

function refreshToggle() {
  if (!toggleBtn) return;
  toggleBtn.textContent = muted ? '🔇 Sound off' : '🔊 Sound on';
  toggleBtn.setAttribute('aria-pressed', muted ? 'true' : 'false');
}

export function initSoundToggle(id = 'soundBtn') {
  if (typeof document === 'undefined') return;
  toggleBtn = document.getElementById(id);
  if (!toggleBtn) return;
  refreshToggle();
  toggleBtn.addEventListener('click', () => {
    unlock();
    setMuted(!muted);
  });
}

export function playSound(name, { volume = 1 } = {}) {
  if (muted || !unlocked) return;
  if (!SOUNDS.includes(name)) return;
  try {
    let a = pool.get(name);
    if (!a) {
      a = makeAudio(name);
      pool.set(name, a);
    }
    a.volume = Math.min(1, Math.max(0, volume));
    a.currentTime = 0;
    const p = a.play();
    if (p && typeof p.then === 'function') p.catch(() => {});
  } catch (_) { /* never break the game for a sound */ }
}
