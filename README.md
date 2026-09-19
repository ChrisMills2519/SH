# Secret Hitler — digital play aid

Unofficial fan adaptation of [Secret Hitler](https://www.secrethitler.com), for personal/casual
use only. Licensed under the same terms as the original: **CC BY-NC-SA 4.0** — non-commercial,
credit the original creators (Mike Boxleiter, Tommy Maranges, Mac Schubert), share-alike, no app
store submission.

Architecture: no backend server. The "board" device (your shared display) is the trusted host and
writes all game state into Firebase Realtime Database; phones are thin clients that read/write
only what the security rules let them touch. See `security-rules.json` for exactly who can see
what, and why.

## Setup (already done for `secreth-10e81`)

1. Firebase project on the free **Spark** plan with **Anonymous** sign-in enabled.
2. **Realtime Database** created; rules live in `security-rules.json`.
3. Web app config already pasted into `public/js/firebase-config.js`.

To redeploy the rules after editing them:

```
firebase deploy --only database --project secreth-10e81
```

### Run it

Game night (no LAN needed) — board and phones all use the hosted URL:

```
firebase deploy --only hosting --project secreth-10e81
```

Then open the Hosting URL's `board.html` on the shared display (or `index.html` →
Host a Game) and have phones scan the on-screen QR code.

Local dev alternative: `npx http-server public -p 8080`, board at
`http://localhost:8080`, phones on the same wifi at
`http://<board-device-LAN-IP>:8080`.

Firebase Hosting is also free on the Spark plan and gives you a real HTTPS URL any phone can hit
from anywhere.

## Status — what's actually implemented

**Working end-to-end:** lobby + QR join (bundled, offline-safe), role assignment (correct
distribution table + Hitler/Fascist visibility rules for 5–10 players), Chancellor nomination
with term limits, simultaneous voting, election tracker + chaos policies (term limits
forgotten), the President→Chancellor policy exchange, Liberal/Fascist track tracking, all three
win conditions (5 Liberal policies, 6 Fascist policies, Hitler elected Chancellor after 3+
Fascist policies), and all four presidential powers except Veto:

- **Execution** (including the "Hitler executed" instant win; executed players see a
  spectator-style banner).
- **Investigate Loyalty** — President picks a living player (never twice), learns
  Liberal/Fascist privately (Hitler reads as Fascist).
- **Special Election** — President picks any living player; presidency returns to the
  correct next-in-line afterwards.
- **Policy Peek** — President sees the top 3 tiles, taps Done to resume.
- **Veto Power** (unlocks after the 5th Fascist policy) — Chancellor may propose a veto,
  President consents (seeing both tiles) or refuses; agreed vetoes discard both policies and
  advance the tracker (+1, chaos at 3).

Official art is wired in (`public/img/`): policy tiles, role cards, ballots, logo —
re-rendered at 2x from Ying Tong Li's CC BY-NC-SA vector rebuild plus Kenney CC0
power icons. Full credits in `public/ATTRIBUTION.md`; originals backed up in
`public/img/original-2026-09-17/`.

**Host display (board.html):** the board is a fixed-size *stage* that only ever scales —
`fitStage()` sets one `--fit` factor so the whole scene fits whatever screen hosts it, with
no scrolling and no way for the interior to reflow onto itself. The canvas is picked from
the host's aspect: a 16:9 screen gets the two boards side by side (1600×760), a 4:3 or
portrait screen gets them stacked (1000×950). `board.html?room=CODE&layout=wide|tall`
overrides that if the automatic choice reads wrong. Narration is a row inside the stage
and the host tools sit below it in normal flow, so neither can cover a seat.

**Reconnect after browser data loss:** each phone gets a 4-digit reconnect code on join
(shown once — save it). On the landing page use **Reconnect to your seat** (name + room
code + code), or open `play.html?room=CODE&reconnect=1&pin=CODE` directly on the new
browser, and the board moves your seat (role, teammates, turn state, even in-flight
ballots) onto the new UID. The board tab has to be open — it's the only reader of the
PINs, so a request waits until the host screen is up. A wrong name/code is rejected with
a clear error. A plain refresh or reopening the tab in the same browser needs none of
this: the seat is still yours.
**Re-checking your role mid-game:** every phone has a **🎴 My role** button in the top bar
(next to the sound toggle) once the seat has joined. It opens a full-screen card showing your
role and, if you have any, the allies you know — reachable on **every** phase, not just the
night reveal and the idle screen. It closes on ✕, on a tap outside the card, on Esc, and by
itself after 20 seconds, and `closeRoleMenu()` empties the menu body so a phone left face-up
on the table has no role sitting in the DOM.

One honesty note on that screen: `secret/knownTeammates/{uid}` is a **flat** `{uid, name}`
list, and a Fascist's list holds the other Fascists *and* Hitler with no role on any entry. So
the menu can say who is on your side, and says so in as many words — “the app lists them
together, it does not mark which is Hitler.” It does not pretend to know more than the data
(allies in the physical game *do* know who Hitler is; the app doesn't store it that way).

**Not implemented:** there's no spectator mode beyond the executed-player banner.

<!-- DEV-ONLY START: delete this section with dev-bots.js before game night. -->
## Dev testing (solo playtest shortcuts — remove before game night)

- Board URL gets `&dev=1`, e.g. `board.html?room=DEVTEST&new=1&dev=1`, revealing a dev panel:
  **Fill bots to 5 / 7** tops up the lobby with bot seats, **Remove bots** deletes them.
- Bots run in the board page: always vote Ja, random nominate/discard/enact/power picks,
  auto-ack Policy Peek. Drive 1–2 real seats (phone + incognito tab) and let bots do the rest.
- **Rig next power** buttons (nomination phase only): set the fascist track and plant 3
  fascist tiles so the next enact fires that power on demand — no need to play 4+ rounds to
  reach execution. Bracket-aware: peek exists at 5–6 players, investigate/special need 7+
  (Fill to 7), execution everywhere. Warns instead of breaking if the track already passed it.
- Requires the dev database rules: `firebase deploy --only database --config firebase.dev.json
  --project secreth-10e81`. **Revert right after testing** with `firebase deploy --only
  database --project secreth-10e81` (prod `security-rules.json`).
- `preview-fit.html` also measures real geometry after every fit (rect collisions between the
  rails/columns/boards, spill past the stage frame, off-centre slack, and how much of the stage
  the content fills) and dumps it as JSON into the hidden `#probeData` element. `chrome
  --headless --dump-dom` can read that without a debugger — which is how the stage centring bug
  was caught: `place-items: center` clamps an oversized item to the start corner inside a scroll
  container, so the board sat down-and-right by `(1 - fit) * size / 2`. Keep that check when
  touching the fit; it is not visible to the arithmetic. Note `--window-size=W,H` in headless
  includes ~87px of window decoration, so pass `H + 87` for a true H-tall viewport.
- `public/preview-layouts.html` frames `preview-fit.html` at several host screen sizes
  (1080p TV, 4K, ultrawide, laptop, 4:3 projector, portrait, plus a custom size) and
  reads each frame's own fit numbers back out — tier, scale, slack, and whether anything
  is clipped. That's the way to check a projector you don't own. `?players=&phase=&layout=&tools=`
  on `preview-fit.html` drive it.
- `public/preview-play.html` is the phone-side mirror: no Firebase, so it renders the player
  screens offline. Pick a screen, a device width (390 / 768 / full) and a role, and it uses the
  real `css/style.css`, so what you see is honest. The **my role menu** screen opens the role
  overlay (mirrored from `roleMenuHtml()`) over live nomination UI; the overlay is inside the
  device frame (a `transform` on the frame makes it the containing block for `position: fixed`),
  so it covers the simulated phone and not the browser window. No 20s autoclose there — that
  would fight you while you're looking at it. `?screen=menu&role=fascist&width=390` is
  shareable. `node scripts/check-role-menu.js` asserts the mirror still matches what
  `play.js` ships, plus the escaping and the ids/classes both pages depend on.
- Removal checklist: delete `public/js/dev-bots.js`, `public/preview-fit.html`,
  `public/preview-play.html`, `public/preview-layouts.html`, `scripts/check-role-menu.js`,
  `security-rules.dev.json`,
  `firebase.dev.json`, the `DEV-ONLY` blocks in `public/board.html` + `public/js/board.js` +
  `public/index.html`,
  and this section. Then redeploy database + hosting.
<!-- DEV-ONLY END -->
