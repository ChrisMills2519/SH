// tutorial-director.js — scripted walkthrough on the REAL board DOM (sandbox only).
// No dependencies, no Firebase writes. Driven entirely through the `api`
// object board.js passes in (painters + cinematics + sound/narrator).
//
// Choreography reuses the live cinematics: showTallyCinematic,
// playEnactCinematic, showPowerCalloutCinematic, showVetoCinematic.
// Execution is a SANITIZED variant (crosshair + stamp + tomb, no blood,
// no flash, no scream). Mock phones are small DOM frames showing what a
// player's phone would display at each beat.

const sleep = ms => new Promise(res => setTimeout(res, ms));
const doubleRaf = () => new Promise(res => requestAnimationFrame(() => requestAnimationFrame(res)));

const DEMO_NAMES = ['Ava', 'Ben', 'Cara', 'Dev', 'Eli', 'Fay', 'Gus'];
const DEMO_UIDS = DEMO_NAMES.map(n => `tut-${n.toLowerCase()}`);

const STEPS = [
  {
    id: 'table',
    title: 'Step 1/8 — The table',
    body: 'This is the real board, live. Liberals build blue (left), Fascists build red (right). Seats ring the table — gold ring = President, green = Chancellor. Fanned tiles between the boards are the draw deck.',
    narr: 'narr_01',
    sound: null,
    focus: ['#liberalBoard', '#fascistBoard', '#policyWell'],
  },
  {
    id: 'roles',
    title: 'Step 2/8 — Secret roles on phones',
    body: 'Everyone checks their phone to reveal their secret role. Liberals outnumber Fascists, but Fascists know each other. Shield your screen — this phone frame mimics what a player sees.',
    narr: 'narr_04',
    sound: 'flip',
    focus: ['#seatTop', '#seatBottom'],
    phone: 'role',
  },
  {
    id: 'election',
    title: 'Step 3/8 — Election: nominate, then vote',
    body: 'The President (gold) nominates one Chancellor (dashed green). Every phone votes Ja! / Nein!. Watch the tally bars fill — majority wins. Failed votes advance the election tracker.',
    narr: 'narr_11',
    sound: 'vote-cast',
    focus: ['#seatTop', '#seatBottom'],
    phone: 'ballot',
  },
  {
    id: 'leg-pres',
    title: 'Step 4/8 — Legislation: President discards',
    body: 'The elected government legislates phone-to-phone. The President secretly gets 3 tiles and discards 1, passing 2 on. Never state exact tiles — you may lie or tell the truth.',
    narr: 'narr_20',
    sound: 'tile-draw',
    focus: ['#policyWell'],
    phone: 'pres-draw',
  },
  {
    id: 'leg-chan',
    title: 'Step 5/8 — Chancellor enacts on the board',
    body: 'The Chancellor secretly enacts 1 of 2. Watch the tile fly deck → board with a zoom. Brass fanfare = liberal, dark hit = fascist. The presidency then passes.',
    narr: 'narr_24',
    sound: 'enact-liberal',
    focus: ['#liberalBoard', '#policyWell'],
    phone: 'chan-hand',
  },
  {
    id: 'power',
    title: 'Step 6/8 — Fascist policies unlock powers',
    body: 'Red policies unlock presidential powers: peek, investigate, special election, execution. Here a fascist policy lands and Policy Peek unlocks — the President views the top tiles in secret.',
    narr: 'narr_31',
    sound: 'enact-fascist',
    focus: ['#fascistBoard'],
    phone: 'peek',
  },
  {
    id: 'veto-chaos',
    title: 'Step 7/8 — Veto & chaos',
    body: 'At 5 red the Chancellor may propose veto (both tiles discarded, tracker +1). Three failed elections in a row = chaos: the top tile auto-enacts and the table shakes.',
    narr: 'narr_17',
    sound: 'chaos',
    focus: ['#trackerPips', '#trackerPill'],
    phone: 'veto',
  },
  {
    id: 'exec-win',
    title: 'Step 8/8 — Execution (sanitized) & victory',
    body: 'Execution targets one seat with a crosshair, then a stamp + tombstone — no gore in this tutorial. Liberals win at 5 blue, Fascists at 6 red (or Hitler elected Chancellor after 3 red). Replay or exit anytime.',
    narr: 'narr_35',
    sound: 'election-fail',
    focus: ['#seatLeft', '#seatRight'],
    phone: 'exec',
  },
];

export function startBoardTutorial(api) {
  let idx = 0;
  let runId = 0;
  let closed = false;

  // -- injected chrome -------------------------------------------------------
  const table = api.el('table');
  if (table) table.classList.add('tut-demo');

  const ui = document.createElement('div');
  ui.id = 'tutDirector';
  ui.setAttribute('role', 'dialog');
  ui.setAttribute('aria-label', 'Board tutorial walkthrough');
  ui.innerHTML = `
    <div class="tut-card">
      <h2 id="tutDTitle"></h2>
      <p class="muted" id="tutDBody"></p>
      <div class="tutorial-steps" id="tutDDots" aria-hidden="true"></div>
      <div class="tutorial-nav">
        <button id="tutDBack" class="secondary" type="button">← Back</button>
        <button id="tutDReplay" class="secondary" type="button">↻ Replay</button>
        <button id="tutDNext" type="button">Next →</button>
      </div>
      <p class="muted tut-exit-row"><button id="tutDExit" class="linklike" type="button">Exit tutorial ✕</button> <span aria-hidden="true">·</span> <span>Esc exits · ←/→ steps</span></p>
    </div>
    <div class="tut-phone" id="tutPhone" aria-hidden="true" style="display:none">
      <div class="tut-phone-label" id="tutPhoneLabel">Player phone</div>
      <div class="tut-phone-screen" id="tutPhoneScreen"></div>
    </div>`;
  document.body.appendChild(ui);

  const titleEl = ui.querySelector('#tutDTitle');
  const bodyEl = ui.querySelector('#tutDBody');
  const dotsEl = ui.querySelector('#tutDDots');
  const backBtn = ui.querySelector('#tutDBack');
  const nextBtn = ui.querySelector('#tutDNext');
  const replayBtn = ui.querySelector('#tutDReplay');
  const exitBtn = ui.querySelector('#tutDExit');
  const phone = ui.querySelector('#tutPhone');
  const phoneLabel = ui.querySelector('#tutPhoneLabel');
  const phoneScreen = ui.querySelector('#tutPhoneScreen');

  function setFocus(selectors) {
    try {
      document.querySelectorAll('.tut-focus').forEach(n => n.classList.remove('tut-focus'));
      (selectors || []).forEach(sel => {
        document.querySelectorAll(sel).forEach(n => n.classList.add('tut-focus'));
      });
    } catch (_) {}
  }

  function setPhone(kind) {
    if (!kind) { phone.style.display = 'none'; return; }
    phone.style.display = '';
    const img = (src, alt, cls = '') => `<img src="${src}" alt="${alt}" draggable="false" class="${cls}" />`;
    if (kind === 'role') {
      phoneLabel.textContent = "Cara's phone — secret role";
      phoneScreen.innerHTML = `${img('img/role-liberal.png', 'Liberal role card')}<p>You are <b>Liberal</b>. Find Hitler. Stop the agenda.</p>`;
    } else if (kind === 'ballot') {
      phoneLabel.textContent = "Ben's phone — vote Ja!/Nein!";
      phoneScreen.innerHTML = `<div class="tut-phone-row">${img('img/ballot-ja.png', 'Ja ballot')}${img('img/ballot-nein.png', 'Nein ballot')}</div><p>Tap a ballot. Dots pop in on seats as votes land.</p>`;
    } else if (kind === 'pres-draw') {
      phoneLabel.textContent = "President Ava — discard 1 of 3";
      phoneScreen.innerHTML = `<div class="tut-phone-row">${img('img/back-tile.png', 'Face-down tile')}${img('img/back-tile.png', 'Face-down tile')}${img('img/back-tile.png', 'Face-down tile')}</div><p>Tap one tile to discard it. Two pass to the Chancellor.</p>`;
    } else if (kind === 'chan-hand') {
      phoneLabel.textContent = "Chancellor Dev — enact 1 of 2";
      phoneScreen.innerHTML = `<div class="tut-phone-row">${img('img/back-tile.png', 'Face-down tile')}${img('img/back-tile.png', 'Face-down tile')}</div><p>Tap one tile to enact it on the board.</p>`;
    } else if (kind === 'peek') {
      phoneLabel.textContent = "President Ava — policy peek";
      phoneScreen.innerHTML = `<div class="tut-phone-row">${img('img/tile-fascist.png', 'Fascist tile')}${img('img/tile-liberal.png', 'Liberal tile')}${img('img/back-tile.png', 'Face-down tile')}</div><p><img src="img/icon-peek.png" alt="" class="tut-icon" /> Top 3 seen in secret. Share it — or lie.</p>`;
    } else if (kind === 'veto') {
      phoneLabel.textContent = "Chancellor — propose veto?";
      phoneScreen.innerHTML = `<div class="tut-phone-row">${img('img/back-tile.png', 'Face-down tile')}${img('img/back-tile.png', 'Face-down tile')}</div><p>After 5 fascist policies: discard both? The President must agree.</p>`;
    } else if (kind === 'exec') {
      phoneLabel.textContent = "President — execution (sanitized demo)";
      phoneScreen.innerHTML = `<p><img src="img/icon-execution.png" alt="" class="tut-icon" /> Tap a seat to eliminate. Demo shows crosshair → stamp + tombstone only.</p>`;
    }
  }

  function paintDemo() {
    try { api.paintAll(); } catch (_) {}
    try { api.fitStage(); } catch (_) {}
  }

  // -- per-step demo state ---------------------------------------------------
  function setupStep(i) {
    const step = STEPS[i];
    api.resetDemoState();
    if (i >= 1) {
      // Seats exist from step 0 on; roles phone is illustrative only.
    }
    if (step.id === 'election') {
      api.setMeta({ phase: 'election', presidentUid: DEMO_UIDS[0], chancellorCandidateUid: DEMO_UIDS[3], electionTracker: 1 });
      api.setVotes({ cast: {}, revealed: false, values: {} });
    } else if (step.id === 'leg-pres') {
      api.setMeta({ phase: 'legislative_president', presidentUid: DEMO_UIDS[0], chancellorUid: DEMO_UIDS[3], electionTracker: 1 });
    } else if (step.id === 'leg-chan') {
      api.setMeta({ phase: 'legislative_chancellor', presidentUid: DEMO_UIDS[0], chancellorUid: DEMO_UIDS[3], liberalTrack: 0, fascistTrack: 0 });
    } else if (step.id === 'power') {
      api.setMeta({ phase: 'executive_action', presidentUid: DEMO_UIDS[0], liberalTrack: 1, fascistTrack: 1, electionTracker: 0 });
    } else if (step.id === 'veto-chaos') {
      api.setMeta({ phase: 'legislative_chancellor', presidentUid: DEMO_UIDS[0], chancellorUid: DEMO_UIDS[3], liberalTrack: 2, fascistTrack: 5, vetoUnlocked: true, electionTracker: 2 });
    } else if (step.id === 'exec-win') {
      api.setMeta({ phase: 'executive_action', presidentUid: DEMO_UIDS[0], liberalTrack: 4, fascistTrack: 3, electionTracker: 0 });
    } else {
      api.setMeta({ phase: 'nomination', presidentUid: DEMO_UIDS[0], electionTracker: 0, liberalTrack: 0, fascistTrack: 0 });
    }
    paintDemo();
    setFocus(step.focus);
    setPhone(step.phone || null);
  }

  // -- per-step animation ----------------------------------------------------
  async function playStep(i, token) {
    const step = STEPS[i];
    const alive = () => !closed && token === runId;
    const reduced = api.prefersReducedMotion();
    try { api.narrate(step.narr); } catch (_) {}
    if (step.sound) { try { api.playSound(step.sound); } catch (_) {} }

    if (step.id === 'table') {
      try { api.playSound('tile-draw'); } catch (_) {}
      await sleep(reduced ? 250 : 1200);
    } else if (step.id === 'election') {
      // Seat vote dots fill, then the tally cinematic plays on the real board.
      const order = DEMO_UIDS;
      const cast = {};
      for (let k = 0; k < order.length; k++) {
        if (!alive()) return;
        cast[order[k]] = true;
        api.setVotes({ cast: { ...cast }, revealed: false, values: {} });
        paintDemo();
        await sleep(reduced ? 60 : 260);
      }
      if (!alive()) return;
      const values = {};
      order.forEach((uid, k) => { values[uid] = k < 5 ? 'ja' : 'nein'; });
      api.setVotes({ cast: { ...cast }, revealed: true, values });
      paintDemo();
      await doubleRaf();
      if (!alive()) return;
      await api.showTally({ ja: 5, total: 7, passed: true, nomineeName: 'Dev' });
      if (!alive()) return;
      try { api.playSound('election-pass'); } catch (_) {}
      api.setMeta({ phase: 'legislative_president', chancellorUid: DEMO_UIDS[3], chancellorCandidateUid: null });
      paintDemo();
    } else if (step.id === 'leg-chan') {
      await sleep(reduced ? 200 : 800);
      if (!alive()) return;
      // Live game increments the track BEFORE the cinematic so the target
      // slot pulses during flight — mirror that here.
      api.setMeta({ liberalTrack: 1 });
      paintDemo();
      await doubleRaf();
      if (!alive()) return;
      await api.playEnact('liberal', 1, { powerLabel: null });
      if (!alive()) return;
      paintDemo();
    } else if (step.id === 'power') {
      await sleep(reduced ? 200 : 700);
      if (!alive()) return;
      api.setMeta({ fascistTrack: 2 });
      paintDemo();
      await doubleRaf();
      if (!alive()) return;
      await api.playEnact('fascist', 2, { powerLabel: 'Policy peek unlocked' });
      if (!alive()) return;
      paintDemo();
      if (!alive()) return;
      api.showPowerCallout('policy_peek');
      await sleep(reduced ? 400 : 1900);
    } else if (step.id === 'veto-chaos') {
      await sleep(reduced ? 200 : 600);
      if (!alive()) return;
      await api.showVeto(2);
      if (!alive()) return;
      api.setMeta({ electionTracker: 3 });
      paintDemo();
      if (!alive()) return;
      api.chaosShake();
      try { api.playSound('chaos'); } catch (_) {}
      await sleep(reduced ? 300 : 1400);
      // Chaos resolves: tracker resets, top tile auto-enacts (liberal 3).
      // Track increments before the flight so the landing slot is live.
      if (!alive()) return;
      api.setMeta({ liberalTrack: 3 });
      paintDemo();
      await doubleRaf();
      if (!alive()) return;
      await api.playEnact('liberal', 3, { chaos: true });
      if (!alive()) return;
      api.setMeta({ electionTracker: 0 });
      paintDemo();
    } else if (step.id === 'exec-win') {
      await sleep(reduced ? 200 : 700);
      if (!alive()) return;
      api.sanitizedExec(DEMO_UIDS[5]);
      try { api.playSound('execution'); } catch (_) {}
      await sleep(reduced ? 500 : 2200);
      if (!alive()) return;
      api.clearExec();
      api.setMeta({ liberalTrack: 5 });
      paintDemo();
      if (!alive()) return;
      api.showWin('liberal', 'five_liberal_policies');
      try { api.playSound('win-liberal'); } catch (_) {}
    } else {
      await sleep(reduced ? 300 : 900);
    }
  }

  async function goto(i) {
    if (closed) return;
    if (i < 0) i = 0;
    if (i >= STEPS.length) { exit(); return; }
    idx = i;
    runId += 1;
    const token = runId;
    const step = STEPS[i];
    try { api.cancelAnims(); } catch (_) {}
    try { api.clearWin(); api.clearExec(); } catch (_) {}
    titleEl.textContent = step.title;
    bodyEl.textContent = step.body;
    dotsEl.innerHTML = STEPS.map((_, k) => `<span class="${k === i ? 'on' : ''}"></span>`).join('');
    backBtn.disabled = i === 0;
    nextBtn.textContent = i === STEPS.length - 1 ? 'Done ✓' : 'Next →';
    setupStep(i);
    await playStep(i, token);
  }

  function exit() {
    if (closed) return;
    closed = true;
    runId += 1;
    try { api.cancelAnims(); api.clearWin(); api.clearExec(); api.resetCinematic(); } catch (_) {}
    try { document.querySelectorAll('.tut-focus').forEach(n => n.classList.remove('tut-focus')); } catch (_) {}
    try { table.classList.remove('tut-demo'); } catch (_) {}
    try { ui.remove(); } catch (_) {}
    try { api.onExit(); } catch (_) {}
  }

  backBtn.addEventListener('click', () => goto(idx - 1));
  nextBtn.addEventListener('click', () => goto(idx + 1));
  replayBtn.addEventListener('click', () => goto(idx));
  exitBtn.addEventListener('click', exit);
  ui.addEventListener('click', e => { if (e.target === ui) exit(); });
  const onKey = e => {
    if (closed) { document.removeEventListener('keydown', onKey); return; }
    if (e.key === 'Escape') { exit(); document.removeEventListener('keydown', onKey); }
    else if (e.key === 'ArrowRight') goto(idx + 1);
    else if (e.key === 'ArrowLeft') goto(idx - 1);
  };
  document.addEventListener('keydown', onKey);

  goto(0);
  return { goto, exit };
}
