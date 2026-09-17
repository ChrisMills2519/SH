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

Official art is wired in (`public/img/`): policy tiles, role cards, ballots, logo —
re-rendered at 2x from Ying Tong Li's CC BY-NC-SA vector rebuild plus Kenney CC0
power icons. Full credits in `public/ATTRIBUTION.md`; originals backed up in
`public/img/original-2026-09-17/`.

**Not implemented:** **Veto Power** (unlocks after the 5th Fascist policy — deliberately
deferred until after the first playtest), reconnect-with-same-identity if a phone's browser
data is cleared (a refresh is fine, but a *new browser* means a new anonymous UID and no way
back into your seat), and there's no spectator mode beyond the executed-player banner.

<!-- DEV-ONLY START: delete this section with dev-bots.js before game night. -->
## Dev testing (solo playtest shortcuts — remove before game night)

- Board URL gets `&dev=1`, e.g. `board.html?room=DEVTEST&new=1&dev=1`, revealing a dev panel:
  **Fill bots to 5 / 7** tops up the lobby with bot seats, **Remove bots** deletes them.
- Bots run in the board page: always vote Ja, random nominate/discard/enact/power picks,
  auto-ack Policy Peek. Drive 1–2 real seats (phone + incognito tab) and let bots do the rest.
- Requires the dev database rules: `firebase deploy --only database --config firebase.dev.json
  --project secreth-10e81`. **Revert right after testing** with `firebase deploy --only
  database --project secreth-10e81` (prod `security-rules.json`).
- Removal checklist: delete `public/js/dev-bots.js`, `security-rules.dev.json`,
  `firebase.dev.json`, the `DEV-ONLY` blocks in `public/board.html` + `public/js/board.js`,
  and this section. Then redeploy database + hosting.
<!-- DEV-ONLY END -->
