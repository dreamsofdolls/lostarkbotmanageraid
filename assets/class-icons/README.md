# Class Icons

PNG sources for the 27 Lost Ark classes the bot's `data/Class.js` recognizes.
Filenames match the **bible class ID** (the key in `CLASS_NAMES`) so a single
constant in `data/Class.js` maps `class display name -> Discord custom emoji`.

## How these icons reach Discord

Discord cannot render local PNG files inline. Each PNG has to be registered
as a Discord **application emoji** (owned by the bot application, not by
any single guild) before the bot can reference it as `<:bard:123>` in
embed text. The good news: **the bot does this for you on startup**. You
just `git push` and Railway redeploys; first boot uploads any new PNGs and
populates `CLASS_EMOJI_MAP` in memory.

### The deploy flow

1. Drop a PNG into this folder, named after the bible class ID (e.g.
   `bard.png`, `holyknight.png`). The filenames already in this folder
   follow that convention.
2. `git add` the PNG, commit, push.
3. Railway redeploys. On `ClientReady`, `src/services/class-emoji-bootstrap.js`
   runs:
   - Lists existing application emoji via `GET /applications/{appId}/emojis`
   - For each PNG file: if an emoji with that name already exists in the
     application, reuse the ID; otherwise upload it via
     `POST /applications/{appId}/emojis`
   - Mutates `CLASS_EMOJI_MAP` in memory with the resulting `<:name:id>`
     strings, keyed by class display name
4. Next time someone runs `/raid-status` or `/raid-check`, char fields
   render `<:bard:123> Cyrano · 1740` instead of `Cyrano · 1740`.

The bootstrap is **idempotent** (re-runs are safe; only new PNGs upload)
and **self-healing** (if you delete an emoji from the developer portal, the
next bot restart re-uploads it). Failure is logged and swallowed: any
emoji that fails to upload just renders without an icon, the bot keeps
running.

### Updating an existing class icon (PNG content changed)

Just replace the PNG and push. The bootstrap is **content-addressed**:
each emoji is uploaded with the name `{bibleClassId}_{md5short}` where
`md5short` is the first 6 chars of the PNG's MD5. On every restart:

- Existing emoji whose name matches the expected hash → reuse (content
  unchanged)
- Existing emoji with the SAME bible ID but DIFFERENT hash suffix (or
  no suffix at all) → delete + re-upload with new hash (content
  changed since last upload)
- No existing emoji → upload

So replacing `infighter_male.png` with new art and pushing is enough -
the bot detects the hash mismatch on next deploy and refreshes Discord
automatically. No env var, no manual delete, no script run.

The orphan-detection log line lists any application emoji whose name
parses as a class bible-ID but didn't match any current PNG file (e.g.
you removed a placeholder file). Bot does NOT auto-delete orphans;
clean up manually at <https://discord.com/developers/applications> if
you want the slot back.

### Why application emoji instead of guild emoji

- **Owned by the bot application, not any single guild**, so the bot can
  use them in every guild it joins (future-proof for multi-server)
- **Don't consume Thaemine's 50-slot guild emoji budget** which is
  community-shared with member-uploaded emoji
- **No "Manage Expressions" permission** needed in any guild - emoji are
  application assets the bot owns
- **2000 emoji slot per application** vs 50 free / 250 boosted per guild

### Manual override script (optional)

`scripts/upload-class-emoji.js` exists for local testing or one-shot
maintenance (e.g., re-uploading after manually editing PNGs without
deploying). Same upload logic as the bot's startup bootstrap, runs from
your shell with `DISCORD_TOKEN` in `.env`. Writes
`assets/class-icons/emoji-map.json` for inspection/debugging - the bot
itself doesn't read that JSON; the app-emoji list endpoint is the source
of truth.

```bash
node scripts/upload-class-emoji.js          # idempotent: skip existing
node scripts/upload-class-emoji.js --dry    # validate setup, no upload
node scripts/upload-class-emoji.js --force  # re-upload even if exists
```

## Where the source PNGs came from

| Bible class ID | Display name | Source |
|---|---|---|
| berserker | Berserker | Lost Ark Wiki (Fandom) |
| berserker_female | Slayer | Lost Ark Wiki (Fandom) |
| warlord | Gunlancer | Lost Ark Wiki (Fandom) |
| holyknight | Paladin | Lost Ark Wiki (Fandom) |
| destroyer | Destroyer | Lost Ark Wiki (Fandom) |
| battle_master | Wardancer | Lost Ark Wiki (Fandom) |
| infighter | Scrapper | Lost Ark Wiki (Fandom) |
| soulmaster | Soulfist | Lost Ark Wiki (Fandom) |
| force_master | Soulfist | Alias of `soulmaster.png` |
| lance_master | Glaivier | Lost Ark Wiki (Fandom) |
| battle_master_male | Striker | Lost Ark Wiki (Fandom) |
| devil_hunter | Deadeye | Lost Ark Wiki (Fandom) |
| devil_hunter_female | Gunslinger | Lost Ark Wiki (Fandom) |
| blaster | Artillerist | Lost Ark Wiki (Fandom) |
| hawkeye | Sharpshooter | Lost Ark Wiki (Fandom) |
| hawk_eye | Sharpshooter | Alias of `hawkeye.png` |
| bard | Bard | Lost Ark Wiki (Fandom) |
| arcana | Arcanist | Lost Ark Wiki (Fandom) |
| summoner | Summoner | Lost Ark Wiki (Fandom) |
| elemental_master | Sorceress | Lost Ark Wiki (Fandom) |
| blade | Deathblade | Lost Ark Wiki (Fandom) |
| demonic | Shadow Hunter | Lost Ark Wiki (Fandom) |
| reaper | Reaper | Lost Ark Wiki (Fandom) |
| yinyangshi | Artist | Lost Ark Wiki (Fandom) |
| weather_artist | Aeromancer | Lost Ark Wiki (Fandom) |
| scouter | Machinist | **Placeholder (Artillerist art)** - replace |

## Manual supply needed (5 missing + 1 placeholder)

The Lost Ark Wiki on Fandom is out of date and is missing icons for the 6
newer classes. You'll need to source these from another community pack
(Papunika, Maxroll, official Smilegate KR site) and drop the PNG into
this folder with the matching bible class ID name.

| Bible class ID | Display name | Notes |
|---|---|---|
| ~~soul_eater~~ | ~~Souleater~~ | ✅ Found on Fandom (file existed but wasn't in `Category:Class_Icons`) - already in folder |
| ~~scouter~~ | ~~Machinist~~ | ✅ Fandom (uncategorized) - white-on-transparent for dark UI |
| ~~infighter_male~~ | ~~Breaker~~ | ✅ Inven AI vector inverted - clenched fist inside octagonal MMA ring |
| ~~holyknight_female~~ | ~~Valkyrie~~ | ✅ Discord emoji rip (white silhouette, upscaled 46→320 LANCZOS) |
| ~~dragon_knight~~ | ~~Guardian Knight~~ | ✅ Discord emoji rip (white silhouette, upscaled 96→320 LANCZOS) |
| alchemist | Wildsoul | Specialist advanced class - try Inven post below |

**For the 1 still missing:** [Inven post (Korean community, 2024) - 26 class logos as AI vector + PNG](https://www.inven.co.kr/board/lostark/6271/144967) bundles all classes including the newer ones via Naver Blog download links organized by region (Shushire / Sileen / Arthétain / Anytis / Darenyu / Specialists). Filename naming convention: drop into this folder as the matching bible class ID (`alchemist.png` for Wildsoul).

### Color caveat for Inven sources

Inven AI vector exports are **black-on-transparent** (designed for white
print/web backgrounds). Drop one into Discord dark mode unmodified and
the silhouette vanishes into the background.

Run `python scripts/invert-icon.py assets/class-icons/<file>.png` to
flip RGB while preserving alpha - black silhouette becomes white,
matching the Fandom-sourced 22 in this folder. Requires `pip install
Pillow` once.

Game-UI rips (Fandom) are already white-on-transparent and don't need
the invert.

The bot WILL keep working without these - the char field just renders without
a class icon prefix until you upload + map the emoji. Add them as you find
art you're happy with.

## Source attribution

The Fandom-sourced icons fall under
[Creative Commons Attribution-Share Alike (CC BY-SA)](https://www.fandom.com/licensing).
Images were retrieved from
<https://lostark.fandom.com/wiki/Category:Class_Icons> via the Fandom
MediaWiki API (April 2026 snapshot). If you redistribute the bot or this
asset folder, preserve attribution to Lost Ark Wiki.
