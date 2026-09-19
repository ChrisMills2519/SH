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
  `icon-special-election.png` (token_give), `icon-tombstone.png`
  (pirate-grave by Lorc)

From Kenney "Board Game Icons" (https://kenney.nl/assets/board-game-icons),
[CC0 1.0 Universal](https://creativecommons.org/publicdomain/zero/1.0/),
except `icon-tombstone.png` from game-icons.net by Lorc under
[CC BY 3.0](https://creativecommons.org/licenses/by/3.0/)
("Icons made by Lorc. Available on https://game-icons.net").
Abstract symbols only; no historical insignia.

- `fx-blood.png`: blood-red tint of two masks from Kenney "Splat Pack"
  (https://kenney.nl/assets/splat-pack),
  [CC0 1.0 Universal](https://creativecommons.org/publicdomain/zero/1.0/).
  White mask shapes tinted to blood red locally with PIL; no attribution
  required (credited here anyway).

- `logo.png`, `seal-liberal.png`: original files kept as-is, preserved in
  `img/original-2026-09-17/` along with the pre-replacement PNGs.
  Phones start roles/policies facedown and flip to reveal; ballots flip
  facedown as the vote is played.

## Sound effects (`snd/`)

All MP3, mono 44.1kHz ~64kbps, loudness-normalized (~-16 LUFS) with leading
silence trimmed. Total ~282KB for 15 files — fast on phones.
Downloaded 2026-09-17 from Pixabay under the Pixabay Content License
(free, no attribution required, game use allowed, no standalone
redistribution). Long originals trimmed where noted (`flip` → 0.7s,
`chaos` → 2.5s, `enact-fascist` → 3.5s). Raw originals kept untracked in
`/tmp/opencode/audio/raw/` only, not vendored.

- `flip.mp3` — Card Flick by freesound_community —
  https://pixabay.com/sound-effects/film-special-effects-card-flick-78201/
- `tile-draw.mp3` — pre-existing `taking-playing-card.mp3`, re-encoded to
  house spec (replaces the old stereo 256k file of that name)
- `vote-cast.mp3` — Clean Minimal Pop by DRAGON-STUDIO —
  https://pixabay.com/sound-effects/clean-minimal-pop-467466/
- `election-pass.mp3` — Game Bonus by Universfield —
  https://pixabay.com/sound-effects/film-special-effects-game-bonus-144751/
- `election-fail.mp3` — 8-bit Buzz by DRAGON-STUDIO —
  https://pixabay.com/sound-effects/8-bit-buzz-463201/
- `chaos.mp3` — Alarm by 8footdino_on_scratch (trimmed from 23s) —
  https://pixabay.com/sound-effects/film-special-effects-alarm-301729/
- `enact-liberal.mp3` — Brass Fanfare by Universfield —
  https://pixabay.com/sound-effects/film-special-effects-brass-fanfare-144755/
- `enact-fascist.mp3` — Cinematic Dark Hit Logo by Alex_Kizenkov
  (trimmed from 12s) —
  https://pixabay.com/sound-effects/film-special-effects-cinematic-dark-hit-logo-463005/
- `execution.mp3` — Distant Bang by DRAGON-STUDIO (tasteful gavel substitute) —
  https://pixabay.com/sound-effects/distant-bang-472364/
- `scream.mp3` — Woman Screaming SFX by DRAGON-STUDIO (trimmed from 8s to
  ~2.2s, victim-phone execution scare) —
  https://pixabay.com/sound-effects/horror-woman-screaming-sfx-screaming-sound-effect-320169/
- `reveal.mp3` — Appearance by Universfield (shared peek/investigate/special cue) —
  https://pixabay.com/sound-effects/film-special-effects-appearance-143023/
- `your-turn.mp3` — Message Ping by Universfield —
  https://pixabay.com/sound-effects/film-special-effects-message-ping-351298/
- `game-start.mp3` — Battle Start by freesound_gamestudio —
  https://pixabay.com/sound-effects/film-special-effects-battle-start-408410/
- `win-liberal.mp3` — Great Success by freesound_gamestudio —
  https://pixabay.com/sound-effects/film-special-effects-great-success-384935/
- `win-fascist.mp3` — Creepy Piano Stinger by Universfield —
  https://pixabay.com/sound-effects/film-special-effects-creepy-piano-stinger-153296/

Scrape method (per saturday/AGENTS.md precedent): `curl_cffi` chrome124
impersonation for Pixabay search/detail pages (plain curl is Cloudflare-403),
CDN `cdn.pixabay.com/download/audio/...` fetched with plain curl, script at
`/tmp/opencode/audio/px_sfx.py`.
