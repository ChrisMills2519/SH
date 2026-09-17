// DEV-ONLY — solo-testing bots. DELETE this file (plus the marked
// DEV-ONLY blocks in board.html/board.js, security-rules.dev.json,
// firebase.dev.json, and the README dev section) before game night.
//
// Bots run inside the board page (the trusted host) and act for seats
// flagged `isBot: true`. Fast-forward brains: always vote Ja, random
// legal moves everywhere else. Only imported when `?dev=1` is present.
import { db, ensureSignedIn } from './firebase-config.js';
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

  const nameOf = uid => (players[uid] && players[uid].name) || uid.slice(0, 8);

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

    if (phase === 'nomination' && bots().includes(meta.presidentUid) && !meta.chancellorCandidateUid) {
      const key = `nom-${roundId}`;
      if (!acted.has(key)) {
        acted.add(key);
        const opts = living().filter(uid => uid !== meta.presidentUid);
        if (opts.length) {
          await sleep(800);
          await update(at('meta'), { chancellorCandidateUid: pick(opts) });
        }
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
          acted.add(key);
          await sleep(800);
          const updates = {};
          missing.forEach(uid => {
            updates[`votes/${roundId}/${uid}`] = 'ja';
            updates[`votesCast/${roundId}/${uid}`] = true;
          });
          await update(ref(db, `games/${room}`), updates);
        }
      }
      return;
    }

    if (phase === 'legislative_president' && bots().includes(meta.presidentUid)) {
      const key = `presdisc-${roundId}`;
      if (!acted.has(key)) {
        const drawSnap = await get(at(`secret/legislative/${roundId}/presidentDraw`));
        const handSnap = await get(at(`secret/legislative/${roundId}/chancellorHand`));
        const tiles = asArray(drawSnap.val());
        if (tiles.length && !handSnap.val()) {
          acted.add(key);
          await sleep(800);
          const idx = Math.floor(Math.random() * tiles.length);
          const remaining = tiles.filter((_, i) => i !== idx);
          const discSnap = await get(at('secret/discard'));
          const discard = asArray(discSnap.val()).concat([tiles[idx]]);
          await update(ref(db, `games/${room}`), {
            [`secret/legislative/${roundId}/chancellorHand`]: remaining,
            'secret/discard': discard,
          });
        }
      }
      return;
    }

    if (phase === 'legislative_chancellor' && bots().includes(meta.chancellorUid)) {
      const key = `chanenact-${roundId}`;
      if (!acted.has(key)) {
        const handSnap = await get(at(`secret/legislative/${roundId}/chancellorHand`));
        const enactedSnap = await get(at(`secret/legislative/${roundId}/enactedTile`));
        const tiles = asArray(handSnap.val());
        if (tiles.length && !enactedSnap.val()) {
          acted.add(key);
          await sleep(800);
          const idx = Math.floor(Math.random() * tiles.length);
          const discSnap = await get(at('secret/discard'));
          const discard = asArray(discSnap.val()).concat(tiles.filter((_, i) => i !== idx));
          await update(ref(db, `games/${room}`), {
            [`secret/legislative/${roundId}/enactedTile`]: tiles[idx],
            'secret/discard': discard,
          });
        }
      }
      return;
    }

    if (phase === 'executive_action' && bots().includes(meta.presidentUid)) {
      const power = meta.pendingPower;
      if (power === 'execution' && !meta.executionTarget) {
        const key = `exec-${roundId}`;
        if (!acted.has(key)) {
          acted.add(key);
          const opts = living().filter(uid => uid !== meta.presidentUid);
          if (opts.length) {
            await sleep(800);
            await update(at('meta'), { executionTarget: pick(opts) });
          }
        }
      } else if (power === 'investigate_loyalty' && !meta.investigateTarget) {
        const key = `inv-${roundId}`;
        if (!acted.has(key)) {
          acted.add(key);
          const done = meta.investigatedUids || {};
          const opts = living().filter(uid => uid !== meta.presidentUid && !done[uid]);
          if (opts.length) {
            await sleep(800);
            await update(at('meta'), { investigateTarget: pick(opts) });
          }
        }
      } else if (power === 'special_election' && !meta.specialElectionTarget) {
        const key = `spec-${roundId}`;
        if (!acted.has(key)) {
          acted.add(key);
          const opts = living().filter(uid => uid !== meta.presidentUid);
          if (opts.length) {
            await sleep(800);
            await update(at('meta'), { specialElectionTarget: pick(opts) });
          }
        }
      } else if (power === 'policy_peek') {
        const key = `peekack-${roundId}`;
        if (!acted.has(key)) {
          const peekSnap = await get(at(`secret/executive/${roundId}/policyPeek`));
          const seenSnap = await get(at(`secret/executive/${roundId}/policyPeekSeen`));
          if (peekSnap.val() && seenSnap.val() !== true) {
            acted.add(key);
            await sleep(800);
            console.log(`[devbots] bot president peeked: ${JSON.stringify(peekSnap.val())}`);
            await set(at(`secret/executive/${roundId}/policyPeekSeen`), true);
          }
        }
      }
    }
  }

  async function fillTo(n) {
    const snap = await get(at('players'));
    const current = snap.val() || {};
    const have = Object.keys(current).length;
    console.log(`[devbots] ${have} seats, filling to ${n} as ${nameOf(meta.presidentUid)}`);
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

  async function main() {
    const user = await ensureSignedIn();
    myUid = user.uid;
    onValue(at('meta'), snap => { meta = snap.val() || {}; react(); });
    onValue(at('players'), snap => { players = snap.val() || {}; react(); });

    const fill5 = document.getElementById('devFill5');
    const fill7 = document.getElementById('devFill7');
    const rm = document.getElementById('devRemoveBots');
    if (fill5) fill5.addEventListener('click', () => fillTo(5).catch(e => alert(`Fill failed: ${e.message}`)));
    if (fill7) fill7.addEventListener('click', () => fillTo(7).catch(e => alert(`Fill failed: ${e.message}`)));
    if (rm) rm.addEventListener('click', () => removeBots().catch(e => alert(`Remove failed: ${e.message}`)));
  }

  main().catch(e => console.warn('[devbots] init failed', e));
}
