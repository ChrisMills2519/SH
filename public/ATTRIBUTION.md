# Artwork attribution

This is an unofficial fan adaptation of [Secret Hitler](https://www.secrethitler.com)
by Mike Boxleiter, Tommy Maranges & Mac Schubert, used under
[CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/).
Non-commercial only. Share-alike. No app-store submission.

## What changed (art)

- `role-liberal.png`, `role-fascist.png`, `role-hitler.png`
- `tile-liberal.png`, `tile-fascist.png`
- `ballot-ja.png`, `ballot-nein.png` (nein re-set at 80% so the fallback-sans
  render fits its frame — the SVG's Germania/Futura fonts aren't installed
  server-side, and the full-size fallback overflowed the card edge)
- `back-role.png`, `back-ballot.png`, `back-tile.png` — official card reverses
  from the same rebuild (`role.cards.backcover.svg`,
  `ballot.card.backcover.svg`, `policy.cards.backcover.mirrored.blemish.svg`),
  used for tap-to-flip reveals on phones
- `board-liberal.png`, `board-fascist-56.png`, `board-fascist-78.png`,
  `board-fascist-910.png` (Fascist board auto-switches by player count:
  5–6 / 7–8 / 9–10, same brackets as the executive-power table)

Re-rendered at 2x display size from Lee Yingtong Li's hand-traced colour SVG
rebuild ("Editable colour SVG Secret Hitler for prepress",
https://yingtongli.me/blog/2019/12/25/secret-hitler.html),
itself adapted from the Tabletop Simulator port by FragaholiC and released under
CC BY-NC-SA 4.0. No swastikas or Third-Reich insignia added; style stays with the
official Liberal/Fascist card design.

- `icon-execution.png` (skull), `icon-peek.png` (cards_seek_top),
  `icon-investigate.png` (cards_seek), `icon-special-election.png` (token_give)

From Kenney "Board Game Icons" (https://kenney.nl/assets/board-game-icons),
[CC0 1.0 Universal](https://creativecommons.org/publicdomain/zero/1.0/).
Abstract symbols only; no historical insignia.

- `logo.png`, `seal-liberal.png`: original files kept as-is, preserved in
  `img/original-2026-09-17/` along with the pre-replacement PNGs.
  Phones start roles/policies facedown and flip to reveal; ballots flip
  facedown as the vote is played.
