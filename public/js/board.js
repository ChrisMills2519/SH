import { db, ensureSignedIn } from './firebase-config.js';
import {
  ref, get, set, update, onValue, runTransaction,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-database.js";
import {
  assignRoles, freshDeck, executivePowerFor,
  ineligibleChancellorCandidates, checkWin, checkExecutionWin,
} from './game-logic.js';

const params = new URLSearchParams(location.search);
const room = params.get('room');
const isNew = params.get('new') === '1';
const gameRef = ref(db, `games/${room}`);
const metaRef = ref(db, `games/${room}/meta`);

const el = id => document.getElementById(id);

let myUid = null;
let currentMeta = {};
let currentPlayers = {};

async function main() {
  const user = await ensureSignedIn();
  myUid = user.uid;

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

  const joinUrl = `${location.origin}${location.pathname.replace('board.html', 'play.html')}?room=${room}`;
  renderQr(joinUrl);
  el('joinUrl').textContent = joinUrl;
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
      handlePhaseEnter(currentMeta.phase);
    }
  });

  el('startBtn').addEventListener('click', startGame);

  // --- DEV-ONLY START: solo-testing bots. Delete this block with dev-bots.js before game night. ---
  if (new URLSearchParams(location.search).get('dev') === '1') {
    const devPanel = document.getElementById('devPanel');
    if (devPanel) devPanel.style.display = 'block';
    import('./dev-bots.js').then(m => m.initDevBots({ room })).catch(e => console.warn('[devbots] load failed', e));
  }
  // --- DEV-ONLY END ---
}

// ---------------------------------------------------------------------------
// Lobby -> role assignment
// ---------------------------------------------------------------------------
async function startGame() {
  const playerList = Object.entries(currentPlayers)
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
  });
  updates['secret/deck'] = deck;
  updates['secret/discard'] = [];
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
  updates['meta/phase'] = 'nomination';
  updates['meta/pendingPower'] = null;
  updates['meta/executionTarget'] = null;
  updates['meta/investigateTarget'] = null;
  updates['meta/specialElectionTarget'] = null;
  updates['meta/specialElectionReturnUid'] = null;
  updates['meta/investigatedUids'] = null;

  await update(ref(db, `games/${room}`), updates);
}

// ---------------------------------------------------------------------------
// Host-driven phase transitions.
// The board is the only writer of meta/phase, so it's the single place
// where "what happens next" is decided — same job a Node server would do.
// ---------------------------------------------------------------------------
function handlePhaseEnter(phase) {
  if (phase === 'nomination') watchForNomination();
  if (phase === 'election') watchForVotes();
  if (phase === 'legislative_president') watchForPresidentDiscard();
  if (phase === 'legislative_chancellor') watchForChancellorEnact();
  if (phase === 'executive_action') watchForExecutiveAction();
}

function alivePlayers() {
  return (currentMeta.playerOrder || []).filter(uid => currentPlayers[uid] && currentPlayers[uid].alive !== false);
}

function watchForNomination() {
  const unsub = onValue(ref(db, `games/${room}/meta/chancellorCandidateUid`), async snap => {
    const candidate = snap.val();
    if (!candidate) return;
    unsub();
    const roundId = (currentMeta.roundId || 0) + 1;
    await update(metaRef, { roundId, phase: 'election' });
  });
}

function watchForVotes() {
  const roundId = currentMeta.roundId;
  const alive = alivePlayers();
  const castRef = ref(db, `games/${room}/votesCast/${roundId}`);
  const unsub = onValue(castRef, async snap => {
    const cast = snap.val() || {};
    if (Object.keys(cast).length < alive.length) return;
    unsub();
    await set(ref(db, `games/${room}/votesRevealed/${roundId}`), true);
    const votesSnap = await get(ref(db, `games/${room}/votes/${roundId}`));
    const votes = votesSnap.val() || {};
    const jaCount = Object.values(votes).filter(v => v === 'ja').length;
    const majority = jaCount > alive.length / 2;
    await resolveElection(majority);
  });
}

async function resolveElection(majority) {
  if (!majority) {
    const tracker = (currentMeta.electionTracker || 0) + 1;
    if (tracker >= 3) {
      // Chaos: top deck tile auto-enacts, tracker resets, term limits forgotten.
      const drawn = await takeTiles(1);
      const tile = drawn[0];
      const trackField = tile === 'liberal' ? 'liberalTrack' : 'fascistTrack';
      const newVal = (currentMeta[trackField] || 0) + 1;
      await update(ref(db, `games/${room}`), {
        [`meta/${trackField}`]: newVal,
        'meta/electionTracker': 0,
        'meta/chancellorCandidateUid': null,
        'meta/presidentUidLast': null,
        'meta/chancellorUidLast': null,
      });
      const win = checkWin({ liberalTrack: trackField === 'liberalTrack' ? newVal : currentMeta.liberalTrack, fascistTrack: trackField === 'fascistTrack' ? newVal : currentMeta.fascistTrack });
      if (win) return endGame(win);
    } else {
      await update(metaRef, { electionTracker: tracker, chancellorCandidateUid: null });
    }
    advancePresidency(false);
    return;
  }

  // Government elected.
  const chancellorUid = currentMeta.chancellorCandidateUid;
  const rolesSnap = await get(ref(db, `games/${room}/secret/roles`));
  const roles = rolesSnap.val() || {};
  const win = checkWin({
    liberalTrack: currentMeta.liberalTrack || 0,
    fascistTrack: currentMeta.fascistTrack || 0,
    electedChancellorUid: chancellorUid,
    roles,
  });
  if (win) return endGame(win);

  const draw = await takeTiles(3);
  await update(ref(db, `games/${room}`), {
    'meta/chancellorUid': chancellorUid,
    'meta/electionTracker': 0,
    [`secret/legislative/${currentMeta.roundId}/presidentDraw`]: draw,
    'meta/phase': 'legislative_president',
  });
}

function shuffleReshuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
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
  return tiles;
}

function nextAliveAfter(uid) {
  const order = currentMeta.playerOrder || [];
  if (!order.length) return null;
  let idx = order.indexOf(uid);
  for (let i = 0; i < order.length; i++) {
    idx = (idx + 1) % order.length;
    const cand = order[idx];
    if (!currentPlayers[cand] || currentPlayers[cand].alive !== false) return cand;
  }
  return null;
}

// snapshotLasts=false is for FAILED elections: per the rules, term limits
// track the last ELECTED government, so a rejected nomination must rotate
// the presidency without touching presidentUidLast/chancellorUidLast.
async function advancePresidency(snapshotLasts = true) {
  // If the term just ended was a special-elected presidency, return to the
  // stored next-in-line (left of the President who enacted the Special Election).
  if (currentMeta.specialElectionReturnUid) {
    let next = currentMeta.specialElectionReturnUid;
    if (currentPlayers[next] && currentPlayers[next].alive === false) {
      next = nextAliveAfter(next) || nextAliveAfter(currentMeta.presidentUid);
    }
    const updates = {
      presidentUid: next,
      specialElectionReturnUid: null,
      phase: 'nomination',
    };
    if (snapshotLasts) {
      updates.presidentUidLast = currentMeta.presidentUid;
      updates.chancellorUidLast = currentMeta.chancellorUid || null;
    }
    await update(metaRef, updates);
    return;
  }
  const order = currentMeta.playerOrder || [];
  const currentIdx = order.indexOf(currentMeta.presidentUid);
  let nextIdx = currentIdx;
  let next;
  do {
    nextIdx = (nextIdx + 1) % order.length;
    next = order[nextIdx];
  } while (currentPlayers[next] && currentPlayers[next].alive === false);
  const updates = {
    presidentUid: next,
    phase: 'nomination',
  };
  if (snapshotLasts) {
    updates.presidentUidLast = currentMeta.presidentUid;
    updates.chancellorUidLast = currentMeta.chancellorUid || null;
  }
  await update(metaRef, updates);
}

function watchForPresidentDiscard() {
  const roundId = currentMeta.roundId;
  const unsub = onValue(ref(db, `games/${room}/secret/legislative/${roundId}/chancellorHand`), snap => {
    if (!snap.val()) return;
    unsub();
    update(metaRef, { phase: 'legislative_chancellor' });
  });
}

function watchForChancellorEnact() {
  const roundId = currentMeta.roundId;
  const unsub = onValue(ref(db, `games/${room}/secret/legislative/${roundId}/enactedTile`), async snap => {
    const tile = snap.val();
    if (!tile) return;
    unsub();
    const field = tile === 'liberal' ? 'liberalTrack' : 'fascistTrack';
    const newVal = (currentMeta[field] || 0) + 1;
    await update(metaRef, { [field]: newVal });

    const win = checkWin({
      liberalTrack: field === 'liberalTrack' ? newVal : currentMeta.liberalTrack,
      fascistTrack: field === 'fascistTrack' ? newVal : currentMeta.fascistTrack,
    });
    if (win) return endGame(win);

    if (field === 'fascistTrack') {
      const power = executivePowerFor((currentMeta.playerOrder || []).length, newVal);
      if (power) {
        await update(metaRef, { phase: 'executive_action', pendingPower: power });
        return;
      }
    }
    advancePresidency();
  });
}

async function watchForExecutiveAction() {
  const power = currentMeta.pendingPower;
  if (power === 'execution') {
    const unsub = onValue(ref(db, `games/${room}/meta/executionTarget`), async snap => {
      const target = snap.val();
      if (!target) return;
      unsub();
      const rolesSnap = await get(ref(db, `games/${room}/secret/roles`));
      const roles = rolesSnap.val() || {};
      await update(ref(db, `games/${room}`), {
        [`players/${target}/alive`]: false,
        'meta/executionTarget': null,
        'meta/pendingPower': null,
      });
      const win = checkExecutionWin({ executedUid: target, roles });
      if (win) return endGame(win);
      advancePresidency();
    });
  } else if (power === 'investigate_loyalty') {
    const unsub = onValue(ref(db, `games/${room}/meta/investigateTarget`), async snap => {
      const target = snap.val();
      if (!target) return;
      unsub();
      const rolesSnap = await get(ref(db, `games/${room}/secret/roles`));
      const roles = rolesSnap.val() || {};
      // Hitler counts as fascist for this power.
      const result = roles[target] === 'liberal' ? 'liberal' : 'fascist';
      await update(ref(db, `games/${room}`), {
        [`secret/executive/${currentMeta.roundId}/investigateResult`]: result,
        [`meta/investigatedUids/${target}`]: true,
        'meta/investigateTarget': null,
        'meta/pendingPower': null,
      });
      advancePresidency();
    });
  } else if (power === 'special_election') {
    const unsub = onValue(ref(db, `games/${room}/meta/specialElectionTarget`), async snap => {
      const target = snap.val();
      if (!target) return;
      unsub();
      const enacting = currentMeta.presidentUid;
      const updates = {
        'meta/presidentUid': target,
        'meta/presidentUidLast': enacting,
        'meta/chancellorCandidateUid': null,
        'meta/specialElectionTarget': null,
        'meta/pendingPower': null,
        'meta/phase': 'nomination',
      };
      // Remember where the normal rotation resumes. If already inside a
      // special term (nested specials), keep the outer return pointer.
      if (!currentMeta.specialElectionReturnUid) {
        updates['meta/specialElectionReturnUid'] = nextAliveAfter(enacting);
      }
      await update(ref(db, `games/${room}`), updates);
    });
  } else if (power === 'policy_peek') {
    // Copy top 3 tiles for the President's eyes only, then wait for their
    // Done tap (policyPeekSeen) before advancing. Read-only view: if the
    // deck is short, show deck+discard merged without consuming anything.
    let deck = (await get(ref(db, `games/${room}/secret/deck`))).val() || [];
    if (!Array.isArray(deck)) deck = Object.values(deck);
    let peek = deck.slice(0, 3);
    if (peek.length < 3) {
      let discard = (await get(ref(db, `games/${room}/secret/discard`))).val() || [];
      if (!Array.isArray(discard)) discard = Object.values(discard);
      peek = deck.concat(discard).slice(0, 3);
    }
    await set(ref(db, `games/${room}/secret/executive/${currentMeta.roundId}/policyPeek`), peek);
    const unsub = onValue(ref(db, `games/${room}/secret/executive/${currentMeta.roundId}/policyPeekSeen`), async snap => {
      if (snap.val() !== true) return;
      unsub();
      await update(ref(db, `games/${room}`), { 'meta/pendingPower': null });
      advancePresidency();
    });
  }
}

async function endGame(win) {
  await update(metaRef, { winner: win.winner, winReason: win.reason, phase: 'gameover' });
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------
function render() {
  const phase = currentMeta.phase;
  el('phaseLabel').textContent = phase || '';

  el('lobbyPanel').style.display = phase === 'lobby' ? 'block' : 'none';
  el('gamePanel').style.display = phase && phase !== 'lobby' ? 'block' : 'none';

  if (phase === 'lobby') {
    const names = Object.values(currentPlayers).map(p => p.name);
    el('playerCount').textContent = names.length;
    el('playerNames').textContent = names.join(', ');
    el('startBtn').disabled = names.length < 5 || names.length > 10;
    return;
  }

  el('liberalSlots').innerHTML = renderTrack(currentMeta.liberalTrack || 0, 5, 'liberal');
  el('fascistSlots').innerHTML = renderTrack(currentMeta.fascistTrack || 0, 6, 'fascist');
  el('electionTrackerLabel').textContent = `${currentMeta.electionTracker || 0} / 3`;

  const order = currentMeta.playerOrder || [];
  el('playerChips').innerHTML = order.map(uid => {
    const p = currentPlayers[uid] || {};
    const classes = ['player-chip'];
    if (uid === currentMeta.presidentUid) classes.push('president');
    if (uid === currentMeta.chancellorUid) classes.push('chancellor');
    if (p.alive === false) classes.push('dead');
    return `<div class="${classes.join(' ')}">${escapeHtml(p.name || '?')}</div>`;
  }).join('');

  if (phase === 'gameover') {
    el('gameOverBanner').style.display = 'block';
    el('gameOverBanner').textContent = `${currentMeta.winner === 'liberal' ? 'Liberals' : 'Fascists'} win! (${currentMeta.winReason})`;
  } else {
    el('gameOverBanner').style.display = 'none';
  }
}

function renderTrack(filled, total, kind) {
  let html = '';
  for (let i = 0; i < total; i++) {
    if (i < filled) {
      html += `<img class="slot-img" src="img/tile-${kind}.png" alt="${kind} policy" />`;
    } else {
      html += `<div class="slot"></div>`;
    }
  }
  return html;
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
