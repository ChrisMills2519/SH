// DEV-ONLY — solo-testing bots. DELETE this file (plus the marked
// DEV-ONLY blocks in board.html/board.js/index.html, security-rules.dev.json,
// firebase.dev.json, and the README dev section) before game night.
//
// Bots run inside the board page (the trusted host) and act for seats
// flagged `isBot: true`. Fast-forward brains: always vote Ja, random
// legal moves everywhere else. Only imported when `?dev=1` is present.
import { db, ensureSignedIn } from './firebase-config.js';
import { executivePowerFor, ineligibleChancellorCandidates } from './game-logic.js';
import {
  ref, get, set, update, remove, onValue,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-database.js";

const sleep = ms => new Promise(r => setTimeout(r, ms));
const pick = arr => arr[Math.floor(Math.random() * arr.length)];
const asArray = v => (Array.isArray(v) ? v : v ? Object.values(v) : []);
const newBotUid = () => `devbot-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;

export function initDevBots({ room }) {
  const at = p => ref(db, `games/${room}/${p}`);
  let myUid = null;
  let meta = {};
  let players = {};
  const acted = new Set();
  let busy = false;
  let queued = false;

  const bots = () => Object.entries(players)
    .filter(([, p]) => p && p.isBot === true && p.alive !== false)
    .sort((a, b) => (a[1].joinedAt || 0) - (b[1].joinedAt || 0))
    .map(([uid]) => uid);

  const living = () => (meta.playerOrder || [])
    .filter(uid => players[uid] && players[uid].alive !== false);

  const nameOf = uid => (uid && players[uid] && players[uid].name) || (uid ? String(uid).slice(0, 8) : '?');

  let peekUnsub = null;
  let peekRound = null;
  // The board writes secret/executive/{round}/policyPeek AFTER the meta flip
  // to executive_action, so a bot tick driven only by meta/players can read
  // too early, see nothing, and never retry (nothing else changes after).
  // Watch the peek node itself so the ack fires when the peek arrives.
  function watchPeek(roundId) {
    if (roundId === peekRound) return;
    if (typeof peekUnsub === 'function') { try { peekUnsub(); } catch (_) { /* ignore */ } }
    peekUnsub = null;
    peekRound = roundId;
    if (roundId === null || roundId === undefined) return;
    peekUnsub = onValue(at(`secret/executive/${roundId}/policyPeek`), () => react());
  }

  function react() {
    if (busy) { queued = true; return; }
    busy = true;
    (async () => {
      try { await step(); }
      catch (e) { console.warn('[devbots]', e); }
      busy = false;
      if (queued) { queued = false; react(); }
    })();
  }

  async function step() {
    if (!myUid || !meta.hostUid || myUid !== meta.hostUid) return;
    if (bots().length === 0) return;
    const phase = meta.phase;
    const roundId = meta.roundId;

    if (phase === 'night') {
      // Bots have no phones: the host acks their night reveal directly.
      const snap = await get(at('players'));
      const all = snap.val() || {};
      const missing = bots().filter(uid => all[uid] && all[uid].roleSeen !== true);
      if (missing.length) {
        await sleep(800);
        const updates = {};
        missing.forEach(uid => { updates[`players/${uid}/roleSeen`] = true; });
        await update(ref(db, `games/${room}`), updates);
      }
      return;
    }

    if (phase === 'nomination' && bots().includes(meta.presidentUid) && !meta.chancellorCandidateUid) {
      const key = `nom-${roundId}`;
      // If a previous pick was rejected (board clears illegal nominees),
      // drop the spent key so the next tick repicks. Retries only happen
      // on fresh meta/players events, so this can't hot-loop.
      if (acted.has(key)) acted.delete(key);
      if (!acted.has(key)) {
        // Mirror the board's term-limit rules so the pick is always legal.
        const inelig = ineligibleChancellorCandidates({
          lastPresidentUid: meta.presidentUidLast,
          lastChancellorUid: meta.chancellorUidLast,
          aliveCount: living().length,
        });
        const opts = living().filter(uid => uid !== meta.presidentUid && !inelig.has(uid));
        if (opts.length) {
          await sleep(800);
          await update(at('meta'), { chancellorCandidateUid: pick(opts) });
        }
        acted.add(key);
      }
      return;
    }

    if (phase === 'election') {
      const key = `vote-${roundId}`;
      if (!acted.has(key)) {
        const castSnap = await get(at(`votesCast/${roundId}`));
        const cast = castSnap.val() || {};
        const missing = bots().filter(uid => living().includes(uid) && !cast[uid]);
        if (missing.length) {
          await sleep(800);
          const updates = {};
          missing.forEach(uid => {
            updates[`votes/${roundId}/${uid}`] = 'ja';
            updates[`votesCast/${roundId}/${uid}`] = true;
          });
          await update(ref(db, `games/${room}`), updates);
          acted.add(key);
        }
      }
      return;
    }

    if (phase === 'legislative_president' && bots().includes(meta.presidentUid)) {
      const key = `presdisc-${roundId}`;
      if (!acted.has(key)) {
        const drawSnap = await get(at(`secret/legislative/${roundId}/presidentDraw`));
        const choiceSnap = await get(at(`secret/legislative/${roundId}/presidentDiscardIdx`));
        const tiles = asArray(drawSnap.val());
        if (tiles.length && (choiceSnap.val() === null || choiceSnap.val() === undefined)) {
          await sleep(800);
          // Index only, like a real phone: the board resolves and discards.
          const idx = tiles.length <= 1 ? -1 : Math.floor(Math.random() * tiles.length);
          await set(at(`secret/legislative/${roundId}/presidentDiscardIdx`), idx);
          acted.add(key);
        }
      }
      return;
    }

    if (phase === 'legislative_chancellor' && bots().includes(meta.chancellorUid)) {
      const key = `chanenact-${roundId}`;
      if (!acted.has(key)) {
        const handSnap = await get(at(`secret/legislative/${roundId}/chancellorHand`));
        const choiceSnap = await get(at(`secret/legislative/${roundId}/chancellorEnactIdx`));
        const tiles = asArray(handSnap.val());
        if (tiles.length && (choiceSnap.val() === null || choiceSnap.val() === undefined)) {
          const reqSnap = await get(at(`secret/legislative/${roundId}/vetoRequested`));
          const requested = reqSnap.val() === true;
          const usedSnap = await get(at(`secret/legislative/${roundId}/vetoUsed`));
          const vetoUsed = usedSnap.val() === true;
          // DEV fast-forward: bot chancellors veto 25% of the time once unlocked.
          // One shot per round: after a refusal the rules (and the board) force enact.
          if (meta.vetoUnlocked === true && !requested && !vetoUsed && Math.random() < 0.25) {
            await sleep(800);
            await set(at(`secret/legislative/${roundId}/vetoRequested`), true);
            return;
          }
          if (requested) {
            const decSnap = await get(at(`secret/legislative/${roundId}/vetoDecision`));
            if (decSnap.val() === 'refused') {
              // Fall through and enact below.
            } else {
              return; // waiting for the president's decision
            }
          }
          await sleep(800);
          const idx = Math.floor(Math.random() * tiles.length);
          // Index only, like a real phone: the board resolves and discards.
          await set(at(`secret/legislative/${roundId}/chancellorEnactIdx`), idx);
          acted.add(key);
        }
      }
      // Fall through: a bot president may also owe a veto decision this step.
    }

    // Bot presidents decide on human-requested vetoes 50/50.
    if (phase === 'legislative_chancellor' && bots().includes(meta.presidentUid)) {
      const key = `vetodec-${roundId}`;
      if (!acted.has(key)) {
        const reqSnap = await get(at(`secret/legislative/${roundId}/vetoRequested`));
        const decSnap = await get(at(`secret/legislative/${roundId}/vetoDecision`));
        if (reqSnap.val() === true && !decSnap.val()) {
          await sleep(800);
          await set(at(`secret/legislative/${roundId}/vetoDecision`), Math.random() < 0.5 ? 'agreed' : 'refused');
          acted.add(key);
        }
      }
      return;
    }

    if (phase === 'executive_action' && bots().includes(meta.presidentUid)) {
      const power = meta.pendingPower;
      if (power === 'execution' && !meta.executionTarget) {
        const key = `exec-${roundId}`;
        if (!acted.has(key)) {
          const opts = living().filter(uid => uid !== meta.presidentUid);
          if (opts.length) {
            await sleep(800);
            await update(at('meta'), { executionTarget: pick(opts) });
            acted.add(key);
          }
        }
      } else if (power === 'investigate_loyalty' && !meta.investigateTarget) {
        const key = `inv-${roundId}`;
        if (!acted.has(key)) {
          const done = meta.investigatedUids || {};
          const opts = living().filter(uid => uid !== meta.presidentUid && !done[uid]);
          if (opts.length) {
            await sleep(800);
            await update(at('meta'), { investigateTarget: pick(opts) });
            acted.add(key);
          }
        }
      } else if (power === 'special_election' && !meta.specialElectionTarget) {
        const key = `spec-${roundId}`;
        if (!acted.has(key)) {
          const opts = living().filter(uid => uid !== meta.presidentUid);
          if (opts.length) {
            await sleep(800);
            await update(at('meta'), { specialElectionTarget: pick(opts) });
            acted.add(key);
          }
        }
      } else if (power === 'policy_peek') {
        const key = `peekack-${roundId}`;
        if (!acted.has(key)) {
          const peekSnap = await get(at(`secret/executive/${roundId}/policyPeek`));
          const seenSnap = await get(at(`secret/executive/${roundId}/policyPeekSeen`));
          if (peekSnap.val() && seenSnap.val() !== true) {
            await sleep(800);
            console.log(`[devbots] bot president peeked: ${JSON.stringify(peekSnap.val())}`);
            await set(at(`secret/executive/${roundId}/policyPeekSeen`), true);
            acted.add(key);
          }
        }
      }
    }
  }

  async function fillTo(n) {
    const snap = await get(at('players'));
    const current = snap.val() || {};
    const have = Object.keys(current).length;
    console.log(`[devbots] ${have} seats, filling to ${n}`);
    for (let i = have; i < n; i++) {
      const uid = newBotUid();
      await set(at(`players/${uid}`), {
        name: `Bot-${i + 1}`,
        connected: true,
        alive: true,
        joinedAt: Date.now() + i,
        isBot: true,
      });
    }
  }

  async function removeBots() {
    const snap = await get(at('players'));
    const current = snap.val() || {};
    for (const [uid, p] of Object.entries(current)) {
      if (p && p.isBot === true) await remove(at(`players/${uid}`));
    }
    console.log('[devbots] bots removed');
  }

  // DEV fast-travel: make the NEXT enacted policy trigger the chosen
  // executive power. Sets fascistTrack to (position - 1) for this game's
  // player-count bracket and plants 3 fascist tiles on top of the deck, so
  // the next legislative session enacts fascist and the power fires.
  // Only during nomination — rigging mid-session would corrupt the live hand.
  async function rigPower(power) {
    if (!myUid || !meta.hostUid || myUid !== meta.hostUid) {
      alert('Rigging only works from the host board tab.');
      return;
    }
    if ((meta.phase || 'lobby') !== 'nomination') {
      alert(`Rig during nomination (now: ${meta.phase || 'lobby'}).`);
      return;
    }
    const count = (meta.playerOrder || []).length || Object.keys(players).length;
    let pos = -1;
    for (let p = 1; p <= 5; p++) {
      if (executivePowerFor(count, p) === power) { pos = p; break; }
    }
    if (pos === -1) {
      alert(`${power} never triggers with ${count} players — use Fill/Remove bots to change brackets (5-6 / 7-8 / 9-10).`);
      return;
    }
    const cur = meta.fascistTrack || 0;
    if (cur >= pos) {
      alert(`Fascist track already at ${cur} — ${power} (slot ${pos}) already passed. Start a new game to re-test it.`);
      return;
    }
    const deckSnap = await get(at('secret/deck'));
    const deck = ['fascist', 'fascist', 'fascist', ...asArray(deckSnap.val())];
    await update(ref(db, `games/${room}`), {
      'meta/fascistTrack': pos - 1,
      'secret/deck': deck,
    });
    console.log(`[devbots] rigged ${power}: fascistTrack=${pos - 1}, 3 fascists planted on deck`);
  }

  async function main() {
    const user = await ensureSignedIn();
    myUid = user.uid;
    onValue(at('meta'), snap => { meta = snap.val() || {}; watchPeek(meta.roundId); react(); });
    onValue(at('players'), snap => { players = snap.val() || {}; react(); });

    const fill5 = document.getElementById('devFill5');
    const fill7 = document.getElementById('devFill7');
    const rm = document.getElementById('devRemoveBots');
    if (fill5) fill5.addEventListener('click', () => fillTo(5).catch(e => alert(`Fill failed: ${e.message}`)));
    if (fill7) fill7.addEventListener('click', () => fillTo(7).catch(e => alert(`Fill failed: ${e.message}`)));
    if (rm) rm.addEventListener('click', () => removeBots().catch(e => alert(`Remove failed: ${e.message}`)));
    const rigs = [
      ['devRigPeek', 'policy_peek'],
      ['devRigInvestigate', 'investigate_loyalty'],
      ['devRigSpecial', 'special_election'],
      ['devRigExecution', 'execution'],
    ];
    for (const [id, power] of rigs) {
      const btn = document.getElementById(id);
      if (btn) btn.addEventListener('click', () => rigPower(power).catch(e => alert(`Rig failed: ${e.message}`)));
    }
  }

  main().catch(e => console.warn('[devbots] init failed', e));
}
