// game-logic.js
// Pure functions + constant tables encoding the official Secret Hitler rules.
// No Firebase calls in this file — it's deliberately host-agnostic so it's
// easy to unit-test and easy to trust (this is the code doing the "honest
// dealer" work described in the plan).

// --- Role distribution table (official rules) ---------------------------
// Returns { liberals, fascists, hitler } counts for a given player count.
export function roleDistribution(playerCount) {
  const table = {
    5:  { liberals: 3, fascists: 1 },
    6:  { liberals: 4, fascists: 1 },
    7:  { liberals: 4, fascists: 2 },
    8:  { liberals: 5, fascists: 2 },
    9:  { liberals: 5, fascists: 3 },
    10: { liberals: 6, fascists: 3 },
  };
  const row = table[playerCount];
  if (!row) throw new Error(`Secret Hitler requires 5-10 players, got ${playerCount}`);
  return { ...row, hitler: 1 };
}

// Whether Hitler is told who the other Fascists are (only true for 5-6 players).
export function hitlerKnowsFascists(playerCount) {
  return playerCount <= 6;
}

// --- Executive power table (official rules) ------------------------------
// Keyed by player count bracket, then by fascist-track position (1-indexed)
// that was JUST enacted. Value is the power name, or null for no power.
const POWER_TABLES = {
  small: { 1: null, 2: null,               3: 'policy_peek',      4: 'execution', 5: 'execution' },
  mid:   { 1: null, 2: 'investigate_loyalty', 3: 'special_election', 4: 'execution', 5: 'execution' },
  large: { 1: 'investigate_loyalty', 2: 'investigate_loyalty', 3: 'special_election', 4: 'execution', 5: 'execution' },
};

function bracketFor(playerCount) {
  if (playerCount <= 6) return 'small';
  if (playerCount <= 8) return 'mid';
  return 'large';
}

// fascistTrackPosition is the count of fascist policies enacted so far (1-5).
export function executivePowerFor(playerCount, fascistTrackPosition) {
  if (fascistTrackPosition < 1 || fascistTrackPosition > 5) return null;
  return POWER_TABLES[bracketFor(playerCount)][fascistTrackPosition] ?? null;
}

// Veto unlocks once 5 fascist policies have been enacted, for all
// legislative sessions afterwards (official Veto Power rule).
export function vetoUnlocked(fascistTrack) {
  return (fascistTrack || 0) >= 5;
}

// --- Policy deck -----------------------------------------------------------
// 6 Liberal tiles, 11 Fascist tiles, per the physical game.
export function freshDeck() {
  const deck = [
    ...Array(6).fill('liberal'),
    ...Array(11).fill('fascist'),
  ];
  return shuffle(deck);
}

export function shuffle(array) {
  const arr = array.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// --- Role assignment --------------------------------------------------------
// Given a list of player uids (in seating order) returns:
//   { roles: {uid: 'liberal'|'fascist'|'hitler'}, knownTeammates: {uid: [{uid,name}]} }
// `players` is [{uid, name}, ...] in seating order.
export function assignRoles(players) {
  const { liberals, fascists, hitler } = roleDistribution(players.length);
  const pool = shuffle(players);

  const hitlerPlayers = pool.slice(0, hitler);
  const fascistPlayers = pool.slice(hitler, hitler + fascists);
  const liberalPlayers = pool.slice(hitler + fascists, hitler + fascists + liberals);

  const roles = {};
  hitlerPlayers.forEach(p => (roles[p.uid] = 'hitler'));
  fascistPlayers.forEach(p => (roles[p.uid] = 'fascist'));
  liberalPlayers.forEach(p => (roles[p.uid] = 'liberal'));

  const knownTeammates = {};
  const fascistTeam = fascistPlayers.map(p => ({ uid: p.uid, name: p.name }));
  const hitlerTeam = hitlerPlayers.map(p => ({ uid: p.uid, name: p.name }));

  // Fascists (non-Hitler) always know each other AND know who Hitler is.
  fascistPlayers.forEach(p => {
    knownTeammates[p.uid] = [
      ...fascistTeam.filter(x => x.uid !== p.uid),
      ...hitlerTeam,
    ];
  });

  // Hitler only learns the fascist team in small games (5-6 players).
  hitlerPlayers.forEach(p => {
    knownTeammates[p.uid] = hitlerKnowsFascists(players.length) ? fascistTeam : [];
  });

  // Liberals know nobody.
  liberalPlayers.forEach(p => {
    knownTeammates[p.uid] = [];
  });

  return { roles, knownTeammates };
}

// --- Term-limit eligibility --------------------------------------------------
// Returns the set of uids NOT eligible to be nominated as Chancellor.
export function ineligibleChancellorCandidates({ lastPresidentUid, lastChancellorUid, aliveCount }) {
  const ineligible = new Set();
  if (lastChancellorUid) ineligible.add(lastChancellorUid);
  // With only 5 players left, the last President's term limit is waived.
  if (lastPresidentUid && aliveCount > 5) ineligible.add(lastPresidentUid);
  return ineligible;
}

// --- Win condition checks ----------------------------------------------------
export function checkWin({ liberalTrack, fascistTrack, electedChancellorUid, roles }) {
  if (liberalTrack >= 5) return { winner: 'liberal', reason: 'five_liberal_policies' };
  if (fascistTrack >= 6) return { winner: 'fascist', reason: 'six_fascist_policies' };
  if (fascistTrack >= 3 && electedChancellorUid && roles[electedChancellorUid] === 'hitler') {
    return { winner: 'fascist', reason: 'hitler_elected_chancellor' };
  }
  return null;
}

export function checkExecutionWin({ executedUid, roles }) {
  if (roles[executedUid] === 'hitler') {
    return { winner: 'liberal', reason: 'hitler_executed' };
  }
  return null;
}
