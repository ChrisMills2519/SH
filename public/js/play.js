import { db, ensureSignedIn } from './firebase-config.js';
import {
  ref, get, set, update, onValue,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-database.js";
import { ineligibleChancellorCandidates } from './game-logic.js';

const params = new URLSearchParams(location.search);
const room = params.get('room');
const nameFromUrl = params.get('name');
const el = id => document.getElementById(id);

let myUid = null;
let currentMeta = {};
let currentPlayers = {};
let myRole = null;
let myTeammates = [];
let renderedForRound = {}; // avoid re-rendering the same one-shot UI repeatedly
let roleRevealed = false; // tap-to-reveal: role starts facedown each session
let revealedCards = {}; // "roundId:idx" / "peek:roundId:idx" -> true once flipped face-up
const REDUCED_MOTION = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const FLIP_MS = REDUCED_MOTION ? 0 : 550;

async function main() {
  const user = await ensureSignedIn();
  myUid = user.uid;

  const name = nameFromUrl || prompt('Your name:');

  // Reject ghost joins: the room must already exist (created by the board).
  const metaSnap = await get(ref(db, `games/${room}/meta`));
  if (!metaSnap.exists()) {
    el('status').textContent = 'Room not found. Check the code and try again.';
    el('main').innerHTML = '';
    return;
  }
  const playersSnap = await get(ref(db, `games/${room}/players`));
  if (playersSnap.exists() && Object.keys(playersSnap.val()).length >= 10) {
    el('status').textContent = 'Room is full (10 players max).';
    el('main').innerHTML = '';
    return;
  }

  // Per-child update (not set): `alive` is host-only, so it is omitted here —
  // the board marks players alive at game start. Missing `alive` counts as alive.
  await update(ref(db, `games/${room}/players/${myUid}`), {
    name,
    connected: true,
    joinedAt: Date.now(),
  });

  onValue(ref(db, `games/${room}/players`), snap => {
    currentPlayers = snap.val() || {};
    render();
  });

  onValue(ref(db, `games/${room}/meta`), snap => {
    currentMeta = snap.val() || {};
    render();
  });

  onValue(ref(db, `games/${room}/secret/roles/${myUid}`), snap => {
    myRole = snap.val();
    render();
  });

  onValue(ref(db, `games/${room}/secret/knownTeammates/${myUid}`), snap => {
    myTeammates = snap.val() || [];
    render();
  });
}

function render() {
  const phase = currentMeta.phase;
  el('status').textContent = phase ? `Phase: ${phase}` : 'Waiting for host to start...';

  if (phase === 'gameover') {
    el('main').innerHTML = `<div class="role-banner ${currentMeta.winner}">
      ${currentMeta.winner === 'liberal' ? 'Liberals' : 'Fascists'} win!</div>`;
    return;
  }

  if (!myRole) {
    el('main').innerHTML = `<p class="muted">Waiting for the host to start the game...</p>`;
    return;
  }

  if (currentPlayers[myUid] && currentPlayers[myUid].alive === false) {
    el('main').innerHTML = `
      <div class="role-banner dead">You have been executed.</div>
      <p class="muted">You are out of the game — sit back and watch. ${escapeHtml(describeWhosTurn())}</p>
    `;
    return;
  }

  if (phase === 'nomination' && currentMeta.presidentUid === myUid && !currentMeta.chancellorCandidateUid) {
    renderNomination();
    return;
  }

  if (phase === 'election') {
    renderVoting();
    return;
  }

  if (phase === 'legislative_president' && currentMeta.presidentUid === myUid) {
    renderPresidentDraw();
    return;
  }

  if (phase === 'legislative_chancellor' && currentMeta.chancellorUid === myUid) {
    renderChancellorHand();
    return;
  }

  if (phase === 'legislative_chancellor' && currentMeta.presidentUid === myUid) {
    renderVetoConsent();
    return;
  }

  if (phase === 'executive_action' && currentMeta.pendingPower === 'execution' && currentMeta.presidentUid === myUid) {
    renderExecution();
    return;
  }

  if (phase === 'executive_action' && currentMeta.pendingPower === 'investigate_loyalty' && currentMeta.presidentUid === myUid) {
    renderInvestigate();
    return;
  }

  if (phase === 'executive_action' && currentMeta.pendingPower === 'special_election' && currentMeta.presidentUid === myUid) {
    renderSpecialElection();
    return;
  }

  if (phase === 'executive_action' && currentMeta.pendingPower === 'policy_peek' && currentMeta.presidentUid === myUid) {
    renderPolicyPeek();
    return;
  }

  renderIdle();
}

function renderIdle() {
  const roleLabel = myRole === 'hitler' ? 'Hitler' : myRole[0].toUpperCase() + myRole.slice(1);
  const whosTurn = describeWhosTurn();
  const roleImg = myRole === 'hitler' ? 'role-hitler' : `role-${myRole}`;
  if (!roleRevealed) {
    // Genuine reveal: back first (shoulder-surf safe), tap to flip. Team stays hidden until then.
    el('main').innerHTML = `
      <div class="flip-scene center tappable" id="roleScene">
        <div class="flip-inner flipped" id="roleFlip">
          <img class="role-img flip-face" src="img/${roleImg}.png" alt="${roleLabel}" />
          <img class="role-img flip-face flip-back" src="img/back-role.png" alt="Your secret role — tap to reveal" />
        </div>
      </div>
      <p class="role-caption">Tap to reveal your role</p>
      <p>${whosTurn}</p>
    `;
    el('roleScene').addEventListener('click', () => {
      el('roleFlip').classList.remove('flipped');
      setTimeout(() => { roleRevealed = true; render(); }, FLIP_MS);
    });
    return;
  }
  let teamHtml = '';
  if (myTeammates.length) {
    teamHtml = `<p class="muted">Your team: ${myTeammates.map(t => escapeHtml(t.name)).join(', ')}</p>`;
  }
  el('main').innerHTML = `
    <img class="role-img" src="img/${roleImg}.png" alt="${roleLabel}" />
    <p class="role-caption">${roleLabel}</p>
    ${teamHtml}
    <p>${whosTurn}</p>
  `;
}

function describeWhosTurn() {
  const phase = currentMeta.phase;
  const presName = nameOf(currentMeta.presidentUid);
  const chanName = nameOf(currentMeta.chancellorUid);
  if (phase === 'nomination') return `${presName} is nominating a Chancellor.`;
  if (phase === 'legislative_president') return `${presName} is choosing a policy.`;
  if (phase === 'legislative_chancellor') return `${chanName} is choosing a policy.`;
  if (phase === 'executive_action') return `${presName} is using a Presidential Power (${currentMeta.pendingPower}).`;
  return '';
}

function nameOf(uid) {
  return (currentPlayers[uid] && currentPlayers[uid].name) || '?';
}

function renderNomination() {
  const order = currentMeta.playerOrder || [];
  const ineligible = ineligibleChancellorCandidates({
    lastPresidentUid: currentMeta.presidentUidLast,
    lastChancellorUid: currentMeta.chancellorUidLast,
    aliveCount: order.filter(uid => currentPlayers[uid] && currentPlayers[uid].alive !== false).length,
  });
  const options = order.filter(uid =>
    uid !== myUid &&
    currentPlayers[uid] && currentPlayers[uid].alive !== false &&
    !ineligible.has(uid)
  );
  el('main').innerHTML = `
    <h2>Nominate a Chancellor</h2>
    ${options.map(uid => `<button data-uid="${uid}" class="nominateBtn">${escapeHtml(nameOf(uid))}</button>`).join('')}
  `;
  document.querySelectorAll('.nominateBtn').forEach(btn => {
    btn.addEventListener('click', async () => {
      await update(ref(db, `games/${room}/meta`), { chancellorCandidateUid: btn.dataset.uid });
    });
  });
}

function renderVoting() {
  const roundId = currentMeta.roundId;
  const key = `vote-${roundId}`;
  if (renderedForRound[key]) {
    el('main').innerHTML = `<p class="muted">Vote cast. Waiting for everyone else...</p>`;
    return;
  }
  el('main').innerHTML = `
    <h2>${nameOf(currentMeta.presidentUid)} nominates ${nameOf(currentMeta.chancellorCandidateUid)}</h2>
    <div class="vote-buttons">
      <button class="ballot ja" id="jaBtn"><div class="flip-scene"><div class="flip-inner" id="jaFlip">
        <img src="img/ballot-ja.png" alt="Ja!" class="flip-face" />
        <img src="img/back-ballot.png" alt="" class="flip-face flip-back" />
      </div></div></button>
      <button class="ballot nein" id="neinBtn"><div class="flip-scene"><div class="flip-inner" id="neinFlip">
        <img src="img/ballot-nein.png" alt="Nein!" class="flip-face" />
        <img src="img/back-ballot.png" alt="" class="flip-face flip-back" />
      </div></div></button>
    </div>
  `;
  const castVote = async choice => {
    const updates = {};
    updates[`votes/${roundId}/${myUid}`] = choice;
    updates[`votesCast/${roundId}/${myUid}`] = true;
    await update(ref(db, `games/${room}`), updates);
    renderedForRound[key] = true;
    render();
  };
  // Play the card facedown with a flip, then record the vote when it lands.
  const playBallot = (choice, flipId, otherBtnId) => {
    const other = el(otherBtnId);
    if (other) other.setAttribute('disabled', '');
    el(flipId).classList.add('flipped');
    setTimeout(() => castVote(choice), FLIP_MS);
  };
  el('jaBtn').addEventListener('click', () => playBallot('ja', 'jaFlip', 'neinBtn'));
  el('neinBtn').addEventListener('click', () => playBallot('nein', 'neinFlip', 'jaBtn'));
}

function tileArray(v) {
  return Array.isArray(v) ? v : Object.values(v || {});
}

async function renderPresidentDraw() {
  const roundId = currentMeta.roundId;
  const snap = await get(ref(db, `games/${room}/secret/legislative/${roundId}/presidentDraw`));
  const tiles = tileArray(snap.val());
  if (!tiles.length) { el('main').innerHTML = `<p class="muted">Loading policies...</p>`; return; }
  if (tiles.length <= 1) {
    // Short-draw guard: nothing to choose — pass everything through.
    el('main').innerHTML = `
      <h2>Pass the policy on</h2>
      <p class="muted">Only one tile remained in the supply.</p>
      <div class="policy-choice">
        ${tiles.map((t, i) => `<img class="policy-tile policy-tile-img" src="img/tile-${t}.png" alt="${t} policy" data-idx="${i}" />`).join('')}
      </div>
      <button id="passBtn">Pass to Chancellor</button>
    `;
    document.getElementById('passBtn').addEventListener('click', async () => {
      await update(ref(db, `games/${room}`), {
        [`secret/legislative/${roundId}/chancellorHand`]: tiles,
      });
      el('main').innerHTML = `<p class="muted">Sent to the Chancellor. Waiting...</p>`;
    });
    return;
  }
  el('main').innerHTML = `
    <h2>Discard one policy</h2>
    <p class="muted">Tap a card to peek, tap again to discard it. The remaining two go to the Chancellor.</p>
    <div class="policy-choice">
      ${tiles.map((t, i) => policyFlipTile(t, i, roundId)).join('')}
    </div>
  `;
  document.querySelectorAll('.policy-tile').forEach(elm => {
    elm.addEventListener('click', async () => {
      if (!revealPolicyTile(elm, roundId)) return; // first tap just reveals
      const idx = Number(elm.dataset.idx);
      const discarded = tiles[idx];
      const remaining = tiles.filter((_, i) => i !== idx);
      const discardSnap = await get(ref(db, `games/${room}/secret/discard`));
      const discard = (discardSnap.val() || []).concat([discarded]);
      await update(ref(db, `games/${room}`), {
        [`secret/legislative/${roundId}/chancellorHand`]: remaining,
        'secret/discard': discard,
      });
      el('main').innerHTML = `<p class="muted">Sent to the Chancellor. Waiting...</p>`;
    });
  });
}

function tileImg(t, i) {
  const idx = i === undefined ? '' : ` data-idx="${i}"`;
  return `<img class="policy-tile policy-tile-img" src="img/tile-${escapeHtml(t)}.png" alt="${escapeHtml(t)} policy"${idx} />`;
}

// Facedown policy card for tap-to-reveal. First tap flips it face-up (recorded
// in revealedCards so re-renders keep it up); the caller's second tap acts.
function policyFlipTile(t, i, revealKey) {
  const revealed = revealedCards[`${revealKey}:${i}`] ? '' : ' flipped';
  const idx = i === undefined ? '' : ` data-idx="${i}"`;
  return `<div class="policy-tile flip-scene tappable"${idx}>
    <div class="flip-inner${revealed}">
      <img class="policy-tile-img flip-face" src="img/tile-${escapeHtml(t)}.png" alt="${escapeHtml(t)} policy" />
      <img class="policy-tile-img flip-face flip-back" src="img/back-tile.png" alt="Facedown policy — tap to peek" />
    </div>
  </div>`;
}

function revealPolicyTile(elm, revealKey) {
  const key = `${revealKey}:${elm.dataset.idx}`;
  if (revealedCards[key]) return true; // already face-up: caller should act
  revealedCards[key] = true;
  const inner = elm.querySelector('.flip-inner');
  if (inner) inner.classList.remove('flipped');
  return false;
}

function renderChancellorHand() {
  const roundId = currentMeta.roundId;
  const base = `games/${room}/secret/legislative/${roundId}`;
  // Re-render on veto state changes (request → waiting; refused → enact again).
  onValue(ref(db, `${base}/vetoRequested`), async reqSnap => {
    const requested = reqSnap.val() === true;
    const handSnap = await get(ref(db, `${base}/chancellorHand`));
    const tiles = tileArray(handSnap.val());
    if (!tiles.length) { el('main').innerHTML = `<p class="muted">Loading policies...</p>`; return; }
    if (requested) {
      const decSnap = await get(ref(db, `${base}/vetoDecision`));
      const decision = decSnap.val();
      if (!decision) {
        el('main').innerHTML = `<p class="muted">Veto requested. Waiting for the President to agree or refuse...</p>`;
        return;
      }
      if (decision === 'agreed') {
        el('main').innerHTML = `<p class="muted">Veto agreed — both policies discarded.</p>`;
        return;
      }
      // Refused: fall through to the enact UI below.
    }
    const canVeto = currentMeta.vetoUnlocked === true && !requested;
    el('main').innerHTML = `
      <h2>${tiles.length > 1 ? 'Enact one policy' : 'Enact the policy'}</h2>
      <p class="muted">${tiles.length > 1 ? 'Tap a card to peek, tap again to enact it. The other is discarded, unseen.' : 'Only one tile remained in the supply.'}</p>
      <div class="policy-choice">
        ${tiles.map((t, i) => policyFlipTile(t, i, roundId)).join('')}
      </div>
      ${canVeto ? `<button id="vetoBtn">I wish to veto this agenda</button>` : ''}
    `;
    document.querySelectorAll('.policy-tile').forEach(elm => {
      elm.addEventListener('click', async () => {
        if (!revealPolicyTile(elm, roundId)) return; // first tap just reveals
        const idx = Number(elm.dataset.idx);
        const enacted = tiles[idx];
        const rest = tiles.filter((_, i) => i !== idx);
        const discardSnap = await get(ref(db, `games/${room}/secret/discard`));
        const discard = (discardSnap.val() || []).concat(rest);
        await update(ref(db, `games/${room}`), {
          [`secret/legislative/${roundId}/enactedTile`]: enacted,
          'secret/discard': discard,
        });
        el('main').innerHTML = `<p class="muted">Policy enacted. Waiting...</p>`;
      });
    });
    const vetoBtn = document.getElementById('vetoBtn');
    if (vetoBtn) {
      vetoBtn.addEventListener('click', async () => {
        await set(ref(db, `${base}/vetoRequested`), true);
        el('main').innerHTML = `<p class="muted">Veto requested. Waiting for the President...</p>`;
      });
    }
  });
}

function renderVetoConsent() {
  const roundId = currentMeta.roundId;
  const base = `games/${room}/secret/legislative/${roundId}`;
  onValue(ref(db, `${base}/vetoRequested`), async reqSnap => {
    if (reqSnap.val() !== true) {
      el('main').innerHTML = `<p>${escapeHtml(nameOf(currentMeta.chancellorUid))} is choosing a policy.</p>`;
      return;
    }
    const decSnap = await get(ref(db, `${base}/vetoDecision`));
    if (decSnap.val()) {
      el('main').innerHTML = `<p class="muted">Decision recorded. Resuming...</p>`;
      return;
    }
    const handSnap = await get(ref(db, `${base}/chancellorHand`));
    const tiles = tileArray(handSnap.val());
    el('main').innerHTML = `
      <h2>Chancellor wishes to veto</h2>
      <p class="muted">Agree to discard both policies (tracker +1), or refuse and they must enact one.</p>
      <div class="policy-choice">${tiles.map(t => tileImg(t)).join('')}</div>
      <div class="vote-buttons">
        <button id="vetoAgreeBtn">I agree to the veto</button>
        <button id="vetoRefuseBtn">Refuse — enact a policy</button>
      </div>
    `;
    document.getElementById('vetoAgreeBtn').addEventListener('click', async () => {
      await set(ref(db, `${base}/vetoDecision`), 'agreed');
      el('main').innerHTML = `<p class="muted">Veto agreed. Resuming...</p>`;
    });
    document.getElementById('vetoRefuseBtn').addEventListener('click', async () => {
      await set(ref(db, `${base}/vetoDecision`), 'refused');
      el('main').innerHTML = `<p class="muted">Veto refused. Chancellor must enact.</p>`;
    });
  });
}

function renderExecution() {
  const order = currentMeta.playerOrder || [];
  const options = order.filter(uid => uid !== myUid && currentPlayers[uid] && currentPlayers[uid].alive !== false);
  el('main').innerHTML = `
    <h2 class="power-title"><img class="power-icon" src="img/icon-execution.png" alt="" />Choose a player to execute</h2>
    ${options.map(uid => `<button data-uid="${uid}" class="executeBtn">${escapeHtml(nameOf(uid))}</button>`).join('')}
  `;
  document.querySelectorAll('.executeBtn').forEach(btn => {
    btn.addEventListener('click', async () => {
      await update(ref(db, `games/${room}/meta`), { executionTarget: btn.dataset.uid });
      el('main').innerHTML = `<p class="muted">Execution ordered.</p>`;
    });
  });
}

function renderInvestigate() {
  const roundId = currentMeta.roundId;
  const order = currentMeta.playerOrder || [];
  // Official rule: no player may be investigated twice in one game.
  const investigated = currentMeta.investigatedUids || {};
  const options = order.filter(uid => uid !== myUid && !investigated[uid] && currentPlayers[uid] && currentPlayers[uid].alive !== false);
  el('main').innerHTML = `
    <h2 class="power-title"><img class="power-icon" src="img/icon-investigate.png" alt="" />Investigate Loyalty</h2>
    <p class="muted">Pick a player to learn whether they are Liberal or Fascist.</p>
    <div id="investigateOptions">${options.map(uid => `<button data-uid="${uid}" class="investigateBtn">${escapeHtml(nameOf(uid))}</button>`).join('')}</div>
    <div id="investigateResult"></div>
  `;
  document.querySelectorAll('.investigateBtn').forEach(btn => {
    btn.addEventListener('click', async () => {
      await update(ref(db, `games/${room}/meta`), { investigateTarget: btn.dataset.uid });
      const opts = document.getElementById('investigateOptions');
      if (opts) opts.innerHTML = `<p class="muted">Investigating ${escapeHtml(nameOf(btn.dataset.uid))}...</p>`;
    });
  });
  // Live result (president-only read; rule already exists).
  onValue(ref(db, `games/${room}/secret/executive/${roundId}/investigateResult`), snap => {
    const result = snap.val();
    if (!result) return;
    const box = document.getElementById('investigateResult');
    if (box) {
      // Auto-flip the loyalty card as it arrives.
      box.innerHTML = `<div class="flip-scene center"><div class="flip-inner flipped" id="investigateFlip">
        <img class="role-img flip-face" src="img/role-${escapeHtml(String(result))}.png" alt="${escapeHtml(String(result))}" />
        <img class="role-img flip-face flip-back" src="img/back-role.png" alt="" />
      </div></div>`;
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const flip = document.getElementById('investigateFlip');
        if (flip) flip.classList.remove('flipped');
      }));
    }
  });
}

function renderSpecialElection() {
  // No eligibility restriction: any other living player may be chosen.
  const order = currentMeta.playerOrder || [];
  const options = order.filter(uid => uid !== myUid && currentPlayers[uid] && currentPlayers[uid].alive !== false);
  el('main').innerHTML = `
    <h2 class="power-title"><img class="power-icon" src="img/icon-special-election.png" alt="" />Special Election</h2>
    <p class="muted">Choose any other living player to be President next.</p>
    ${options.map(uid => `<button data-uid="${uid}" class="specialBtn">${escapeHtml(nameOf(uid))}</button>`).join('')}
  `;
  document.querySelectorAll('.specialBtn').forEach(btn => {
    btn.addEventListener('click', async () => {
      await update(ref(db, `games/${room}/meta`), { specialElectionTarget: btn.dataset.uid });
      el('main').innerHTML = `<p class="muted">Special election called for ${escapeHtml(nameOf(btn.dataset.uid))}.</p>`;
    });
  });
}

function renderPolicyPeek() {
  const roundId = currentMeta.roundId;
  el('main').innerHTML = `<h2 class="power-title"><img class="power-icon" src="img/icon-peek.png" alt="" />Policy Peek</h2><p class="muted">Loading top 3 policies...</p>`;
  // Board writes the peek after entering executive_action, so listen live.
  onValue(ref(db, `games/${room}/secret/executive/${roundId}/policyPeek`), async snap => {
    const tiles = snap.val();
    if (!tiles) return;
    el('main').innerHTML = `
      <h2 class="power-title"><img class="power-icon" src="img/icon-peek.png" alt="" />Policy Peek</h2>
      <p class="muted">Top 3 deck tiles (only you see this). Tap each card to peek, then Done.</p>
      <div class="policy-choice">
        ${(Array.isArray(tiles) ? tiles : Object.values(tiles)).map((t, i) => policyFlipTile(t, i, `peek:${roundId}`)).join('')}
      </div>
      <button id="peekDoneBtn">Done</button>
    `;
    document.querySelectorAll('.policy-tile').forEach(elm => {
      elm.addEventListener('click', () => revealPolicyTile(elm, `peek:${roundId}`));
    });
    document.getElementById('peekDoneBtn').addEventListener('click', async () => {
      await set(ref(db, `games/${room}/secret/executive/${roundId}/policyPeekSeen`), true);
      el('main').innerHTML = `<p class="muted">Resuming game...</p>`;
    });
  });
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

main();
