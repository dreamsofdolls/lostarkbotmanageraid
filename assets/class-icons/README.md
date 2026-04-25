# Class Icons

PNG sources for the 27 Lost Ark classes the bot's `data/Class.js` recognizes.
Filenames match the **bible class ID** (the key in `CLASS_NAMES`) so a single
constant in `data/Class.js` maps `class display name -> Discord custom emoji`.

## How these icons reach Discord

Discord cannot render local PNG files inline. To use these as inline icons in
embed body / dropdown labels you have to upload each PNG as a **guild custom
emoji** in the Thaemine server, then wire the emoji ID into
`data/Class.js`'s `CLASS_EMOJI_MAP`.

### Recommended: bulk upload via script

```bash
node scripts/upload-class-emoji.js          # idempotent: skip existing
node scripts/upload-class-emoji.js --dry    # validate setup, no upload
node scripts/upload-class-emoji.js --force  # re-upload even if exists
```

The script uses `DISCORD_TOKEN` + `GUILD_ID` from `.env`, calls Discord REST
`POST /guilds/{guild.id}/emojis` for each PNG, and writes the resulting
`{ displayName: "<:emoji:id>" }` map to `assets/class-icons/emoji-map.json`.
`data/Class.js` auto-merges that JSON into `CLASS_EMOJI_MAP` at startup, so
the only follow-up steps after running the script are: `git add` the new
`emoji-map.json`, commit, push - bot picks up class icons on next deploy.

Requirements:
- Bot must have **Manage Expressions** permission (formerly "Manage Emojis
  and Stickers") in the target guild
- Discord guild has at least 25 free emoji slots (alias classes share a
  slot, so the script uses ~25 of the 50 free slots / 250 boosted)
- Bot rate limit: ~50 emoji uploads / 30s per guild; the script sleeps
  250ms between uploads so a full 25-emoji run takes ~7 seconds

### Manual fallback: Discord UI

If the script can't run (no bot permission, etc.), fall back to manual:

1. Open Thaemine **Server Settings -> Emoji -> Upload Emoji**.
2. Upload each PNG with the bible class ID as the emoji name (e.g.
   `bard.png` -> emoji name `bard`). Discord allows lowercase + underscores
   only; the filenames here already follow that convention.
3. After upload, send a test message in any channel: `\:bard:` (the leading
   backslash makes Discord show the raw `<:bard:123456789012345678>` form).
4. Copy the full `<:name:id>` string and paste it into the corresponding entry
   of `CLASS_EMOJI_MAP` in `src/data/Class.js` (or into the JSON file).

The map starts empty - `getClassEmoji(name)` returns an empty string for any
class whose ID isn't in the map yet, so the bot keeps rendering cleanly while
you fill in entries one at a time. Once filled, `${getClassEmoji(char.class)}`
in the char field renderers prepends the icon before the character name.

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
| infighter_male | Breaker | Martial Artist advanced class - try Inven post below |
| alchemist | Wildsoul | Specialist advanced class - try Inven post below |
| holyknight_female | Valkyrie | Warrior advanced class (support) - try Inven post below |
| dragon_knight | Guardian Knight | Warrior advanced class - try Inven post below |
| scouter | Machinist | Currently placeholder = Artillerist art |

**For the 4 still missing:** [Inven post (Korean community, 2024) - 26 class logos as AI vector + PNG](https://www.inven.co.kr/board/lostark/6271/144967) bundles all classes including the newer ones via Naver Blog download links organized by region (Shushire / Sileen / Arthétain / Anytis / Darenyu / Specialists). Filename naming convention: drop into this folder as the matching bible class ID (`infighter_male.png` for Breaker, `alchemist.png` for Wildsoul, `holyknight_female.png` for Valkyrie, `dragon_knight.png` for Guardian Knight).

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
