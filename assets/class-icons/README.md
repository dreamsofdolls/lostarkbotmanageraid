# Class Icons

PNG sources for the 27 Lost Ark classes the bot's `data/Class.js`
recognizes. Filenames match the **bible class ID** (the key in
`CLASS_NAMES`) so the bootstrap can derive every other identifier
(emoji name, display name) from the filename alone.

## How these icons reach Discord

Discord cannot render local PNG files inline. Each PNG has to be
registered as a Discord **application emoji** (owned by the bot
application, not by any single guild) before the bot can reference it
as `<:bard_a3f9b2:123>` in embed text. **The bot does this for you on
startup** - just drop the PNG into this folder and push.

### The deploy flow

1. Drop a PNG into this folder, named after the bible class ID
   (`bard.png`, `holyknight.png`, etc.). The filenames already in this
   folder follow that convention.
2. `git add` + commit + push.
3. Railway redeploys. On `ClientReady`,
   `src/services/class-emoji-bootstrap.js` runs:
   - Lists existing application emoji via
     `GET /applications/{appId}/emojis`
   - For each PNG: computes expected name as
     `{bibleClassId}_{md5short}` where `md5short` is the first 6 chars
     of the PNG's MD5 hash
   - Reuses if an emoji with the expected name already exists
   - Refreshes (delete + re-upload) if an emoji exists for the bible
     ID but with a different hash suffix (or no suffix at all)
   - Uploads if no emoji exists for the bible ID
   - Mutates `CLASS_EMOJI_MAP` in memory with the resulting
     `<:name:id>` strings
4. Next time someone runs `/raid-status` or `/raid-check`, char fields
   render `<:bard_a3f9b2:123> Cyrano · 1740` instead of bare
   `Cyrano · 1740`.

The bootstrap is **content-addressed** (any PNG content change is
auto-detected via the MD5 hash suffix and triggers a refresh), and
**self-healing** (deleting an emoji from the developer portal causes
the next bot restart to re-upload it).

### Why application emoji instead of guild emoji

- **Owned by the bot application, not any single guild**, so the bot
  can use them in every guild it joins (future-proof for multi-server)
- **Don't consume Thaemine's 50-slot guild emoji budget** which is
  community-shared with member-uploaded emoji
- **No "Manage Expressions" permission** needed in any guild - emoji
  are application assets the bot owns
- **2000 emoji slot per application** vs 50 free / 250 boosted per
  guild

### Color caveat for community AI vector sources

Game-UI rips (Fandom Wiki) are **white-on-transparent**, designed for
dark UI overlay - they render correctly on Discord dark mode without
modification.

Community AI vector packs (Inven post, etc.) often ship as
**black-on-transparent** because they're authored against white
print/web backgrounds. Drop one into Discord dark mode unmodified and
the silhouette vanishes.

To convert a black silhouette to white while preserving alpha:

```bash
pip install Pillow  # one-time
python scripts/invert-icon.py assets/class-icons/<file>.png
```

The bot bootstrap will detect the content change on next deploy
(different MD5 → different hash suffix → delete + re-upload).

### Aspect ratio for non-square sources

Folder convention is 320x320 PNG. If a source is non-square (e.g. some
Discord emoji rips are 86x96 or 46x46), upscale + pad with transparent
background instead of stretching. Example pipeline used for the
Wildsoul / Valkyrie / Guardian Knight rips:

```python
from PIL import Image
img = Image.open(src).convert("RGBA")
TARGET = 320
w, h = img.size
scale = TARGET / max(w, h)
resized = img.resize((int(w * scale), int(h * scale)), Image.LANCZOS)
canvas = Image.new("RGBA", (TARGET, TARGET), (0, 0, 0, 0))
canvas.paste(resized, ((TARGET - resized.width) // 2,
                       (TARGET - resized.height) // 2), resized)
canvas.save(dst, "PNG", optimize=True)
```

## Source attribution

| Bible class ID | Display name | Source |
|---|---|---|
| berserker | Berserker | Lost Ark Wiki (Fandom) |
| berserker_female | Slayer | Lost Ark Wiki (Fandom) |
| warlord | Gunlancer | Lost Ark Wiki (Fandom) |
| holyknight | Paladin | Lost Ark Wiki (Fandom) |
| holyknight_female | Valkyrie | Discord emoji rip (white silhouette, upscaled 46→320) |
| destroyer | Destroyer | Lost Ark Wiki (Fandom) |
| dragon_knight | Guardian Knight | Discord emoji rip (white silhouette, upscaled 96→320) |
| battle_master | Wardancer | Lost Ark Wiki (Fandom) |
| infighter | Scrapper | Lost Ark Wiki (Fandom) |
| infighter_male | Breaker | Inven AI vector (inverted to white via `invert-icon.py`) |
| soulmaster | Soulfist | Lost Ark Wiki (Fandom) |
| force_master | Soulfist | Alias of `soulmaster.png` |
| lance_master | Glaivier | Lost Ark Wiki (Fandom) |
| battle_master_male | Striker | Lost Ark Wiki (Fandom) |
| devil_hunter | Deadeye | Lost Ark Wiki (Fandom) |
| devil_hunter_female | Gunslinger | Lost Ark Wiki (Fandom) |
| blaster | Artillerist | Lost Ark Wiki (Fandom) |
| hawkeye | Sharpshooter | Lost Ark Wiki (Fandom) |
| hawk_eye | Sharpshooter | Alias of `hawkeye.png` |
| scouter | Machinist | Lost Ark Wiki (Fandom, uncategorized file) |
| bard | Bard | Lost Ark Wiki (Fandom) |
| arcana | Arcanist | Lost Ark Wiki (Fandom) |
| summoner | Summoner | Lost Ark Wiki (Fandom) |
| elemental_master | Sorceress | Lost Ark Wiki (Fandom) |
| blade | Deathblade | Lost Ark Wiki (Fandom) |
| demonic | Shadow Hunter | Lost Ark Wiki (Fandom) |
| reaper | Reaper | Lost Ark Wiki (Fandom) |
| soul_eater | Souleater | Lost Ark Wiki (Fandom, uncategorized file) |
| yinyangshi | Artist | Lost Ark Wiki (Fandom) |
| weather_artist | Aeromancer | Lost Ark Wiki (Fandom) |
| alchemist | Wildsoul | Discord emoji rip (white silhouette, 86x96 padded → 320x320) |

**Coverage:** All 27 known Lost Ark classes (2026-04-26). If Smilegate
releases a new class, add an entry to `CLASS_NAMES` in
`src/data/Class.js` + drop the PNG here named after the bible class
ID. Bot bootstrap auto-uploads on next deploy.

The Fandom-sourced icons fall under
[Creative Commons Attribution-Share Alike (CC BY-SA)](https://www.fandom.com/licensing).
Images were retrieved from
<https://lostark.fandom.com/wiki/Category:Class_Icons> via the Fandom
MediaWiki API (April 2026 snapshot). If you redistribute the bot or
this asset folder, preserve attribution to Lost Ark Wiki.
