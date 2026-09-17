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
  let teamHtml = '';
  if (myTeammates.length) {
    teamHtml = `<p class="muted">Your team: ${myTeammates.map(t => escapeHtml(t.name)).join(', ')}</p>`;
  }
  const whosTurn = describeWhosTurn();
  const roleImg = myRole === 'hitler' ? 'role-hitler' : `role-${myRole}`;
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
      <button class="ballot ja" id="jaBtn"><img src="img/ballot-ja.png" alt="Ja!" /></button>
      <button class="ballot nein" id="neinBtn"><img src="img/ballot-nein.png" alt="Nein!" /></button>
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
  el('jaBtn').addEventListener('click', () => castVote('ja'));
  el('neinBtn').addEventListener('click', () => castVote('nein'));
}

async function renderPresidentDraw() {
  const roundId = currentMeta.roundId;
  const snap = await get(ref(db, `games/${room}/secret/legislative/${roundId}/presidentDraw`));
  const tiles = snap.val();
  if (!tiles) { el('main').innerHTML = `<p class="muted">Loading policies...</p>`; return; }
  el('main').innerHTML = `
    <h2>Discard one policy</h2>
    <p class="muted">The remaining two go to the Chancellor.</p>
    <div class="policy-choice">
      ${tiles.map((t, i) => `<img class="policy-tile policy-tile-img" src="img/tile-${t}.png" alt="${t} policy" data-idx="${i}" />`).join('')}
    </div>
  `;
  document.querySelectorAll('.policy-tile').forEach(elm => {
    elm.addEventListener('click', async () => {
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

async function renderChancellorHand() {
  const roundId = currentMeta.roundId;
  const snap = await get(ref(db, `games/${room}/secret/legislative/${roundId}/chancellorHand`));
  const tiles = snap.val();
  if (!tiles) { el('main').innerHTML = `<p class="muted">Loading policies...</p>`; return; }
  el('main').innerHTML = `
    <h2>Enact one policy</h2>
    <p class="muted">The other is discarded, unseen.</p>
    <div class="policy-choice">
      ${tiles.map((t, i) => `<img class="policy-tile policy-tile-img" src="img/tile-${t}.png" alt="${t} policy" data-idx="${i}" />`).join('')}
    </div>
  `;
  document.querySelectorAll('.policy-tile').forEach(elm => {
    elm.addEventListener('click', async () => {
      const idx = Number(elm.dataset.idx);
      const enacted = tiles[idx];
      const discarded = tiles[1 - idx];
      const discardSnap = await get(ref(db, `games/${room}/secret/discard`));
      const discard = (discardSnap.val() || []).concat([discarded]);
      await update(ref(db, `games/${room}`), {
        [`secret/legislative/${roundId}/enactedTile`]: enacted,
        'secret/discard': discard,
      });
      el('main').innerHTML = `<p class="muted">Policy enacted. Waiting...</p>`;
    });
  });
}

function renderExecution() {
  const order = currentMeta.playerOrder || [];
  const options = order.filter(uid => uid !== myUid && currentPlayers[uid] && currentPlayers[uid].alive !== false);
  el('main').innerHTML = `
    <h2>Choose a player to execute</h2>
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
    <h2>Investigate Loyalty</h2>
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
    if (box) box.innerHTML = `<img class="role-img" src="img/role-${escapeHtml(String(result))}.png" alt="${escapeHtml(String(result))}" />`;
  });
}

function renderSpecialElection() {
  // No eligibility restriction: any other living player may be chosen.
  const order = currentMeta.playerOrder || [];
  const options = order.filter(uid => uid !== myUid && currentPlayers[uid] && currentPlayers[uid].alive !== false);
  el('main').innerHTML = `
    <h2>Special Election</h2>
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
  el('main').innerHTML = `<h2>Policy Peek</h2><p class="muted">Loading top 3 policies...</p>`;
  // Board writes the peek after entering executive_action, so listen live.
  onValue(ref(db, `games/${room}/secret/executive/${roundId}/policyPeek`), async snap => {
    const tiles = snap.val();
    if (!tiles) return;
    el('main').innerHTML = `
      <h2>Policy Peek</h2>
      <p class="muted">Top 3 deck tiles (only you see this). Tap Done to resume the game.</p>
      <div class="policy-choice">
        ${(Array.isArray(tiles) ? tiles : Object.values(tiles)).map(t => `<img class="policy-tile-img" src="img/tile-${escapeHtml(t)}.png" alt="${escapeHtml(t)} policy" />`).join('')}
      </div>
      <button id="peekDoneBtn">Done</button>
    `;
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
