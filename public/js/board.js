import { db, ensureSignedIn } from './firebase-config.js';
import {
  ref, get, set, update, onValue, runTransaction,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-database.js";
import {
  assignRoles, freshDeck, executivePowerFor, vetoUnlocked, randInt,
  ineligibleChancellorCandidates, checkWin, checkExecutionWin,
} from './game-logic.js';
import { playSound, initSoundToggle } from './sound.js';
import { initNarratorToggle, narrate, narrateOnce, narrateDelayed, cancelNarratorPending, resetNarratorKeys } from './narrator.js';

const params = new URLSearchParams(location.search);
const room = params.get('room');
const isNew = params.get('new') === '1';
const gameRef = ref(db, `games/${room}`);
const metaRef = ref(db, `games/${room}/meta`);

const el = id => document.getElementById(id);

let myUid = null;
let currentMeta = {};
let currentPlayers = {};
// Tabletop extras (read-only mirrors for piles + vote dots; never written).
let deckCount = 17;
let discardCount = 0;
let votesCastMap = {};
let votesMap = {};
let votesRevealedFlag = false;
let extrasRound = null;
let extrasUnsubs = [];
let prevSeatState = '';
// Night-reveal progress mirror (read-only; phones write their own roleSeen).
let nightAcked = 0;
let nightTotal = 0;

async function main() {
  const user = await ensureSignedIn();
  myUid = user.uid;
  initSoundToggle();
  initNarratorToggle();

  const fsBtn = el('fullscreenBtn');
  if (fsBtn) {
    fsBtn.addEventListener('click', () => {
      if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen().catch(() => {});
      } else {
        document.exitFullscreen().catch(() => {});
      }
    });
  }

  if (isNew) {
    // Claim hostUid first (its rule allows creating an empty room), then
    // write the rest — host-gated children evaluate against existing data,
    // so they would be denied if bundled into the same write as hostUid.
    await set(ref(db, `games/${room}/meta/hostUid`), myUid);
    await update(metaRef, {
      phase: 'lobby',
      roundId: 0,
      electionTracker: 0,
      liberalTrack: 0,
      fascistTrack: 0,
      vetoUnlocked: false,
    });
  }

  // The QR must encode an address phones can reach. location.host is
  // localhost on local dev (useless to phones), and the browser can't learn
  // the LAN IP itself — so the host can override it once; it persists.
  const phoneHostInput = el('phoneHost');
  if (phoneHostInput) {
    try { phoneHostInput.value = localStorage.getItem('sh:phoneHost') || ''; } catch (_) { /* ignore */ }
  }
  function buildJoinUrl() {
    let host = location.host;
    const override = (phoneHostInput && phoneHostInput.value || '').trim()
      .replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
    if (override) host = override;
    return `${location.protocol}//${host}${location.pathname.replace('board.html', 'play.html')}?room=${room}`;
  }
  function refreshJoin() {
    const joinUrl = buildJoinUrl();
    renderQr(joinUrl);
    el('joinUrl').textContent = joinUrl;
  }
  refreshJoin();
  if (phoneHostInput) phoneHostInput.addEventListener('input', () => {
    try { localStorage.setItem('sh:phoneHost', phoneHostInput.value.trim()); } catch (_) { /* ignore */ }
    refreshJoin();
  });
  el('roomCode').textContent = room;

  onValue(ref(db, `games/${room}/players`), snap => {
    currentPlayers = snap.val() || {};
    render();
  });

  onValue(metaRef, snap => {
    const prevPhase = currentMeta.phase;
    currentMeta = snap.val() || {};
    render();
    // Only the host reacts to phase-driving events, and only once per change.
    if (currentMeta.hostUid === myUid && currentMeta.phase !== prevPhase) {
      cancelNarratorPending();
      handlePhaseEnter(currentMeta.phase);
    }
  });

  // Tabletop mirrors: draw/discard pile sizes (host-readable) + per-round
  // vote presence/values for seat dots. Read-only; game logic untouched.
  onValue(ref(db, `games/${room}/secret/deck`), snap => {
    const v = snap.val();
    const arr = Array.isArray(v) ? v : Object.values(v || {});
    deckCount = arr.length;
    render();
  }, () => {});
  onValue(ref(db, `games/${room}/secret/discard`), snap => {
    const v = snap.val();
    const arr = Array.isArray(v) ? v : Object.values(v || {});
    discardCount = arr.length;
    render();
  }, () => {});

  // Seat reclaim (reconnect PIN) runs for the whole session — lobby too — so
  // it's installed once here, not phase-gated like the legislative watchers.
  watchForReclaimRequests();

  el('startBtn').addEventListener('click', startGame);

  // Stage fitting. Re-run whenever the space the stage has to live in changes:
  // a window resize, a fullscreen toggle, a projector resolution switch, the
  // host tools appearing (they are in flow, so they shrink the stage viewport)
  // or the host aspect crossing a tier boundary. Firebase updates re-run it via
  // render() as well. Everything we set here is a transform plus (at most) one
  // class toggle, so the observer below cannot feed itself.
  const refit = () => { try { fitStage(); } catch (_) {} };
  window.addEventListener('resize', refit);
  document.addEventListener('fullscreenchange', refit);
  window.addEventListener('load', refit);
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(refit).catch(() => {});
  }
  try {
    const mq = typeof matchMedia === 'function' && matchMedia('(min-aspect-ratio: 3/2)');
    if (mq && mq.addEventListener) mq.addEventListener('change', refit);
  } catch (_) {}
  // Observe the *viewport*, not the table: an interior swap (more seats, a
  // phase change, an enactment) no longer changes the scene's size, and the
  // table's own box is oversized and scaled, so watching it would let it
  // measure its own result. rAF-coalesced so a burst of swaps fits once.
  try {
    if (typeof ResizeObserver === 'function') {
      let fitQueued = false;
      const ro = new ResizeObserver(() => {
        if (fitQueued) return;
        fitQueued = true;
        requestAnimationFrame(() => {
          fitQueued = false;
          refit();
        });
      });
      const vp = el('stageFit');
      if (vp) ro.observe(vp);
    }
  } catch (_) {}
  // Fit immediately rather than waiting for the first Firebase render: the
  // lobby is hidden, but a reload straight into a live game is not.
  refit();
  const nightSkipBtn = el('nightSkipBtn');
  if (nightSkipBtn) nightSkipBtn.addEventListener('click', () => {
    skipNight().catch(e => console.warn('[board] skip-night failed:', e && e.message));
  });
  el('forceResolveBtn').addEventListener('click', () => {
    forceResolveElection().catch(e => console.warn('[board] force-resolve failed:', e && e.message));
  });

  // --- DEV-ONLY START: solo-testing bots. Delete this block with dev-bots.js before game night. ---
  if (new URLSearchParams(location.search).get('dev') === '1') {
    const devPanel = document.getElementById('devPanel');
    if (devPanel) devPanel.style.display = 'block';
    try { document.body.classList.add('dev'); } catch (_) {}
    // DEV-ONLY hide toggle (H): true game look while testing fit.
    const setDevHidden = hidden => {
      try {
        document.body.classList.toggle('dev-tools-hidden', hidden);
        const b = document.getElementById('devHideBtn');
        if (b) b.textContent = hidden ? 'Show (H)' : 'Hide (H)';
        fitStage();
      } catch (_) {}
    };
    const hideBtn = document.getElementById('devHideBtn');
    if (hideBtn) hideBtn.addEventListener('click', () => setDevHidden(!document.body.classList.contains('dev-tools-hidden')));
    window.addEventListener('keydown', e => {
      if ((e.key === 'h' || e.key === 'H') && !/INPUT|TEXTAREA/.test((e.target && e.target.tagName) || '')) {
        setDevHidden(!document.body.classList.contains('dev-tools-hidden'));
      }
    });
    import('./dev-bots.js').then(m => m.initDevBots({ room })).catch(e => console.warn('[devbots] load failed', e));
  }
  // --- DEV-ONLY END ---
}

// ---------------------------------------------------------------------------
// Lobby -> role assignment
// ---------------------------------------------------------------------------
async function startGame() {
  // Retired seats (old uids left behind by a reconnect) never start: they
  // hold no living player, only a tombstone for the render loop to skip.
  const playerList = Object.entries(currentPlayers)
    .filter(([, p]) => p && p.retired !== true)
    .map(([uid, p]) => ({ uid, name: p.name, joinedAt: p.joinedAt || 0 }))
    .sort((a, b) => a.joinedAt - b.joinedAt);

  if (playerList.length < 5 || playerList.length > 10) {
    alert('Secret Hitler needs 5-10 players.');
    return;
  }

  const { roles, knownTeammates } = assignRoles(playerList);
  const deck = freshDeck();

  const updates = {};
  playerList.forEach(p => {
    updates[`secret/roles/${p.uid}`] = roles[p.uid];
    updates[`secret/knownTeammates/${p.uid}`] = knownTeammates[p.uid];
    updates[`players/${p.uid}/alive`] = true;
    // Night-phase reveal ack: cleared for every seat so the new game blocks
    // in `night` until each player taps their role card (see watchForNightAcks).
    // Null (not false) keeps Firebase `!data.exists()` write-once semantics tidy.
    updates[`players/${p.uid}/roleSeen`] = null;
  });
  updates['secret/deck'] = deck;
  updates['secret/discard'] = [];
  // Wipe the previous game's per-round state. Once-write nodes (claims,
  // idx choices, veto keys, votes) are keyed by roundId restarting at 0, so
  // without this a second game in the same room would find round 0 already
  // "claimed"/answered and wedge immediately. Parent rules grant the host
  // wholesale deletes of these subtrees.
  updates['secret/claims'] = null;
  updates['secret/legislative'] = null;
  updates['secret/executive'] = null;
  updates['votes'] = null;
  updates['votesCast'] = null;
  updates['votesRevealed'] = null;
  // Stale seat-reclaim intents don't carry into a new game (re-file in the
  // new lobby if still needed). Reconnect PINs and retired tombstones are
  // uid-bound history and intentionally survive: same-browser players keep
  // their codes across games.
  updates['reclaimRequests'] = null;
  updates['meta/playerOrder'] = playerList.map(p => p.uid);
  updates['meta/presidentUid'] = playerList[0].uid;
  updates['meta/presidentUidLast'] = null;
  updates['meta/chancellorUid'] = null;
  updates['meta/chancellorUidLast'] = null;
  updates['meta/chancellorCandidateUid'] = null;
  updates['meta/electionTracker'] = 0;
  updates['meta/liberalTrack'] = 0;
  updates['meta/fascistTrack'] = 0;
  updates['meta/roundId'] = 0;
  // Synced night reveal: the game opens in `night` (private tap-to-reveal on
  // each phone) and only advances to `nomination` once every living player
  // has acked (watchForNightAcks) or the host skips. Previously this jumped
  // straight to `nomination`, letting the first president nominate while
  // others hadn't seen their roles yet.
  updates['meta/phase'] = 'night';
  updates['meta/pendingPower'] = null;
  updates['meta/executionTarget'] = null;
  updates['meta/investigateTarget'] = null;
  updates['meta/specialElectionTarget'] = null;
  updates['meta/specialElectionReturnUid'] = null;
  updates['meta/investigatedUids'] = null;
  await update(ref(db, `games/${room}`), updates);
  playSound('game-start');
  resetNarratorKeys();
  // Opening narration now fires from handlePhaseEnter('night') (via the meta
  // listener) so a board refresh mid-night still narrates instead of going silent.
}

// ---------------------------------------------------------------------------
// Host-driven phase transitions.
// The board is the only writer of meta/phase, so it's the single place
// where "what happens next" is decided — same job a Node server would do.
// ---------------------------------------------------------------------------
function handlePhaseEnter(phase) {
  const roundId = currentMeta.roundId || 0;
  const tutorial = roundId <= 1; // first two rounds over-explain, then terse calls
  const stillIn = (p, r) => {
    const m = currentMeta;
    return m.phase === p && (m.roundId || 0) === r;
  };
  if (phase === 'night') {
    watchForNightAcks();
    narrateOnce('night-01', 'narr_01');
    narrate('narr_02');
    narrate('narr_03');
    narrate('narr_04');
    narrate('narr_05');
    narrate('narr_06');
    narrateDelayed(`night-wait`, 'narr_10', 25000, () => (currentMeta.phase === 'night'));
  }
  if (phase === 'nomination') {
    watchForNomination();
    narrateOnce(`nom-${roundId}`, 'narr_07');
    narrate(tutorial ? 'narr_08' : 'narr_09');
    narrateDelayed(`nom-wait-${roundId}`, 'narr_10', 20000, () => stillIn('nomination', roundId) && !currentMeta.chancellorCandidateUid);
  }
  if (phase === 'election') {
    watchForVotes();
    narrateOnce(`vote-${roundId}`, 'narr_11');
    narrateDelayed(`vote-wait-${roundId}`, 'narr_16', 20000, () => stillIn('election', roundId));
  }
  if (phase === 'legislative_president') {
    watchForPresidentChoice(); watchForPresidentDiscard();
    narrateOnce(`pres-${roundId}`, 'narr_20');
    if (tutorial) narrate('narr_21');
    narrateDelayed(`pres-wait-${roundId}`, 'narr_23', 25000, () => stillIn('legislative_president', roundId));
  }
  if (phase === 'legislative_chancellor') { watchForChancellorEnact(); watchForVeto(); watchForVetoRequest(roundId); narrateOnce(`chan-${roundId}`, 'narr_22'); }
  if (phase === 'executive_action') {
    watchForExecutiveAction();
    narrateExecutiveIntro(roundId);
    // Host juice: power callout (view-only, non-blocking so the President can act).
    try { showPowerCalloutCinematic(currentMeta.pendingPower); } catch (_) {}
    narrateDelayed(`pow-wait-${roundId}`, 'narr_36', 25000, () => stillIn('executive_action', roundId));
  }
}

// One-shot intro line for whichever presidential power just unlocked.
function narrateExecutiveIntro(roundId) {
  const power = currentMeta.pendingPower;
  if (power === 'policy_peek') narrateOnce(`pow-${roundId}`, 'narr_31');
  else if (power === 'investigate_loyalty') narrateOnce(`pow-${roundId}`, 'narr_32');
  else if (power === 'special_election') narrateOnce(`pow-${roundId}`, 'narr_34');
  else if (power === 'execution') narrateOnce(`pow-${roundId}`, 'narr_35');
}

// Shared enactment narration: generic call + running count. Wins are handled
// by endGame, so counts only cover non-winning totals.
function narrateEnactment(tile, newVal) {
  if (tile === 'liberal') {
    narrate('narr_24');
    if (newVal === 1) narrate('narr_25');
    else if (newVal === 2) narrate('narr_26');
    else if (newVal === 3) narrate('narr_27');
    else if (newVal === 4) narrate('narr_28');
  } else {
    narrate('narr_29');
    narrate('narr_30');
  }
}

// ---------------------------------------------------------------------------
// Cinematic engine (host view-only). All functions are safe to call from any
// claim-winner path; they never write game state and always resolve (with a
// timeout fallback) so the game can never wedge on animation.
// ---------------------------------------------------------------------------
const CINEMATIC_MS = 2300;
const TALLY_MS = 1900;
const CALLOUT_MS = 1800;

function prefersReducedMotion() {
  try {
    return (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches)
      || document.body.classList.contains('reduced');
  } catch (_) { return false; }
}

function cinematicEls() {
  return {
    overlay: el('enactOverlay'),
    bigImg: el('enactImg'),
    cap: el('enactCap'),
    ribbon: el('enactRibbon'),
    tallyBar: el('tallyBar'),
    tallyResult: el('tallyResult'),
    powerBox: el('powerCallout'),
    win: el('winTakeover'),
    winTitle: el('winTitle'),
    winSub: el('winSub'),
    confetti: el('winConfetti'),
    table: el('table'),
    execFlash: el('execFlash'),
  };
}

// The slot currently flying onto a board. While set, paintTileLayer keeps
// that one slot EMPTY (pulsing outline) even though meta already counts the
// policy — the tile only appears when the flyer lands. View-only; meta is
// always the source of truth, so a refresh mid-flight just paints final.
let pendingEnact = null; // { kind: 'liberal'|'fascist', count: n } | null

// Execution cinematic state. Persisted through re-renders (which wipe seat
// DOM) so Firebase updates mid-cinematic can't erase the crosshair/blood.
let execState = null; // { uid, stage: 'lock'|'shot'|'aftermath', isHitler } | null

function resetCinematic() {
  const { overlay, win, tallyBar, tallyResult, powerBox, ribbon } = cinematicEls();
  if (overlay) overlay.classList.remove('show', 'direct');
  try {
    document.body.classList.remove('enact-focus-liberal', 'enact-focus-fascist');
    if (win) win.classList.remove('show');
  } catch (_) {}
  const table = el('table');
  if (table) table.classList.remove('shake');
  if (tallyBar) { tallyBar.style.display = 'none'; tallyBar.innerHTML = ''; }
  if (tallyResult) tallyResult.textContent = '';
  if (powerBox) { powerBox.style.display = 'none'; powerBox.innerHTML = ''; }
  if (ribbon) ribbon.style.display = 'none';
}

// Deck → slot flight for the direct-to-board cinematic. The board stays
// ZOOMED for the whole flight; un-zoom happens on settle, not here.
function flyDeckToSlot(kind, count, onLanded) {
  try {
    const layer = el(kind === 'liberal' ? 'liberalTiles' : 'fascistTiles');
    const deckEl = el('policyFan') || el('policyWell');
    const spot = layer && layer.children[count - 1];
    if (!layer || !deckEl || !spot) { if (onLanded) onLanded(); return; }
    const from = deckEl.getBoundingClientRect();
    const to = spot.getBoundingClientRect();
    if (!from.width || !to.width) { if (onLanded) onLanded(); return; }
    const flyer = document.createElement('div');
    flyer.className = 'enact-flyer direct-flyer';
    flyer.innerHTML = `<img src="img/tile-${kind}.png" alt="" />`;
    const startW = Math.max(44, Math.min(90, from.width / 3 || 60));
    flyer.style.left = `${from.left + from.width / 2 - startW / 2}px`;
    flyer.style.top = `${from.top + from.height / 2 - (startW * 1.24) / 2}px`;
    flyer.style.width = `${startW}px`;
    document.body.appendChild(flyer);
    const fromCx = from.left + from.width / 2, fromCy = from.top + from.height / 2;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const dx = to.left + to.width / 2 - fromCx;
      const dy = to.top + to.height / 2 - fromCy;
      flyer.style.transform = `translate(${dx}px,${dy}px) rotate(6deg)`;
      flyer.style.width = `${to.width}px`;
      flyer.style.opacity = '0.98';
    }));
    setTimeout(() => { flyer.remove(); if (onLanded) onLanded(); }, 1150);
  } catch (_) { if (onLanded) onLanded(); }
}

const POWER_LABELS = {
  policy_peek: 'Policy peek unlocked',
  investigate_loyalty: 'Investigate loyalty unlocked',
  special_election: 'Special election unlocked',
  execution: 'Execution unlocked',
};

// Blocking enactment cinematic, direct-to-board (~2.6s; fast reduced-motion).
// No center hold: caption docks top, board zooms, tile flies deck → slot and
// the slot fills exactly ON LANDING via pendingEnact (see paintTileLayer).
function playEnactCinematic(tile, count, { chaos = false, powerLabel = null } = {}) {
  const { overlay, cap, ribbon, tallyBar, tallyResult, powerBox, table } = cinematicEls();
  if (!overlay || !cap) return Promise.resolve();
  const isLib = tile === 'liberal';
  resetCinematic();
  pendingEnact = { kind: tile, count };
  cap.style.display = '';
  cap.className = `enact-caption ${isLib ? 'liberal-cap' : 'fascist-cap'}`;
  const boardWord = isLib ? 'liberal' : 'fascist';
  const capTitle = isLib ? 'Liberal' : 'Fascist';
  cap.innerHTML = `${capTitle} ${count}<small>${chaos ? 'Chaos — top tile auto-enacts' : `Placing on the ${boardWord} board…`}</small>`;
  if (ribbon) {
    if (powerLabel) { ribbon.textContent = powerLabel; ribbon.style.display = 'inline-block'; }
    else ribbon.style.display = 'none';
  }
  if (tallyBar) tallyBar.style.display = 'none';
  if (tallyResult) tallyResult.textContent = '';
  if (powerBox) powerBox.style.display = 'none';
  try { document.body.classList.add(isLib ? 'enact-focus-liberal' : 'enact-focus-fascist'); } catch (_) {}
  if (chaos && table) {
    table.classList.remove('shake');
    void table.offsetWidth;
    table.classList.add('shake');
    setTimeout(() => table.classList.remove('shake'), 600);
  }
  paintBoardOverlays(); // show the pulsing target outline immediately
  overlay.classList.add('show', 'direct');
  if (prefersReducedMotion()) {
    return new Promise(res => setTimeout(() => { pendingEnact = null; resetCinematic(); paintBoardOverlays(); res(); }, 200));
  }
  const boardEl = tile === 'liberal' ? el('liberalBoard') : el('fascistBoard');
  // Launch the deck→slot flight on the next frames so the zoom applies first.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    flyDeckToSlot(tile, count, () => {
      pendingEnact = null;
      paintBoardOverlays();
      const layer = el(tile === 'liberal' ? 'liberalTiles' : 'fascistTiles');
      const landed = layer && layer.children[count - 1];
      if (landed) {
        landed.classList.add('just-landed');
        setTimeout(() => landed.classList.remove('just-landed'), 600);
      }
      if (boardEl) {
        boardEl.classList.add(tile === 'liberal' ? 'just-enacted-liberal' : 'just-enacted-fascist');
        setTimeout(() => boardEl.classList.remove('just-enacted-liberal', 'just-enacted-fascist'), 700);
      }
      cap.innerHTML = `${capTitle} ${count}<small>Placed</small>`;
    });
  }));
  // Hold the zoom briefly after landing so the placement reads, then settle.
  return new Promise(res => {
    const done = () => { pendingEnact = null; resetCinematic(); paintBoardOverlays(); res(); };
    setTimeout(done, CINEMATIC_MS + 300);
    setTimeout(done, CINEMATIC_MS + 1800); // backstop
  });
}

// Blocking election tally (~1.9s). votes is {ja, total} or an array of 'ja'/'nein'.
function showTallyCinematic({ ja = 0, total = 0, passed = false, nomineeName = '' } = {}) {
  const { overlay, bigImg, cap, ribbon, tallyBar, tallyResult, powerBox } = cinematicEls();
  if (!overlay || !tallyBar) return Promise.resolve();
  resetCinematic();
  if (bigImg) { bigImg.src = 'img/ballot-ja.png'; bigImg.style.display = ''; }
  if (cap) {
    cap.style.display = '';
    cap.className = 'enact-caption';
    cap.innerHTML = `Vote${nomineeName ? ` — ${nomineeName}` : ''}<small>The table votes</small>`;
  }
  if (ribbon) ribbon.style.display = 'none';
  if (powerBox) powerBox.style.display = 'none';
  tallyBar.style.display = 'flex';
  tallyBar.innerHTML = '';
  if (tallyResult) { tallyResult.textContent = ''; tallyResult.style.color = ''; }
  overlay.classList.add('show');
  if (prefersReducedMotion()) {
    if (tallyResult) {
      tallyResult.textContent = `${ja} Ja — ${passed ? 'Elected!' : 'Rejected'}`;
      tallyResult.style.color = passed ? '#6fd68b' : '#ff9a8a';
    }
    return new Promise(res => setTimeout(() => { resetCinematic(); res(); }, 250));
  }
  const segs = [];
  for (let i = 0; i < Math.max(0, total); i++) {
    const s = document.createElement('div');
    s.className = `tally-seg ${i < ja ? 'ja' : 'nein'}`;
    tallyBar.appendChild(s);
    segs.push(s);
  }
  segs.forEach((s, i) => setTimeout(() => s.classList.add('on'), 250 + i * 110));
  const resultAt = 250 + segs.length * 110 + 250;
  setTimeout(() => {
    if (tallyResult) {
      tallyResult.textContent = `${ja} Ja — ${passed ? 'Elected!' : 'Rejected'}`;
      tallyResult.style.color = passed ? '#6fd68b' : '#ff9a8a';
    }
  }, resultAt);
  return new Promise(res => {
    setTimeout(() => { resetCinematic(); res(); }, Math.max(TALLY_MS, resultAt + 500));
    setTimeout(() => { resetCinematic(); res(); }, TALLY_MS + 3000);
  });
}

// Non-blocking power intro (~1.8s, fire-and-forget).
function showPowerCalloutCinematic(power) {
  try {
    const { overlay, bigImg, cap, ribbon, tallyBar, tallyResult, powerBox } = cinematicEls();
    if (!overlay || !powerBox) return;
    if (overlay.classList.contains('show')) return; // don't stomp an enactment
    resetCinematic();
    if (bigImg) bigImg.style.display = 'none';
    if (cap) cap.style.display = 'none';
    if (ribbon) ribbon.style.display = 'none';
    if (tallyBar) tallyBar.style.display = 'none';
    if (tallyResult) tallyResult.textContent = '';
    const titles = {
      execution: ['◎', 'Execution', 'The President must eliminate one player.'],
      investigate_loyalty: ['◉', 'Investigate Loyalty', 'The President learns one party membership.'],
      special_election: ['★', 'Special Election', 'The President names the next President.'],
      policy_peek: ['▤', 'Policy Peek', 'The President sees the top 3 tiles.'],
    };
    const [glyph, title, sub] = titles[power] || ['⚡', 'Presidential Power', ''];
    powerBox.innerHTML = `<div class="crosshair" aria-hidden="true">${glyph}</div><h2>${title}</h2><p class="muted">${sub}</p>`;
    powerBox.style.display = 'block';
    overlay.classList.add('show');
    const hide = () => { try { overlay.classList.remove('show'); powerBox.style.display = 'none'; } catch (_) {} };
    setTimeout(hide, prefersReducedMotion() ? 300 : CALLOUT_MS);
  } catch (_) {}
}

// Blocking veto drama (~1.5s).
function showVetoCinematic(tracker) {
  const { overlay, bigImg, cap, ribbon, tallyBar, tallyResult, powerBox } = cinematicEls();
  if (!overlay || !bigImg || !cap) return Promise.resolve();
  resetCinematic();
  bigImg.style.display = '';
  cap.style.display = '';
  bigImg.src = 'img/back-tile.png';
  cap.className = 'enact-caption';
  cap.innerHTML = `Veto agreed<small>Both tiles discarded · tracker ${tracker}</small>`;
  if (ribbon) ribbon.style.display = 'none';
  if (tallyBar) tallyBar.style.display = 'none';
  if (tallyResult) tallyResult.textContent = '';
  if (powerBox) powerBox.style.display = 'none';
  overlay.classList.add('show');
  return new Promise(res => {
    setTimeout(() => { resetCinematic(); res(); }, prefersReducedMotion() ? 250 : 1500);
    setTimeout(() => { resetCinematic(); res(); }, 3000);
  });
}

const WIN_SUBS = {
  five_liberal_policies: 'Five liberal policies',
  six_fascist_policies: 'Six fascist policies',
  hitler_elected_chancellor: 'Hitler elected Chancellor',
  hitler_executed: 'Hitler executed',
};

// ---------------------------------------------------------------------------
// Execution cinematic: lock → shot → aftermath (~2.9s, blocking).
// View-only staging via execState so Firebase re-renders mid-cinematic can't
// wipe the crosshair/blood (seatHtml repaints decorations from execState).
// The victim's `alive=false` write lands ON THE SHOT, so the seat only dies
// when the room sees it happen. Dead seats keep blood + stamp + tomb.
// ---------------------------------------------------------------------------
function playExecutionCinematic(targetUid, { isHitler = false, victimName = '?', onShot = null } = {}) {
  const { execFlash, table } = cinematicEls();
  const reduced = prefersReducedMotion();
  const stageMs = reduced ? { lock: 150, shot: 300, settle: 700 } : { lock: 850, shot: 1450, settle: 2900 };
  resetCinematic();
  try { document.body.classList.add('exec-active'); } catch (_) {}
  execState = { uid: targetUid, stage: 'lock', isHitler };
  paintSeats();
  playSound('execution');
  const fireShot = () => {
    // The victim dies exactly on this frame: alive=false paints through
    // seatHtml (dead + blood), so the room sees cause and effect together.
    if (typeof onShot === 'function') {
      try { onShot(); } catch (e) { console.warn('[board] exec onShot failed:', e && e.message); }
    }
  };
  if (reduced) {
    return (async () => {
      await new Promise(res => setTimeout(res, stageMs.lock));
      fireShot();
      execState = { uid: targetUid, stage: 'aftermath', isHitler };
      paintSeats();
      await new Promise(res => setTimeout(res, stageMs.settle));
      execState = null;
      try { document.body.classList.remove('exec-active'); } catch (_) {}
      paintSeats();
    })();
  }
  return (async () => {
    await new Promise(res => setTimeout(res, stageMs.lock));
    // THE SHOT: flash + kick + blood. The caller writes alive=false here.
    if (execFlash) {
      execFlash.classList.remove('fire');
      void execFlash.offsetWidth;
      execFlash.classList.add('fire');
    }
    if (table) {
      table.classList.remove('shake');
      void table.offsetWidth;
      table.classList.add('shake');
      setTimeout(() => table.classList.remove('shake'), 550);
    }
    playSound('enact-fascist');
    execState = { uid: targetUid, stage: 'shot', isHitler };
    paintSeats();
    fireShot();
    await new Promise(res => setTimeout(res, stageMs.shot - stageMs.lock));
    // AFTERMATH: stamp + tomb rise.
    execState = { uid: targetUid, stage: 'aftermath', isHitler };
    paintSeats();
    playSound('scream');
    await new Promise(res => setTimeout(res, stageMs.settle - stageMs.shot));
    execState = null;
    try { document.body.classList.remove('exec-active'); } catch (_) {}
    paintSeats();
  })();
}

// Persistent win takeover (stays until next game; render() re-asserts on refresh).
function showWinTakeover(winner, reason) {
  try {
    const { win, winTitle, winSub, confetti } = cinematicEls();
    if (!win) return;
    resetCinematic();
    win.classList.remove('liberal', 'fascist');
    win.classList.add(winner === 'liberal' ? 'liberal' : 'fascist');
    if (winTitle) winTitle.textContent = winner === 'liberal' ? 'Liberals win!' : 'Fascists win!';
    if (winSub) winSub.textContent = WIN_SUBS[reason] || String(reason || '');
    if (confetti) {
      confetti.innerHTML = '';
      const colors = winner === 'liberal'
        ? ['#3b6fd6', '#9db9ff', '#ffd75e', '#ffffff']
        : ['#a3282f', '#ff9a8a', '#ffd75e', '#000000'];
      for (let i = 0; i < 60; i++) {
        const s = document.createElement('span');
        s.style.left = `${Math.random() * 100}%`;
        s.style.background = colors[i % colors.length];
        s.style.animationDuration = `${2 + Math.random() * 3}s`;
        s.style.animationDelay = `${Math.random() * 2}s`;
        confetti.appendChild(s);
      }
    }
    win.classList.add('show');
    win.setAttribute('aria-hidden', 'false');
  } catch (_) {}
}

// The Chancellor's veto request lives under secret/legislative, not meta, so it
// needs its own watcher (host-only, installed alongside watchForVeto).
function watchForVetoRequest(roundId) {
  let done = false;
  let unsub = null;
  unsub = onValue(ref(db, `games/${room}/secret/legislative/${roundId}/vetoRequested`), async snap => {
    if (done) return;
    if (snap.val() !== true) return;
    const m = await freshMeta();
    if (m.phase !== 'legislative_chancellor' || (m.roundId || 0) !== roundId) return;
    done = true;
    if (typeof unsub === 'function') unsub();
    narrateOnce(`veto-req-${roundId}`, 'narr_44');
  });
}

function alivePlayers() {
  // Retired seats (reclaimed by a reconnect) are gone from playerOrder, but
  // belt-and-braces: never count one toward quorums or candidacies.
  return (currentMeta.playerOrder || []).filter(uid => currentPlayers[uid] && currentPlayers[uid].alive !== false && currentPlayers[uid].retired !== true);
}

// Replay guard: Firebase re-fires watchers with already-completed state on
// reconnects and fresh subscriptions. Every phase action below re-reads meta
// first and no-ops unless the game is still in the stage it subscribed for —
// without this, a replayed election/enactment deals duplicate tiles and
// silently destroys them by overwriting history nodes.
async function freshMeta() {
  return (await get(metaRef)).val() || {};
}

// Single-flight claims: exactly one driver may perform a given phase action,
// across tabs, refreshes, and reconnects. The transaction commits only if the
// key is absent; losers get committed=false and must abort. Without this,
// a fresh subscription mid-phase (e.g. board refresh during legislation)
// replays the current action — duplicate deals orphan tiles and duplicate
// enactments double-count tracks.
async function claim(key) {
  try {
    const res = await runTransaction(ref(db, `games/${room}/secret/claims/${key}`), cur => {
      if (cur !== null && cur !== undefined) return undefined;
      return { by: myUid, at: Date.now() };
    });
    return res.committed === true;
  } catch (e) {
    console.warn(`[claim ${key}] failed:`, e && e.message);
    return false;
  }
}

async function releaseClaim(key) {
  try {
    await update(ref(db, `games/${room}`), { [`secret/claims/${key}`]: null });
  } catch (_) {}
}

// Official rule: only living, non-retired seats can hold office, be
// nominated, or be targeted by powers. Missing fields count as eligible
// (legacy nodes carry no retired flag); explicit false/true disqualifies.
function isSeatEligible(p) {
  return !!p && p.alive !== false && p.retired !== true;
}

async function freshPlayers() {
  return (await get(ref(db, `games/${room}/players`))).val() || {};
}

function watchForNightAcks() {
  // Synced opening reveal: phones ack by writing players/{uid}/roleSeen=true
  // when they tap their role card. Auto-advance to nomination at full quorum;
  // the host can skip early via nightSkipBtn (same single-flight claim key).
  const entryRound = currentMeta.roundId || 0;
  let done = false;
  let unsub = null;
  const check = async snap => {
    if (done) return;
    // Host skipped or quorum already advanced us: retire this watcher so it
    // doesn't re-fire (and re-claim) on every players change for the rest
    // of the game.
    if (currentMeta.phase && currentMeta.phase !== 'night') {
      done = true;
      if (typeof unsub === 'function') unsub();
      return;
    }
    const players = snap.val() || {};
    const order = (currentMeta.playerOrder || []).filter(uid =>
      players[uid] && players[uid].alive !== false && players[uid].retired !== true);
    const acked = order.filter(uid => players[uid] && players[uid].roleSeen === true);
    nightAcked = acked.length;
    nightTotal = order.length;
    render();
    if (!order.length || acked.length < order.length) return;
    const m = await freshMeta();
    if (m.phase !== 'night' || (m.roundId || 0) !== entryRound) return;
    if (!(await claim('night-done'))) return;
    done = true;
    if (typeof unsub === 'function') unsub();
    await advanceFromNight();
  };
  unsub = onValue(ref(db, `games/${room}/players`), check);
}

// Night -> nomination. Single-flight callers: full-quorum auto-advance and
// the host skip button share the `night-done` claim, so exactly one wins.
async function advanceFromNight() {
  const m = await freshMeta();
  if (m.phase !== 'night') return;
  narrate('narr_06');
  await update(metaRef, { chancellorCandidateUid: null, phase: 'nomination' });
}

async function skipNight() {
  const m = await freshMeta();
  if (m.phase !== 'night') {
    console.warn('[board] skip-night ignored: not in night');
    return;
  }
  if (!(await claim('night-done'))) {
    console.warn('[board] skip-night ignored: night already claimed');
    return;
  }
  await advanceFromNight();
}

function watchForNomination() {
  // NB: onValue can invoke the callback synchronously with cached data,
  // before `unsub` is assigned — hence the done-flag + guarded unsub.
  const entryRound = currentMeta.roundId || 0;
  let done = false;
  let unsub = null;
  unsub = onValue(ref(db, `games/${room}/meta/chancellorCandidateUid`), async snap => {
    if (done) return;
    const candidate = snap.val();
    if (!candidate) return;
    const m = await freshMeta();
    if (m.phase !== 'nomination' || (m.roundId || 0) !== entryRound) return;
    // Server-side eligibility re-check: phones filter the nominee list, but a
    // stale client can nominate a term-limited/dead/retired player. Reject by clearing
    // the candidate and staying subscribed for a corrected nomination.
    // (Claim only after validation, so the retry isn't blocked by our claim.)
    const order = m.playerOrder || [];
    const freshP = await freshPlayers();
    const aliveCount = order.filter(uid => isSeatEligible(freshP[uid])).length;
    const ineligible = ineligibleChancellorCandidates({
      lastPresidentUid: m.presidentUidLast,
      lastChancellorUid: m.chancellorUidLast,
      aliveCount,
    });
    if (!isSeatEligible(freshP[candidate]) || candidate === m.presidentUid || ineligible.has(candidate)) {
      console.warn(`[board] rejecting ineligible nominee ${candidate}, waiting for a legal one`);
      await update(metaRef, { chancellorCandidateUid: null });
      return;
    }
    if (!(await claim(`nominate-${entryRound}`))) return;
    done = true;
    if (typeof unsub === 'function') unsub();
    // Use the freshly-read roundId (== entryRound by the guard above), not
    // the possibly-stale render cache.
    const roundId = (m.roundId || 0) + 1;
    await update(metaRef, { roundId, phase: 'election' });
  });
}

function watchForVotes() {
  const roundId = currentMeta.roundId;
  const alive = alivePlayers();
  const castRef = ref(db, `games/${room}/votesCast/${roundId}`);
  let done = false;
  let unsub = null;
  unsub = onValue(castRef, async snap => {
    if (done) return;
    const cast = snap.val() || {};
    if (Object.keys(cast).length < alive.length) return;
    const m = await freshMeta();
    if (m.phase !== 'election' || (m.roundId || 0) !== roundId) return;
    // Recompute quorum from fresh players: seats may have died/retired or
    // been reclaimed mid-round since this watcher subscribed.
    const fp = await freshPlayers();
    const freshAlive = (m.playerOrder || []).filter(uid => isSeatEligible(fp[uid]));
    if (Object.keys(cast).length < freshAlive.length) return;
    const revealed = await get(ref(db, `games/${room}/votesRevealed/${roundId}`));
    if (revealed.val() === true) return;
    if (!(await claim(`election-${roundId}`))) return;
    done = true;
    if (typeof unsub === 'function') unsub();
    await set(ref(db, `games/${room}/votesRevealed/${roundId}`), true);
    const votesSnap = await get(ref(db, `games/${room}/votes/${roundId}`));
    const votes = votesSnap.val() || {};
    const jaCount = Object.values(votes).filter(v => v === 'ja').length;
    const majority = jaCount > freshAlive.length / 2;
    await resolveElection(majority, m, { ja: jaCount, total: freshAlive.length, votes });
  });
}

// Host escape hatch for a stuck vote (a phone that never ballots would wait
// forever). Missing ballots count as Nein. Single-flight via the same claim
// key as the normal path, so a raced auto-resolution wins exactly once.
async function forceResolveElection() {
  const m = await freshMeta();
  if (m.phase !== 'election') {
    console.warn('[board] force-resolve ignored: not in election');
    return;
  }
  const roundId = m.roundId;
  if (!(await claim(`election-${roundId}`))) {
    console.warn('[board] force-resolve ignored: election already claimed');
    return;
  }
  await set(ref(db, `games/${room}/votesRevealed/${roundId}`), true);
  const votesSnap = await get(ref(db, `games/${room}/votes/${roundId}`));
  const votes = votesSnap.val() || {};
  const fpForce = await freshPlayers();
  const aliveCount = (m.playerOrder || []).filter(uid => isSeatEligible(fpForce[uid])).length;
  const jaCount = Object.values(votes).filter(v => v === 'ja').length;
  await resolveElection(jaCount > aliveCount / 2, m, { ja: jaCount, total: aliveCount, votes });
}

async function resolveElection(majority, fresh, tally = {}) {
  // `fresh` is the meta snapshot re-read by the caller after the phase guard;
  // all arithmetic below uses it (never the render cache) so increments can't
  // be computed from stale state. Single-flight claims already serialize
  // writers, so fresh-read-modify-write is safe without transactions.
  const base = fresh || currentMeta;
  // Host juice: animated Ja/Nein tally before the outcome lands. View-only and
  // timeout-guarded — a failure here must never block the election.
  try {
    const nominee = currentPlayers[base.chancellorCandidateUid]?.name
      || (await freshPlayers())[base.chancellorCandidateUid]?.name || '';
    await Promise.race([
      showTallyCinematic({ ja: tally.ja || 0, total: tally.total || 0, passed: !!majority, nomineeName: nominee }),
      new Promise(res => setTimeout(res, TALLY_MS + 1200)),
    ]);
  } catch (_) { resetCinematic(); }
  if (!majority) {
    const tracker = (base.electionTracker || 0) + 1;
    if (tracker >= 3) {
      const win = await runChaos(base);
      if (win) return;
    } else {
      playSound('election-fail');
      narrate('narr_13');
      narrate(tracker === 1 ? 'narr_14' : 'narr_15');
      await update(metaRef, { electionTracker: tracker, chancellorCandidateUid: null });
    }
    advancePresidency(false).catch(e => console.warn('[board] advance failed:', e && e.message));
    return;
  }

  // Government elected.
  const chancellorUid = base.chancellorCandidateUid;
  const rolesSnap = await get(ref(db, `games/${room}/secret/roles`));
  const roles = rolesSnap.val() || {};
  const win = checkWin({
    liberalTrack: base.liberalTrack || 0,
    fascistTrack: base.fascistTrack || 0,
    electedChancellorUid: chancellorUid,
    roles,
  });
  if (win) return endGame(win);

  const draw = await takeTiles(3);
  playSound('election-pass');
  narrate('narr_12');
  await update(ref(db, `games/${room}`), {
    'meta/chancellorUid': chancellorUid,
    'meta/electionTracker': 0,
    [`secret/legislative/${base.roundId}/presidentDraw`]: draw,
    'meta/phase': 'legislative_president',
  });
}

function shuffleReshuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = randInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Chaos (frustrated populace): top deck tile auto-enacts, tracker resets,
// term limits forgotten. Shared by failed-election chaos and veto-at-tracker-3.
// Returns the win object (already applied via endGame), or null to continue.
// `fresh` is a post-guard meta snapshot from the caller; falls back to the
// render cache only when called without one.
async function runChaos(fresh) {
  const base = fresh || currentMeta;
  playSound('chaos');
  narrate('narr_17');
  narrate('narr_18');
  // Chaos flash overlay on the table
  const table = el('table');
  if (table) {
    table.classList.remove('chaos-flash');
    void table.offsetWidth; // reflow to restart animation
    table.classList.add('chaos-flash');
    setTimeout(() => table.classList.remove('chaos-flash'), 1100);
  }
  const drawn = await takeTiles(1);
  const tile = drawn[0];
  const trackField = tile === 'liberal' ? 'liberalTrack' : 'fascistTrack';
  const newVal = (base[trackField] || 0) + 1;
  const fascistNow = trackField === 'fascistTrack' ? newVal : (base.fascistTrack || 0);
  await update(ref(db, `games/${room}`), {
    [`meta/${trackField}`]: newVal,
    'meta/electionTracker': 0,
    'meta/chancellorCandidateUid': null,
    'meta/presidentUidLast': null,
    'meta/chancellorUidLast': null,
    'meta/vetoUnlocked': vetoUnlocked(fascistNow),
  });
  narrateEnactment(tile, newVal);
  narrate('narr_19');
  // Host juice: chaos cinematic (view-only, timeout-guarded).
  try {
    await Promise.race([
      playEnactCinematic(tile, newVal, { chaos: true }),
      new Promise(res => setTimeout(res, CINEMATIC_MS + 1200)),
    ]);
  } catch (_) { resetCinematic(); }
  const win = checkWin({ liberalTrack: trackField === 'liberalTrack' ? newVal : base.liberalTrack, fascistTrack: fascistNow });
  if (win) {
    await endGame(win);
    return win;
  }
  return null;
}

// Draw n tiles, reshuffling the discard pile in when the deck runs short.
// Returns the drawn tiles and persists the new deck/discard. Used for every
// consuming draw (legislative, chaos) so an empty deck can never enact
// `undefined` as a phantom fascist policy.
async function takeTiles(n) {
  const gameDbRef = ref(db, `games/${room}`);
  let deck = (await get(ref(db, `games/${room}/secret/deck`))).val() || [];
  if (!Array.isArray(deck)) deck = Object.values(deck);
  let discard = (await get(ref(db, `games/${room}/secret/discard`))).val() || [];
  if (!Array.isArray(discard)) discard = Object.values(discard);
  if (deck.length < n && discard.length) {
    deck = shuffleReshuffle(deck.concat(discard));
    discard = [];
  }
  const tiles = deck.slice(0, n);
  await update(gameDbRef, {
    'secret/deck': deck.slice(n),
    'secret/discard': discard,
  });
  // Tile-conservation self-check: deck + discard + enacted + in-hand must
  // always equal the 17 physical tiles. A mismatch means a duplicate deal
  // orphaned tiles (see freshMeta replay guards) — loud in console instead
  // of a silent wedge.
  const enacted = (currentMeta.liberalTrack || 0) + (currentMeta.fascistTrack || 0);
  if (deck.slice(n).length + discard.length + enacted + tiles.length !== 17) {
    console.warn(`[tiles] conservation check failed: deck=${deck.slice(n).length} discard=${discard.length} enacted=${enacted} inhand=${tiles.length} (want 17 total)`);
  }
  return tiles;
}

// End-of-session reshuffle (official rule): whenever fewer than 3 tiles
// remain in the deck after a legislative session, shuffle the discard pile
// back in. Call this after every enact and every agreed veto, so the deck
// is always >= 3 and Policy Peek shows the honest next three tiles.
async function reshuffleIfShort() {
  const deckSnap = await get(ref(db, `games/${room}/secret/deck`));
  let deck = deckSnap.val() || [];
  if (!Array.isArray(deck)) deck = Object.values(deck);
  if (deck.length >= 3) return;
  const discSnap = await get(ref(db, `games/${room}/secret/discard`));
  let discard = discSnap.val() || [];
  if (!Array.isArray(discard)) discard = Object.values(discard);
  if (!discard.length) return;
  await update(ref(db, `games/${room}`), {
    'secret/deck': shuffleReshuffle(deck.concat(discard)),
    'secret/discard': [],
  });
}

async function nextAliveAfter(uid, orderOverride, playersOverride) {
  const order = orderOverride || currentMeta.playerOrder || [];
  if (!order.length) return null;
  const players = playersOverride || currentPlayers;
  let idx = order.indexOf(uid);
  for (let i = 0; i < order.length; i++) {
    idx = (idx + 1) % order.length;
    const cand = order[idx];
    if (isSeatEligible(players[cand])) return cand;
  }
  return null;
}

// snapshotLasts=false is for FAILED elections: per the rules, term limits
// track the last ELECTED government, so a rejected nomination must rotate
// the presidency without touching presidentUidLast/chancellorUidLast.
// Agreed vetos (no government elected) use false as well.
async function advancePresidency(snapshotLasts = true) {
  // Re-read fresh state: cached currentMeta/currentPlayers can be stale
  // across concurrent execution/reclaim updates, which would rotate to the
  // wrong president or snapshot the wrong lasts.
  const m = await freshMeta();
  const players = await freshPlayers();
  const order = m.playerOrder || [];
  // If the term just ended was a special-elected presidency, return to the
  // stored next-in-line (left of the President who enacted the Special Election).
  if (m.specialElectionReturnUid) {
    let next = m.specialElectionReturnUid;
    if (!isSeatEligible(players[next])) {
      next = await nextAliveAfter(next, order, players) || await nextAliveAfter(m.presidentUid, order, players);
    }
    const updates = {
      presidentUid: next,
      specialElectionReturnUid: null,
      chancellorCandidateUid: null,
      chancellorUid: null,
      phase: 'nomination',
    };
    if (snapshotLasts) {
      updates.presidentUidLast = m.presidentUid;
      updates.chancellorUidLast = m.chancellorUid || null;
    }
    await update(metaRef, updates);
    return;
  }
  const currentIdx = order.indexOf(m.presidentUid);
  let nextIdx = currentIdx;
  let next = null;
  for (let i = 0; i < order.length; i++) {
    nextIdx = (nextIdx + 1) % order.length;
    next = order[nextIdx];
    if (isSeatEligible(players[next])) break;
    next = null;
  }
  if (!next) {
    console.warn('[board] advancePresidency: no eligible successor, staying put');
    return;
  }
  const updates = {
    presidentUid: next,
    chancellorCandidateUid: null,
    chancellorUid: null,
    phase: 'nomination',
  };
  if (snapshotLasts) {
    updates.presidentUidLast = m.presidentUid;
    updates.chancellorUidLast = m.chancellorUid || null;
  }
  await update(metaRef, updates);
}

// Phones send an index; the board resolves it against the hand it dealt and
// performs the discard itself. Tile values from clients are never trusted —
// a forged hand or enactment can't survive this resolution.
const isTile = t => t === 'liberal' || t === 'fascist';
const asTiles = v => (Array.isArray(v) ? v : Object.values(v || {}));

async function appendToDiscard(extra) {
  const discSnap = await get(ref(db, `games/${room}/secret/discard`));
  const discard = asTiles(discSnap.val()).concat(extra);
  await update(ref(db, `games/${room}`), { 'secret/discard': discard });
}

// President's discard choice: resolve presidentDiscardIdx against the
// presidentDraw the board dealt, then write chancellorHand + discard.
// idx === -1 is the short-draw pass-through (<= 1 tile, nothing to choose).
function watchForPresidentChoice() {
  const roundId = currentMeta.roundId;
  let done = false;
  let unsub = null;
  unsub = onValue(ref(db, `games/${room}/secret/legislative/${roundId}/presidentDiscardIdx`), async snap => {
    if (done) return;
    const idx = snap.val();
    if (idx === null || idx === undefined) return;
    const m = await freshMeta();
    if (m.phase !== 'legislative_president' || (m.roundId || 0) !== roundId) return;
    // Validate BEFORE claiming so a corrupt/out-of-range choice clears the
    // idx node and stays subscribed for a legal retry instead of wedging
    // the round with done=true and no retry path.
    const drawSnap = await get(ref(db, `games/${room}/secret/legislative/${roundId}/presidentDraw`));
    const draw = asTiles(drawSnap.val());
    if (!draw.length || !draw.every(isTile)) {
      console.warn(`[board] round ${roundId}: presidentDraw missing/corrupt, clearing choice for retry`);
      await update(ref(db, `games/${room}`), { [`secret/legislative/${roundId}/presidentDiscardIdx`]: null });
      return;
    }
    if (idx === -1) {
      if (draw.length > 1) {
        console.warn(`[board] round ${roundId}: pass-through with ${draw.length} tiles, clearing choice`);
        await update(ref(db, `games/${room}`), { [`secret/legislative/${roundId}/presidentDiscardIdx`]: null });
        return;
      }
      if (!(await claim(`preschoice-${roundId}`))) return;
      done = true;
      if (typeof unsub === 'function') unsub();
      await update(ref(db, `games/${room}`), {
        [`secret/legislative/${roundId}/chancellorHand`]: draw,
      });
      return;
    }
    if (!Number.isInteger(idx) || idx < 0 || idx >= draw.length) {
      console.warn(`[board] round ${roundId}: presidentDiscardIdx ${idx} out of range, clearing choice`);
      await update(ref(db, `games/${room}`), { [`secret/legislative/${roundId}/presidentDiscardIdx`]: null });
      return;
    }
    if (!(await claim(`preschoice-${roundId}`))) return;
    done = true;
    if (typeof unsub === 'function') unsub();
    const remaining = draw.filter((_, i) => i !== idx);
    await appendToDiscard([draw[idx]]);
    await update(ref(db, `games/${room}`), {
      [`secret/legislative/${roundId}/chancellorHand`]: remaining,
    });
  });
}

function watchForPresidentDiscard() {
  const roundId = currentMeta.roundId;
  let done = false;
  let unsub = null;
  unsub = onValue(ref(db, `games/${room}/secret/legislative/${roundId}/chancellorHand`), async snap => {
    if (done) return;
    if (!snap.val()) return;
    const m = await freshMeta();
    if (m.phase !== 'legislative_president' || (m.roundId || 0) !== roundId) return;
    done = true;
    if (typeof unsub === 'function') unsub();
    update(metaRef, { phase: 'legislative_chancellor' }).catch(e => console.warn('[board] phase flip failed:', e && e.message));
  });
}

function watchForChancellorEnact() {
  const roundId = currentMeta.roundId;
  let done = false;
  let unsub = null;
  unsub = onValue(ref(db, `games/${room}/secret/legislative/${roundId}/chancellorEnactIdx`), async snap => {
    if (done) return;
    const idx = snap.val();
    if (idx === null || idx === undefined) return;
    const m = await freshMeta();
    if (m.phase !== 'legislative_chancellor' || (m.roundId || 0) !== roundId) return;
    // Resolve the index against the hand the board dealt — the Chancellor's
    // client never writes tiles directly, so a forged enactment is impossible.
    // Validate before claiming so an invalid idx clears and stays subscribed.
    const handSnap = await get(ref(db, `games/${room}/secret/legislative/${roundId}/chancellorHand`));
    const hand = asTiles(handSnap.val());
    if (!Number.isInteger(idx) || idx < 0 || idx >= hand.length || !hand.every(isTile)) {
      console.warn(`[board] round ${roundId}: chancellorEnactIdx ${idx} invalid for hand of ${hand.length}, clearing for retry`);
      await update(ref(db, `games/${room}`), { [`secret/legislative/${roundId}/chancellorEnactIdx`]: null });
      return;
    }
    if (!(await claim(`enact-${roundId}`))) return;
    done = true;
    if (typeof unsub === 'function') unsub();
    const tile = hand[idx];
    await appendToDiscard(hand.filter((_, i) => i !== idx));
    playSound(tile === 'liberal' ? 'enact-liberal' : 'enact-fascist');
    // Board glow flash on enactment
    const boardEl = tile === 'liberal' ? el('liberalBoard') : el('fascistBoard');
    if (boardEl) {
      boardEl.classList.remove('just-enacted-liberal', 'just-enacted-fascist');
      void boardEl.offsetWidth;
      boardEl.classList.add(tile === 'liberal' ? 'just-enacted-liberal' : 'just-enacted-fascist');
      setTimeout(() => boardEl.classList.remove('just-enacted-liberal', 'just-enacted-fascist'), 700);
    }
    const field = tile === 'liberal' ? 'liberalTrack' : 'fascistTrack';
    const newVal = (m[field] || 0) + 1;
    narrateEnactment(tile, newVal);
    await update(ref(db, `games/${room}`), {
      [`secret/legislative/${roundId}/enactedTile`]: tile,
    });
    // Veto unlocks permanently once the 5th fascist policy is enacted.
    const unlock = field === 'fascistTrack' && vetoUnlocked(newVal);
    await update(metaRef, { [field]: newVal, ...(unlock ? { vetoUnlocked: true } : {}) });
    if (unlock) {
      narrate('narr_42');
      if ((m.roundId || 0) <= 1) narrate('narr_43');
    }
    // End-of-session reshuffle so the deck stays >= 3 (keeps Policy Peek honest).
    await reshuffleIfShort().catch(e => console.warn('[board] reshuffle failed:', e && e.message));

    // Host juice: full enactment cinematic (view-only, timeout-guarded) before
    // the game advances, so the room actually sees the tile land.
    try {
      const upcomingPower = field === 'fascistTrack'
        ? executivePowerFor((m.playerOrder || []).length, newVal) : null;
      const powerLabel = unlock ? 'Veto power unlocked'
        : upcomingPower ? POWER_LABELS[upcomingPower] : null;
      await Promise.race([
        playEnactCinematic(tile, newVal, { powerLabel }),
        new Promise(res => setTimeout(res, CINEMATIC_MS + 1200)),
      ]);
    } catch (_) { resetCinematic(); }

    const win = checkWin({
      liberalTrack: field === 'liberalTrack' ? newVal : m.liberalTrack,
      fascistTrack: field === 'fascistTrack' ? newVal : m.fascistTrack,
    });
    if (win) return endGame(win);

    if (field === 'fascistTrack') {
      const power = executivePowerFor((m.playerOrder || []).length, newVal);
      if (power) {
        await update(metaRef, { phase: 'executive_action', pendingPower: power });
        return;
      }
    }
    advancePresidency().catch(e => console.warn('[board] advance failed:', e && e.message));
  });
}

// Veto (official rule, unlocked at 5 fascist policies): the Chancellor asks,
// the President consents or refuses. Agreed → both tiles discarded, tracker
// +1 (chaos at 3, shared helper), presidency passes. Refused → request
// cleared, Chancellor must enact normally.
function watchForVeto() {
  const roundId = currentMeta.roundId;
  let done = false;
  let unsub = null;
  unsub = onValue(ref(db, `games/${room}/secret/legislative/${roundId}/vetoDecision`), async snap => {
    if (done) return;
    const decision = snap.val();
    if (!decision) return;
    const m = await freshMeta();
    if (m.phase !== 'legislative_chancellor' || (m.roundId || 0) !== roundId) return;
    if (decision === 'refused') {
      // Refused: stay subscribed (a second request must still be answered),
      // but record vetoUsed so the Chancellor's button never comes back —
      // per the rules, a refused veto forces a normal enactment.
      // No claim taken here, so a replayed 'refused' is idempotent.
      playSound('vote-cast');
      narrate('narr_46');
      await update(ref(db, `games/${room}`), {
        [`secret/legislative/${roundId}/vetoRequested`]: null,
        [`secret/legislative/${roundId}/vetoDecision`]: null,
        [`secret/legislative/${roundId}/vetoUsed`]: true,
      });
      return;
    }
    if (decision !== 'agreed') return;
    // Validate the hand BEFORE claiming: an invalid hand must clear the
    // decision and stay subscribed so a legal retry can proceed (claiming
    // first would wedge the round with done=true and no retry path).
    const handSnap = await get(ref(db, `games/${room}/secret/legislative/${roundId}/chancellorHand`));
    const handVal = handSnap.val();
    const tiles = asTiles(handVal);
    if (tiles.length !== 2 || !tiles.every(isTile)) {
      console.warn(`[board] round ${roundId}: veto with invalid hand, clearing decision for retry`);
      await update(ref(db, `games/${room}`), { [`secret/legislative/${roundId}/vetoDecision`]: null });
      return;
    }
    if (!(await claim(`veto-${roundId}`))) return;
    // Backstop: a veto answered after a refusal (forged re-request — the
    // rules already block the write, but never trust the client alone).
    const usedSnap = await get(ref(db, `games/${room}/secret/legislative/${roundId}/vetoUsed`));
    if (usedSnap.val() === true) {
      console.warn(`[board] round ${roundId}: ignoring veto decision after refusal`);
      await releaseClaim(`veto-${roundId}`);
      return;
    }
    done = true;
    if (typeof unsub === 'function') unsub();
    playSound('election-fail'); // agreed veto: both tiles dead, tracker advances
    narrate('narr_45');
    const discSnap = await get(ref(db, `games/${room}/secret/discard`));
    const discVal = discSnap.val();
    const discard = (Array.isArray(discVal) ? discVal : Object.values(discVal || {})).concat(tiles);
    const tracker = (m.electionTracker || 0) + 1;
    await update(ref(db, `games/${room}`), { 'secret/discard': discard });
    await reshuffleIfShort().catch(e => console.warn('[board] reshuffle failed:', e && e.message));
    // Host juice: veto drama before the tracker/chaos lands.
    try {
      await Promise.race([
        showVetoCinematic(tracker),
        new Promise(res => setTimeout(res, 2700)),
      ]);
    } catch (_) { resetCinematic(); }
    if (tracker >= 3) {
      const win = await runChaos(m);
      if (win) return;
      advancePresidency(false).catch(e => console.warn('[board] advance failed:', e && e.message));
      return;
    }
    await update(metaRef, { electionTracker: tracker });
    // Agreed veto elects no government, so term limits must NOT snapshot
    // (same as a failed election) — otherwise the next nomination
    // over-blocks legal candidates.
    advancePresidency(false).catch(e => console.warn('[board] advance failed:', e && e.message));
  });
}

async function watchForExecutiveAction() {

  const power = currentMeta.pendingPower;
  const roundId = currentMeta.roundId;
  if (power === 'execution') {
    let done = false;
    let unsub = null;
    unsub = onValue(ref(db, `games/${room}/meta/executionTarget`), async snap => {
      if (done) return;
      const target = snap.val();
      if (!target) return;
      const m = await freshMeta();
      if (m.phase !== 'executive_action' || m.pendingPower !== 'execution') return;
      // Server-side target validation: phones filter the list, but a stale or
      // forged client can send self/dead/retired/unknown. Reject and stay subscribed.
      // (Validate before claiming, so the retry isn't blocked by our claim.)
      const playersExec = await freshPlayers();
      if (!isSeatEligible(playersExec[target]) || target === m.presidentUid) {
        console.warn(`[board] rejecting invalid execution target ${target}, waiting for a legal one`);
        await update(metaRef, { executionTarget: null });
        return;
      }
      if (!(await claim(`power-${roundId}`))) return;
      done = true;
      if (typeof unsub === 'function') unsub();
      const rolesSnap = await get(ref(db, `games/${room}/secret/roles`));
      const roles = rolesSnap.val() || {};
      const victimName = (playersExec[target] && playersExec[target].name) || '?';
      const hitlerDown = roles[target] === 'hitler';
      // Host juice: murder cinematic (view-only, timeout-guarded). The
      // alive=false write fires ON THE SHOT via onShot so cause = effect.
      try {
        await Promise.race([
          playExecutionCinematic(target, {
            isHitler: hitlerDown,
            victimName,
            onShot: () => {
              update(ref(db, `games/${room}`), {
                [`players/${target}/alive`]: false,
                'meta/executionTarget': null,
                'meta/pendingPower': null,
              }).catch(e => console.warn('[board] exec write failed:', e && e.message));
            },
          }),
          new Promise(res => setTimeout(res, 5000)),
        ]);
      } catch (_) {
        execState = null;
        try { document.body.classList.remove('exec-active'); } catch (_) {}
      }
      // Backstop: if onShot's write never landed (offline blip), force it now
      // so the game can never continue with a living victim.
      try {
        const checkAlive = (await get(ref(db, `games/${room}/players/${target}/alive`))).val();
        if (checkAlive !== false) {
          await update(ref(db, `games/${room}`), {
            [`players/${target}/alive`]: false,
            'meta/executionTarget': null,
            'meta/pendingPower': null,
          });
        }
      } catch (e) { console.warn('[board] exec backstop failed:', e && e.message); }
      paintSeats();
      const win = checkExecutionWin({ executedUid: target, roles });
      if (win) return endGame(win);
      // Alternate the two execution outros so repeat games don't sound canned.
      narrate((roundId || 0) % 2 === 0 ? 'narr_40' : 'narr_41');
      advancePresidency().catch(e => console.warn('[board] advance failed:', e && e.message));
    });
  } else if (power === 'investigate_loyalty') {
    let done = false;
    let unsub = null;
    unsub = onValue(ref(db, `games/${room}/meta/investigateTarget`), async snap => {
      if (done) return;
      const target = snap.val();
      if (!target) return;
      const m = await freshMeta();
      if (m.phase !== 'executive_action' || m.pendingPower !== 'investigate_loyalty') return;
      // Official rule: no self-investigation, living non-retired players only, never twice.
      const playersInv = await freshPlayers();
      const alreadyInvestigated = m.investigatedUids && m.investigatedUids[target] === true;
      if (!isSeatEligible(playersInv[target]) || target === m.presidentUid || alreadyInvestigated) {
        console.warn(`[board] rejecting invalid investigate target ${target}, waiting for a legal one`);
        await update(metaRef, { investigateTarget: null });
        return;
      }
      if (!(await claim(`power-${roundId}`))) return;
      done = true;
      if (typeof unsub === 'function') unsub();
      const rolesSnap = await get(ref(db, `games/${room}/secret/roles`));
      const roles = rolesSnap.val() || {};
      // Hitler counts as fascist for this power.
      const result = roles[target] === 'liberal' ? 'liberal' : 'fascist';
      playSound('reveal');
      narrate('narr_33');
      narrate('narr_38');
      await update(ref(db, `games/${room}`), {
        [`secret/executive/${roundId}/investigateResult`]: result,
        [`meta/investigatedUids/${target}`]: true,
        'meta/investigateTarget': null,
        'meta/pendingPower': null,
      });
      advancePresidency().catch(e => console.warn('[board] advance failed:', e && e.message));
    });
  } else if (power === 'special_election') {
    let done = false;
    let unsub = null;
    unsub = onValue(ref(db, `games/${room}/meta/specialElectionTarget`), async snap => {
      if (done) return;
      const target = snap.val();
      if (!target) return;
      const m = await freshMeta();
      if (m.phase !== 'executive_action' || m.pendingPower !== 'special_election') return;
      // Official rule: any other living non-retired player (never self, never dead/retired).
      const playersSpec = await freshPlayers();
      if (!isSeatEligible(playersSpec[target]) || target === m.presidentUid) {
        console.warn(`[board] rejecting invalid special-election target ${target}, waiting for a legal one`);
        await update(metaRef, { specialElectionTarget: null });
        return;
      }
      if (!(await claim(`power-${roundId}`))) return;
      done = true;
      if (typeof unsub === 'function') unsub();
      const enacting = m.presidentUid;
      playSound('reveal'); // special election called
      narrate('narr_39');
      const orderSpec = m.playerOrder || [];
      const updates = {
        'meta/presidentUid': target,
        'meta/presidentUidLast': enacting,
        // The outgoing Chancellor is term-limited during the special round,
        // and clearing chancellorUid revokes their legislative read access.
        'meta/chancellorUidLast': m.chancellorUid || null,
        'meta/chancellorUid': null,
        'meta/chancellorCandidateUid': null,
        'meta/specialElectionTarget': null,
        'meta/pendingPower': null,
        'meta/phase': 'nomination',
      };
      // Remember where the normal rotation resumes. If already inside a
      // special term (nested specials), keep the outer return pointer.
      if (!m.specialElectionReturnUid) {
        updates['meta/specialElectionReturnUid'] = await nextAliveAfter(enacting, orderSpec, playersSpec);
      }
      await update(ref(db, `games/${room}`), updates);
    });
  } else if (power === 'policy_peek') {
    // Copy top 3 tiles for the President's eyes only, then wait for their
    // Done tap (policyPeekSeen) before advancing. Reshuffle first so the
    // peek is exactly what the next draw will deal — no merge, no lie,
    // never a short peek.
    await reshuffleIfShort().catch(e => console.warn('[board] pre-peek reshuffle failed:', e && e.message));
    let deck = (await get(ref(db, `games/${room}/secret/deck`))).val() || [];
    if (!Array.isArray(deck)) deck = Object.values(deck);
    deck = deck.filter(isTile);
    if (deck.length < 3) {
      console.warn(`[board] round ${roundId}: deck short for peek (${deck.length}), reshuffling again`);
      await reshuffleIfShort().catch(e => console.warn('[board] pre-peek reshuffle failed:', e && e.message));
      let retry = (await get(ref(db, `games/${room}/secret/deck`))).val() || [];
      if (!Array.isArray(retry)) retry = Object.values(retry);
      deck = retry.filter(isTile);
    }
    const peek = deck.slice(0, 3);
    playSound('tile-draw');
    await set(ref(db, `games/${room}/secret/executive/${roundId}/policyPeek`), peek);
    let peekDone = false;
    let unsub = null;
    unsub = onValue(ref(db, `games/${room}/secret/executive/${roundId}/policyPeekSeen`), async snap => {
      if (peekDone) return;
      if (snap.val() !== true) return;
      const m = await freshMeta();
      if (m.phase !== 'executive_action' || m.pendingPower !== 'policy_peek') return;
      if (!(await claim(`power-${roundId}`))) return;
      peekDone = true;
      if (typeof unsub === 'function') unsub();
      narrate('narr_37');
      await update(ref(db, `games/${room}`), { 'meta/pendingPower': null });
      advancePresidency().catch(e => console.warn('[board] advance failed:', e && e.message));
    });
  }
}

// ---------------------------------------------------------------------------
// Seat reclaim (reconnect PIN).
// A phone whose browser storage was cleared (or a new device) gets a fresh
// uid with no standing. It files reclaimRequests/{newUid} = {name, pin};
// the host — the only reader of secret/reconnectPins — matches PIN + name
// to an old seat and migrates old uid -> new uid in one host-authorized
// update. Same conventions as the phase watchers: single-flight via
// claim(), re-validate against fresh reads, replay-safe. Mid-action seats
// (President/Chancellor/nominee) need no special-casing: every gate reads
// through meta, so the swapped uid just resumes once the update lands.
// ---------------------------------------------------------------------------
const reclaimInflight = new Set();

function watchForReclaimRequests() {
  onValue(ref(db, `games/${room}/reclaimRequests`), snap => {
    const reqs = snap.val() || {};
    for (const [newUid, req] of Object.entries(reqs)) {
      if (!req || req.status || reclaimInflight.has(newUid)) continue;
      reclaimInflight.add(newUid);
      handleReclaim(newUid, req).finally(() => reclaimInflight.delete(newUid));
    }
  });
}

async function handleReclaim(newUid, req) {
  // Single-flight across board tabs/refreshes; losers abort silently.
  if (!(await claim(`reclaim-${newUid}`))) return;
  // Release the claim on EVERY exit (success or retryable failure): the
  // request node stays pending with a terminal status sweep, so a held
  // claim would block the idempotent retry path on the next watcher fire.
  try {
    const m = await freshMeta();
    if (m.hostUid !== myUid) {
      await releaseClaim(`reclaim-${newUid}`);
      return;
    }
    // Idempotent path: this uid already holds a seat (a previous migration
    // landed) — approve again so the requester can observe it and move on.
    const orderNow = Array.isArray(m.playerOrder) ? m.playerOrder : Object.values(m.playerOrder || {});
    if (orderNow.includes(newUid)) {
      await approveReclaim(newUid);
      await releaseClaim(`reclaim-${newUid}`);
      return;
    }
    const gameRoot = ref(db, `games/${room}`);
    const roundId = m.roundId;
    const [pinsSnap, playersSnap, rolesSnap, matesSnap, votesSnap, votesCastSnap, revealedSnap] = await Promise.all([
      get(ref(db, `games/${room}/secret/reconnectPins`)),
      get(ref(db, `games/${room}/players`)),
      get(ref(db, `games/${room}/secret/roles`)),
      get(ref(db, `games/${room}/secret/knownTeammates`)),
      get(ref(db, `games/${room}/votes`)),
      get(ref(db, `games/${room}/votesCast`)),
      // Only the open round's ballots can still move; settled rounds are
      // history. (roundId is known from freshMeta above.)
      get(ref(db, `games/${room}/votesRevealed/${roundId}`)),
    ]);
    const pins = pinsSnap.val() || {};
    const players = playersSnap.val() || {};
    // This uid already carries a PIN (migration landed, stale request).
    if (pins[newUid] !== undefined && pins[newUid] !== null) {
      await approveReclaim(newUid);
      await releaseClaim(`reclaim-${newUid}`);
      return;
    }
    // Match on BOTH pin and name: 4 digits alone would collide too easily.
    // Retired seats can't be reclaimed twice (first-come wins); the
    // requester itself is never a candidate. Zero or ambiguous matches
    // reject — never guess a seat.
    const norm = s => String(s || '').trim().toLowerCase();
    const candidates = Object.keys(pins).filter(oldUid => {
      if (oldUid === newUid) return false;
      if (String(pins[oldUid]) !== String(req.pin)) return false;
      const p = players[oldUid];
      if (!p || p.retired === true) return false;
      return norm(p.name) === norm(req.name);
    });
    if (candidates.length !== 1) {
      await rejectReclaim(newUid);
      await releaseClaim(`reclaim-${newUid}`);
      return;
    }
    const oldUid = candidates[0];

    const updates = {};
    // Secrets move to fresh nodes, so the existing "!data.exists()"
    // host-write rules already permit the copies — no relaxation needed.
    const roles = rolesSnap.val() || {};
    if (roles[oldUid] !== undefined && roles[oldUid] !== null) {
      updates[`secret/roles/${newUid}`] = roles[oldUid];
    }
    const mates = matesSnap.val() || {};
    if (mates[oldUid] !== undefined && mates[oldUid] !== null) {
      updates[`secret/knownTeammates/${newUid}`] = mates[oldUid];
    }
    // Other players' stored teammate lists are display-only snapshots
    // ({uid, name}, never looked up by uid), so stale entries there are
    // harmless and intentionally left alone.
    updates[`secret/reconnectPins/${newUid}`] = pins[oldUid];
    updates[`secret/reconnectPins/${oldUid}`] = null;
    // A dead seat stays dead (alive is host-writable already). A living
    // seat needs nothing: the client's own players node carries no alive
    // field, and missing counts as alive.
    if (players[oldUid] && players[oldUid].alive === false) {
      updates[`players/${newUid}/alive`] = false;
    }
    // Night-reveal ack follows the seat too: a reconnect during the opening
    // night must not lose an already-tapped reveal (or resurrect a pending one).
    if (players[oldUid] && players[oldUid].roleSeen === true) {
      updates[`players/${newUid}/roleSeen`] = true;
    }
    // Retire the old node so the board stops rendering it as a live seat
    // (name/connected are self-write-only, hence the dedicated flag).
    updates[`players/${oldUid}/retired`] = true;
    // Every meta reference follows the seat to the new uid.
    for (const f of ['presidentUid', 'chancellorUid', 'presidentUidLast', 'chancellorUidLast',
      'chancellorCandidateUid', 'specialElectionReturnUid',
      'executionTarget', 'investigateTarget', 'specialElectionTarget']) {
      if (m[f] === oldUid) updates[`meta/${f}`] = newUid;
    }
    const order = m.playerOrder;
    if (Array.isArray(order)) {
      if (order.includes(oldUid)) updates['meta/playerOrder'] = order.map(u => u === oldUid ? newUid : u);
    } else if (order && typeof order === 'object') {
      const copy = { ...order };
      let touched = false;
      for (const k of Object.keys(copy)) {
        if (copy[k] === oldUid) { copy[k] = newUid; touched = true; }
      }
      if (touched) updates['meta/playerOrder'] = copy;
    }
    if (m.investigatedUids && m.investigatedUids[oldUid] === true) {
      updates[`meta/investigatedUids/${oldUid}`] = null;
      updates[`meta/investigatedUids/${newUid}`] = true;
    }
    // In-flight ballots move too, so a mid-election reconnect neither loses
    // the seat's vote nor breaks the quorum count — but only for the
    // current, unrevealed round. Earlier rounds are settled history; only
    // the open round's quorum math still reads these keys. The stale oldUid
    // keys are nulled in the same update: left behind, the orphaned ballot
    // would double-count in the revealed totals and the orphaned votesCast
    // entry would push the quorum numerator toward a phantom seat.
    if (roundId !== null && roundId !== undefined && revealedSnap.val() !== true) {
      const ballots = (votesSnap.val() || {})[roundId] || {};
      if (ballots[oldUid] !== undefined && ballots[oldUid] !== null) {
        if (!ballots[newUid]) updates[`votes/${roundId}/${newUid}`] = ballots[oldUid];
        updates[`votes/${roundId}/${oldUid}`] = null;
      }
      const cast = (votesCastSnap.val() || {})[roundId] || {};
      if (cast[oldUid] === true) {
        if (!cast[newUid]) updates[`votesCast/${roundId}/${newUid}`] = true;
        updates[`votesCast/${roundId}/${oldUid}`] = null;
      }
    }
    // Approve in the same update, once everything else has landed. The
    // phone deletes its own node on receipt (this sweep is the backstop),
    // so approval stays observable even if it blinks past offline.
    updates[`reclaimRequests/${newUid}/status`] = 'approved';
    await update(gameRoot, updates);
    await releaseClaim(`reclaim-${newUid}`);
    sweepReclaim(newUid, 'approved');
  } catch (e) {
    // Transient read/write failure: release the claim so a later watcher
    // fire can retry, and leave the request pending (never dangling — the
    // next fire picks it up again). Only wrong/ambiguous codes reject.
    console.warn(`[board] reclaim ${newUid} failed, releasing claim:`, e && e.message);
    try {
      await update(ref(db, `games/${room}`), { [`secret/claims/reclaim-${newUid}`]: null });
    } catch (_) {}
  }
}

// Wrong code (or ambiguous match): mark rejected so the requester sees a
// clear error instead of hanging. The phone deletes its own node on
// receipt (write-once allows create-or-delete); the sweep below is the
// backstop for phones that went away before seeing it.
async function rejectReclaim(newUid) {
  await update(ref(db, `games/${room}`), { [`reclaimRequests/${newUid}/status`]: 'rejected' });
  sweepReclaim(newUid, 'rejected');
}

// Approved requests use the same observable-status protocol (the phone
// deletes its node on receipt). Sweep either terminal status after a grace
// period so stale nodes can't accumulate if the phone went away.
async function approveReclaim(newUid) {
  await update(ref(db, `games/${room}`), { [`reclaimRequests/${newUid}/status`]: 'approved' });
  sweepReclaim(newUid, 'approved');
}

function sweepReclaim(newUid, status) {
  setTimeout(async () => {
    try {
      const cur = (await get(ref(db, `games/${room}/reclaimRequests/${newUid}/status`))).val();
      if (cur === status) {
        await update(ref(db, `games/${room}`), { [`reclaimRequests/${newUid}`]: null });
      }
    } catch (_) {}
  }, 60000);
}

async function endGame(win) {
  playSound(win.winner === 'liberal' ? 'win-liberal' : 'win-fascist');
  if (win.reason === 'five_liberal_policies') narrate('narr_47');
  else if (win.reason === 'six_fascist_policies') narrate('narr_48');
  else if (win.reason === 'hitler_elected_chancellor') narrate('narr_49');
  else if (win.reason === 'hitler_executed') narrate('narr_50');
  narrate('narr_51');
  try { showWinTakeover(win.winner, win.reason); } catch (_) {}
  await update(metaRef, { winner: win.winner, winReason: win.reason, phase: 'gameover' });
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------
function render() {
  const phase = currentMeta.phase;
  // Fit-to-screen layout: compact header + overlays apply only in-game, so
  // the lobby keeps its roomy QR/join layout.
  try {
    document.body.classList.toggle('in-game', !!phase && phase !== 'lobby');
  } catch (_) {}
  const phaseNames = {
    lobby: '\uD83C\uDFAE Lobby',
    night: '\uD83C\uDF19 Night \u2014 reveal your role',
    nomination: '\uD83C\uDFAD Nomination',
    election: '\uD83D\uDDF3\uFE0F Election',
    legislative_president: '\uD83D\uDCDC Legislation \u2014 President',
    legislative_chancellor: '\uD83D\uDCDC Legislation \u2014 Chancellor',
    executive_action: '\u26A1 Executive Action',
    gameover: '\uD83C\uDFC6 Game Over',
  };
  el('phaseLabel').textContent = phase === 'night' && nightTotal
    ? `🌙 Night — ${nightAcked}/${nightTotal} revealed`
    : (phaseNames[phase] || phase || '');

  el('lobbyPanel').style.display = phase === 'lobby' ? 'block' : 'none';
  // NOTE: gamePanel's display is owned by CSS (#gamePanel is the flex column
  // that holds the stage). Never set 'block' here — an inline block would
  // override that flex context and collapse the stage viewport fitStage()
  // measures.
  el('gamePanel').style.display = phase && phase !== 'lobby' ? '' : 'none';

  if (phase === 'lobby') {
    const names = Object.values(currentPlayers).filter(p => p && p.retired !== true).map(p => p.name);
    el('playerCount').textContent = names.length;
    el('playerNames').textContent = names.join(', ');
    el('startBtn').disabled = names.length < 5 || names.length > 10;
    return;
  }

  paintBoardOverlays();
  watchRoundExtras();
  paintSeats();
  paintPiles();

  // Show the official Fascist board matching the player-count bracket
  // (same brackets as the executive-power table in game-logic.js).
  const order = currentMeta.playerOrder || [];
  const playerCount = order.length || Object.keys(currentPlayers).length;
  const fascistArt = el('fascistBoardArt');
  const fascistLabel = el('fascistBoardLabel');
  if (fascistArt) {
    const variant = playerCount >= 9 ? '910' : playerCount >= 7 ? '78' : '56';
    const expected = `img/board-fascist-${variant}.png`;
    if (fascistArt.getAttribute('src') !== expected) fascistArt.setAttribute('src', expected);
  }
  if (fascistLabel) {
    fascistLabel.textContent = playerCount >= 9 ? '9–10 players' : playerCount >= 7 ? '7–8 players' : '5–6 players';
  }
  el('playerChips').innerHTML = order.map(uid => {
    const p = currentPlayers[uid] || {};
    const classes = ['player-chip'];
    if (uid === currentMeta.presidentUid) classes.push('president');
    if (uid === currentMeta.chancellorUid) classes.push('chancellor');
    if (p.alive === false) classes.push('dead');
    return `<div class="${classes.join(' ')}">${escapeHtml(p.name || '?')}</div>`;
  }).join('');

  // Host-only escape hatches: force-resolve during elections, skip during night.
  const hostTools = el('hostTools');
  if (hostTools) {
    const showElection = phase === 'election' && currentMeta.hostUid === myUid;
    const showNight = phase === 'night' && currentMeta.hostUid === myUid;
    hostTools.style.display = (showElection || showNight) ? 'block' : 'none';
    const skipBtn = el('nightSkipBtn');
    if (skipBtn) {
      skipBtn.style.display = showNight ? 'block' : 'none';
      if (showNight) skipBtn.textContent = `Begin game now (${nightAcked}/${nightTotal} revealed)`;
    }
    const forceBtn = el('forceResolveBtn');
    if (forceBtn) forceBtn.style.display = showElection ? 'block' : 'none';
  }

  if (phase === 'gameover') {
    el('gameOverBanner').style.display = 'block';
    el('gameOverBanner').textContent = `${currentMeta.winner === 'liberal' ? 'Liberals' : 'Fascists'} win! (${currentMeta.winReason})`;
    // Re-assert win takeover on refresh (endGame already showed it live).
    try {
      const winEl = el('winTakeover');
      if (winEl && !winEl.classList.contains('show') && currentMeta.winner) {
        showWinTakeover(currentMeta.winner, currentMeta.winReason);
      }
    } catch (_) {}
  } else {
    el('gameOverBanner').style.display = 'none';
    try {
      const winEl = el('winTakeover');
      if (winEl && winEl.classList.contains('show')) {
        winEl.classList.remove('show');
        winEl.setAttribute('aria-hidden', 'true');
      }
    } catch (_) {}
  }
  fitStage();
}

// Stage tiers: the fixed canvases the whole board is laid out on. Two boards
// that are 2.49:1 stacked need a tall canvas; a 16:9 screen wants them side by
// side. fitStage() sets the class, CSS owns the numbers, and the two can never
// disagree — which is the failure the old measure-based guard kept hitting.
const STAGE_TIERS = { wide: { w: 1600, h: 760 }, tall: { w: 1000, h: 900 } };
const stageLayoutParam = (params.get('layout') || '').toLowerCase();
let lastFit = -1;

// ?layout=wide|tall pins the canvas (for a host whose screen reports an aspect
// that reads wrong); otherwise the SCREEN's own aspect picks the tier.
//
// Deliberately the window's aspect, not the stage viewport's: the viewport
// shrinks when the host tools appear (they are in flow below the stage), and
// deriving the tier from it made a 1024x768 board flip from stacked to
// side-by-side mid-game the moment a host tool popped up. The screen only
// changes when the host actually resizes or switches resolution, which is
// exactly when a re-layout is legitimate.
function applyStageTier() {
  const vw = window.innerWidth || 0;
  const vh = window.innerHeight || 0;
  const tier = STAGE_TIERS[stageLayoutParam] ? stageLayoutParam
    : (vw > 0 && vh > 0 && vw / vh >= 1.5 ? 'wide' : 'tall');
  try {
    document.body.classList.toggle('layout-wide', tier === 'wide');
    document.body.classList.toggle('layout-tall', tier === 'tall');
  } catch (_) {}
  return STAGE_TIERS[tier];
}

// Fit: one factor for the whole scene, contained (min of both axes) so nothing
// is ever cropped, applied as --fit on the stage viewport. The table is a fixed
// canvas that overflows that viewport symmetrically and is clipped; scaling it
// around its own centre brings it back to exactly the box.
//
// Measured from the viewport's client box on purpose: the table is oversized
// and scaled, so measuring it would fold the previous scale into the next
// result. No-op in the lobby (the viewport has no box while hidden) — which is
// also why the interim lobby keeps its own flowing layout.
function fitStage() {
  const vp = el('stageFit');
  if (!vp) return;
  const tier = applyStageTier();
  const vw = vp.clientWidth || 0;
  const vh = vp.clientHeight || 0;
  if (!vw || !vh) return;
  const fit = Math.min(vw / tier.w, vh / tier.h);
  if (!Number.isFinite(fit) || fit <= 0) return;
  // Skip sub-pixel churn: every write is a repaint, and render() fires often.
  if (Math.abs(fit - lastFit) < 0.0005) return;
  lastFit = fit;
  try {
    vp.style.setProperty('--fit', String(Number(fit.toFixed(4))));
  } catch (_) {}
}

// Board overlay geometry — tile/tracker positions as % of the board image,
// calibrated from the PNGs (dotted-zone runs + pip-ring centroids, Sep 2026).
// All three fascist variants share identical track geometry.
const TILE_TOP_PCT = 30.5; // top edge of policy tiles (both boards)
const TILE_ASPECT = 320 / 397; // tile-liberal/fascist.png w/h
const LIB_SLOT_LEFT = [17.81, 30.94, 43.44, 56.56, 71.5];
const LIB_SLOT_WIDTH = [12.5, 12.5, 12.5, 12.5, 14.5]; // slot 5 covers the dove panel
const FASC_SLOT_LEFT = [10.6, 24.75, 37.9, 50.4, 62.85, 75.45];
const FASC_SLOT_WIDTH = 13;
const TRACKER_PIP_X = [36.25, 44.94, 53.59, 62.28];
const TRACKER_PIP_Y = 79.39;

// Build overlay divs once per layer, then flip .filled/.lit per render.
// Pure function of currentMeta — no new Firebase reads.
function paintBoardOverlays() {
  paintTileLayer('liberalTiles', LIB_SLOT_LEFT, LIB_SLOT_WIDTH, 'liberal', currentMeta.liberalTrack || 0);
  paintTileLayer('fascistTiles', FASC_SLOT_LEFT, FASC_SLOT_WIDTH, 'fascist', currentMeta.fascistTrack || 0);
  paintTrackerPips(currentMeta.electionTracker || 0);
}

function paintTileLayer(layerId, lefts, widths, kind, filled) {
  const layer = el(layerId);
  if (!layer) return;
  const w = i => (Array.isArray(widths) ? widths[i] : widths);
  if (layer.childElementCount !== lefts.length) {
    layer.innerHTML = lefts.map((left, i) =>
      `<div class="tile-spot" style="left:${left}%;width:${w(i)}%;top:${TILE_TOP_PCT}%;aspect-ratio:${TILE_ASPECT}"><img src="img/tile-${kind}.png" alt="${kind} policy" draggable="false" loading="lazy" /></div>`
    ).join('');
  }
  // While a tile is in flight, its slot stays empty with a pulsing outline —
  // meta already counts the policy, but the room only sees it land.
  const pendingHere = pendingEnact && pendingEnact.kind === kind ? pendingEnact.count : -1;
  [...layer.children].forEach((spot, i) => {
    const isPending = (i + 1) === pendingHere && (i + 1) <= filled;
    spot.classList.toggle('filled', i < filled && !isPending);
    spot.classList.toggle('target-pulse', isPending);
  });
}

function paintTrackerPips(tracker) {
  const layer = el('trackerPips');
  if (!layer) return;
  if (layer.childElementCount !== TRACKER_PIP_X.length) {
    layer.innerHTML = TRACKER_PIP_X.map(x =>
      `<div class="tracker-pip" style="left:${x}%;top:${TRACKER_PIP_Y}%"></div>`
    ).join('');
  }
  [...layer.children].forEach((pip, i) => {
    const lit = i < tracker;
    pip.classList.toggle('lit', lit);
    pip.classList.toggle('warn', lit && tracker === 2);
    pip.classList.toggle('danger', lit && tracker >= 3);
  });
}

// Per-round vote mirrors for seat dots. Re-subscribes when roundId changes;
// old listeners are torn down so dots never show a stale round's votes.
function watchRoundExtras() {
  const roundId = currentMeta.roundId;
  if (roundId === extrasRound) return;
  extrasRound = roundId;
  extrasUnsubs.forEach(u => { try { u(); } catch (_) {} });
  extrasUnsubs = [];
  votesCastMap = {};
  votesMap = {};
  votesRevealedFlag = false;
  if (roundId === null || roundId === undefined) return;
  const push = (path, apply) => {
    try {
      const u = onValue(ref(db, `games/${room}/${path}/${roundId}`), snap => {
        apply(snap.val());
        paintSeats();
      }, () => {});
      extrasUnsubs.push(u);
    } catch (_) {}
  };
  push('votesCast', v => { votesCastMap = v || {}; });
  push('votes', v => { votesMap = v || {}; });
  push('votesRevealed', v => { votesRevealedFlag = v === true; });
}

// Seats ringing the table: SECRET backs with name plates; gold ring for the
// President, green for the Chancellor (dashed for the nominee), dimmed when
// executed. A dot pops in once a ballot is cast (red after a revealed Nein).
function paintSeats() {
  const rails = ['seatTop', 'seatLeft', 'seatRight', 'seatBottom'].map(el);
  if (rails.some(r => !r)) return;
  const order = currentMeta.playerOrder || [];
  const n = order.length;
  if (!n) {
    rails.forEach(r => { r.innerHTML = ''; });
    return;
  }
  // Build a state key from the data that affects seat visuals.
  // Only animate when this key changes (president/chancellor/dead/nominee/votes).
  const seatKey = order.join(',') + '|' +
    (currentMeta.presidentUid || '') + '|' +
    (currentMeta.chancellorUid || '') + '|' +
    (currentMeta.chancellorCandidateUid || '') + '|' +
    (currentMeta.phase || '') + '|' +
    order.map(uid => (currentPlayers[uid] && currentPlayers[uid].alive === false ? 'D' : 'A')).join('') + '|' +
    Object.keys(votesCastMap).sort().join(',') + '|' +
    (execState ? `${execState.uid}:${execState.stage}` : '');
  const animate = seatKey !== prevSeatState;
  prevSeatState = seatKey;

  const topN = n >= 8 ? 2 : 1;
  const bottomN = Math.ceil((n - topN) / 2);
  const sideN = n - topN - bottomN;
  const leftN = Math.ceil(sideN / 2);
  const rightN = sideN - leftN;
  const groups = [
    order.slice(0, topN),
    order.slice(topN, topN + leftN),
    order.slice(topN + leftN, topN + leftN + rightN),
    order.slice(topN + leftN + rightN),
  ];
  // When not animating, add a class that suppresses the CSS transition.
  rails.forEach(r => r.classList.toggle('no-seat-transition', !animate));
  groups.forEach((uids, i) => {
    rails[i].innerHTML = uids.map(seatHtml).join('');
  });
  if (!animate) {
    // Remove the suppression class after the DOM settles so the next
    // real change can animate in.
    requestAnimationFrame(() => rails.forEach(r => r.classList.remove('no-seat-transition')));
  }
}

function seatHtml(uid) {
  const p = currentPlayers[uid] || {};
  const classes = ['seat'];
  let badge = '';
  if (uid === currentMeta.presidentUid) { classes.push('president'); badge = 'PRESIDENT'; }
  else if (uid === currentMeta.chancellorUid) { classes.push('chancellor'); badge = 'CHANCELLOR'; }
  else if (currentMeta.phase === 'election' && uid === currentMeta.chancellorCandidateUid) { classes.push('candidate'); badge = 'NOMINEE'; }
  const isDead = p.alive === false;
  if (isDead) classes.push('dead');
  const voted = votesCastMap && Object.prototype.hasOwnProperty.call(votesCastMap, uid);
  if (voted) {
    classes.push('voted');
    if (votesRevealedFlag && votesMap && votesMap[uid] === 'nein') classes.push('voted-nein');
  }
  // Execution cinematic decorations, repainted from execState so Firebase
  // re-renders mid-cinematic can't wipe them. Dead seats keep blood + stamp
  // + tomb permanently (only executions kill, so dead == murdered).
  let execHtml = '';
  const activeExec = execState && execState.uid === uid;
  if (activeExec) classes.push('exec-target');
  if (activeExec && execState.stage === 'lock') {
    execHtml += `<div class="exec-crosshair" aria-hidden="true">◎</div>`;
  }
  if ((activeExec && (execState.stage === 'shot' || execState.stage === 'aftermath')) || (isDead && !activeExec)) {
    const animated = activeExec && execState.stage === 'shot';
    execHtml += `<img class="fx-blood${animated ? ' bloom' : ''}" src="img/fx-blood.png" alt="" draggable="false" />`;
  }
  if ((activeExec && execState.stage === 'aftermath') || (isDead && !activeExec)) {
    const animated = activeExec && execState.stage === 'aftermath';
    const label = activeExec && execState.isHitler ? 'HITLER EXECUTED' : 'EXECUTED';
    execHtml += `<div class="exec-stamp${animated ? ' slam' : ''}">${label}</div>` +
      `<img class="exec-tomb${animated ? ' rise' : ''}" src="img/icon-tombstone.png" alt="RIP" draggable="false" />`;
  }
  if (isDead) classes.push('exec-dead');
  return `<div class="${classes.join(' ')}" data-uid="${escapeHtml(uid)}">` +
    (badge ? `<span class="seat-badge">${badge}</span>` : '') +
    `<img class="seat-card" src="img/back-role.png" alt="Secret role card" draggable="false" loading="lazy" />` +
    execHtml +
    `<span class="vote-dot"></span>` +
    `<span class="seat-name">${escapeHtml(p.name || '?')}</span></div>`;
}

// Draw/discard badges + the fanned face-down policy stack between boards.
function paintPiles() {
  const enacted = (currentMeta.liberalTrack || 0) + (currentMeta.fascistTrack || 0);
  const deck = Number.isFinite(deckCount) ? deckCount : Math.max(0, 17 - enacted - discardCount);
  const disc = Number.isFinite(discardCount) ? discardCount : 0;
  const drawBadge = el('drawBadge');
  const discBadge = el('discardBadge');
  if (drawBadge) drawBadge.textContent = String(deck);
  if (discBadge) discBadge.textContent = String(disc);
  const dc = el('deckCount');
  const dc2 = el('discardCount');
  if (dc) dc.textContent = String(deck);
  if (dc2) dc2.textContent = String(disc);
  const fan = el('policyFan');
  if (fan) {
    const shown = Math.max(0, Math.min(5, deck));
    const html = shown === 0
      ? `<img src="img/back-tile.png" alt="Deck empty" draggable="false" style="opacity:0.35;transform:translateX(-50%) rotate(-6deg)" />`
      : Array.from({ length: shown }, () =>
          `<img src="img/back-tile.png" alt="Face-down policy" draggable="false" />`).join('');
    if (fan.dataset.n !== String(shown)) {
      fan.dataset.n = String(shown);
      fan.innerHTML = html;
    }
  }
}

function escapeHtml(str) {
  return str.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// Bundled QR rendering (no third-party service). Falls back to plain text
// URL if the vendor lib failed to load — the join URL is always shown.
function renderQr(joinUrl) {
  const box = el('qrBox');
  if (!box) return;
  box.innerHTML = '';
  const Lib = globalThis.QRCode;
  if (typeof Lib === 'function') {
    new Lib(box, {
      text: joinUrl,
      width: 220,
      height: 220,
      correctLevel: Lib.CorrectLevel ? Lib.CorrectLevel.M : 0,
    });
  } else {
    box.textContent = joinUrl;
  }
}

main();
