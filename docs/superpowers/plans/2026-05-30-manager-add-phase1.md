# Manager-add Member (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a lead/Raid Manager add a specific member into a `/raid-schedule-preview` comp (pick user, pick a character from that user's roster), with a public ping so the added person is notified.

**Architecture:** Additive on the shipped self-service board. New lead-only Manage button `➕ Thêm người` opens a native Discord User Select (`rse:adduser:<eventId>`); selecting a user loads their roster and shows a character String Select (`rse:addpick:<targetId>:<eventId>`); selecting a character writes the signup on the target's behalf by reusing the existing pure `applyJoin`, re-renders the board, and pings the user publicly. Works even when the board is locked (manager-add bypasses lock).

**Tech Stack:** Node.js, discord.js v14 (UserSelectMenuBuilder = component type 5), Mongoose (RaidEvent/User), node:test. Spec: `docs/superpowers/specs/2026-05-30-manager-driven-comp-design.md`.

---

## File Structure

- `bot/services/discord/interaction-router.js` - **modify** the select dispatch (~line 91) so User Select interactions also route through `selectRoutes` (currently String Select only). This is the critical wiring fix.
- `bot/commands.js` - **modify** the discord.js import (~line 4) + the `createRaidScheduleCommand({...})` deps (~line 761) to provide `UserSelectMenuBuilder`.
- `bot/handlers/raid/schedule/index.js` - **modify**: destructure `UserSelectMenuBuilder` from deps; add `addUserSelectPayload` / `addCharSelectPayload` / `handleAddMember` / `handleAddUserSelect` / `handleAddPickSelect`; add the `➕ Thêm người` button to the Manage menu `peopleRow`; add three routes (`addmember` button, `adduser` + `addpick` selects).
- `bot/locales/vi.js`, `bot/locales/en.js`, `bot/locales/jp.js` - **modify**: add `btn.addMember`, the `addMember.*` block, and the `notice.add*` keys (parity across all three).
- `test/interaction-router-registry.test.js` - **modify**: add a test asserting a User Select with `rse:` prefix routes to `handleRaidScheduleSelect`.
- `README.md`, `bot/locales/*` raid-help section, `CHANGELOG.md` - **modify**: sync docs.

---

## Task 1: Router dispatches User Select to selectRoutes

**Files:**
- Modify: `bot/services/discord/interaction-router.js:91`
- Test: `test/interaction-router-registry.test.js`

- [ ] **Step 1: Write the failing test**

Add this test to `test/interaction-router-registry.test.js` (after the existing `"raid-schedule-preview component routes dispatch through rse custom IDs"` test):

```javascript
test("raid-schedule-preview routes a User Select (add-member) through rse selects", async () => {
  let selectCalls = 0;
  const noop = async () => {};
  const handlers = {
    handleRaidManagementCommand: noop,
    handleRaidHelpSelect: noop,
    handleRaidLanguageSelect: noop,
    handleRaidSetAutocomplete: noop,
    handleEditRosterAutocomplete: noop,
    handleRemoveRosterAutocomplete: noop,
    handleRaidChannelAutocomplete: noop,
    handleRaidAutoManageAutocomplete: noop,
    handleRaidAnnounceAutocomplete: noop,
    handleRaidTaskAutocomplete: noop,
    handleRaidGoldEarnerAutocomplete: noop,
    handleRaidScheduleButton: noop,
    handleRaidScheduleSelect: async () => { selectCalls += 1; },
  };
  const router = createRaidInteractionRouter({
    MessageFlags: { Ephemeral: 64 },
    handlers,
  });

  await router.handle({
    isChatInputCommand: () => false,
    isAutocomplete: () => false,
    isStringSelectMenu: () => false,
    isUserSelectMenu: () => true,
    isButton: () => false,
    customId: "rse:adduser:abcdef123456",
  });

  assert.equal(selectCalls, 1);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/interaction-router-registry.test.js`
Expected: the new test FAILS (`selectCalls` is 0) because the dispatcher only checks `isStringSelectMenu()`, so the User Select falls through unrouted. The other tests still pass.

- [ ] **Step 3: Broaden the select dispatch**

In `bot/services/discord/interaction-router.js`, change line ~91 from:

```javascript
    if (interaction.isStringSelectMenu()) {
```

to:

```javascript
    // User Select (component type 5) routes through the same selectRoutes as
    // String Select - the add-member flow uses a native user picker. Optional
    // call so callers/mocks without the method (older tests) stay safe.
    if (interaction.isStringSelectMenu() || interaction.isUserSelectMenu?.()) {
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/interaction-router-registry.test.js`
Expected: ALL tests PASS, including the new User Select test, and the existing button/string-select dispatch test (its button mock has no `isUserSelectMenu`, but `?.()` returns undefined → falsy → still routes to the button branch).

- [ ] **Step 5: Commit**

```bash
git add bot/services/discord/interaction-router.js test/interaction-router-registry.test.js
git commit -m "raid-schedule: route User Select through selectRoutes (for add-member)"
```

---

## Task 2: i18n keys for manager-add (vi/en/jp parity)

**Files:**
- Modify: `bot/locales/vi.js`, `bot/locales/en.js`, `bot/locales/jp.js`

- [ ] **Step 1: Add the button label + addMember block + notices to `vi.js`**

In `bot/locales/vi.js`, inside `"raid-schedule".btn`, add `kick`'s neighbor:

```javascript
      kick: "👋 Kick",
      addMember: "➕ Thêm người",
```

After the `kick: { ... }` block (the one ending `placeholder: "Chọn người để kick...",`), add a new sibling block:

```javascript
    addMember: {
      title: "Thêm người vào đội",
      intro: "Chọn member cậu muốn xếp vào raid này nha~ Artist sẽ lấy roster của họ ra cho cậu pick char.",
      userPlaceholder: "Chọn người để thêm...",
      charTitle: "Chọn character",
      charIntro: "Pick một char đủ iLvl trong roster của {user} nha~ Char dưới mốc Artist ẩn đi rồi.",
      charPlaceholder: "Chọn character...",
    },
```

Inside `"raid-schedule".notice`, after `kickedDescription`, add:

```javascript
      addedTitle: "Đã thêm vào đội~",
      addedDescription: "Artist xếp {user} vào đội với **{character}** rồi nha.",
      addedPing: "{user} cậu vừa được lead xếp vào **{title}** ({character}), khởi raid {rel} nha~ Mở board hoặc /raid-status để xem chi tiết.",
      addNoRosterTitle: "Người này chưa có roster",
      addNoRosterDescription: "{user} chưa đăng ký roster với Artist nên không có char để xếp. Nhờ họ /raid-add-roster trước (hoặc cậu add hộ qua /raid-add-roster target:) nha.",
      addNoEligibleTitle: "Không có char đủ iLvl",
      addNoEligibleDescription: "Roster của {user} chưa có char nào đạt iLvl {ilvl}+ cho raid này nha.",
      addBotTargetTitle: "Không thêm bot được",
      addBotTargetDescription: "Target phải là người chơi thật, không phải bot nha~",
```

- [ ] **Step 2: Add the same keys to `en.js`**

In `bot/locales/en.js`, `btn`:

```javascript
      kick: "👋 Kick",
      addMember: "➕ Add member",
```

New `addMember` block after the `kick` block:

```javascript
    addMember: {
      title: "Add a member",
      intro: "Pick the member you want to slot into this raid~ Artist will pull up their roster so you can choose a character.",
      userPlaceholder: "Pick someone to add...",
      charTitle: "Pick a character",
      charIntro: "Pick a character at iLvl from {user}'s roster~ Anything under the bar is hidden.",
      charPlaceholder: "Pick a character...",
    },
```

`notice`, after `kickedDescription`:

```javascript
      addedTitle: "Added to the comp~",
      addedDescription: "Artist slotted {user} in with **{character}**.",
      addedPing: "{user} the lead just slotted you into **{title}** ({character}), raid starts {rel}~ Open the board or /raid-status for details.",
      addNoRosterTitle: "No roster for that user",
      addNoRosterDescription: "{user} hasn't registered a roster with Artist, so there's no character to slot. Ask them to /raid-add-roster first (or add it for them via /raid-add-roster target:).",
      addNoEligibleTitle: "No character at iLvl",
      addNoEligibleDescription: "{user}'s roster has no character at iLvl {ilvl}+ for this raid.",
      addBotTargetTitle: "Can't add a bot",
      addBotTargetDescription: "The target has to be a real player, not a bot~",
```

- [ ] **Step 3: Add the same keys to `jp.js`**

In `bot/locales/jp.js`, `btn`:

```javascript
      kick: "👋 Kick",
      addMember: "➕ メンバー追加",
```

New `addMember` block after the `kick` block:

```javascript
    addMember: {
      title: "メンバーを追加",
      intro: "このレイドに入れたいメンバーを選んでね~ Artist がその人のロスターを出すから char を選んでね。",
      userPlaceholder: "追加する人を選んでね...",
      charTitle: "character を選ぶ",
      charIntro: "{user} のロスターから iLvl 足りてる char を選んでね~ 足りないのは隠してるよ。",
      charPlaceholder: "character を選ぶ...",
    },
```

`notice`, after `kickedDescription`:

```javascript
      addedTitle: "追加したよ~",
      addedDescription: "Artist が {user} を **{character}** で編成に入れたよ。",
      addedPing: "{user} lead が **{title}**（{character}）に入れたよ、開始 {rel} ね~ board か /raid-status で詳細を見てね。",
      addNoRosterTitle: "この人はロスター未登録",
      addNoRosterDescription: "{user} はまだ Artist にロスターを登録してないから入れる char が無いよ。先に /raid-add-roster してもらってね（または /raid-add-roster target: で代理登録）。",
      addNoEligibleTitle: "iLvl 足りる char が無い",
      addNoEligibleDescription: "{user} のロスターにこのレイドの iLvl {ilvl}+ の char が無いよ。",
      addBotTargetTitle: "bot は追加できない",
      addBotTargetDescription: "対象は bot じゃなく実プレイヤーにしてね~",
```

- [ ] **Step 4: Run the i18n parity test**

Run: `node --test test/raid-schedule-i18n.test.js test/i18n-parity.test.js 2>$null; node --test 2>&1 | Select-String "# pass|# fail"`
(If the exact parity test filename differs, run the full suite.) Expected: parity test PASS (vi/en/jp share the same leaf keys), full suite still green.

- [ ] **Step 5: Commit**

```bash
git add bot/locales/vi.js bot/locales/en.js bot/locales/jp.js
git commit -m "raid-schedule: i18n keys for manager-add (vi/en/jp parity)"
```

---

## Task 3: Manager-add handlers + Manage button + routing

**Files:**
- Modify: `bot/commands.js:4` (import), `bot/commands.js:761` (deps)
- Modify: `bot/handlers/raid/schedule/index.js` (factory destructure ~line 39; new functions; Manage button; routing)

- [ ] **Step 1: Provide `UserSelectMenuBuilder` to the command factory**

In `bot/commands.js`, add to the discord.js import (after `StringSelectMenuBuilder,` on line ~4):

```javascript
  UserSelectMenuBuilder,
```

In the `createRaidScheduleCommand({ ... })` call (~line 761), add after `StringSelectMenuBuilder,`:

```javascript
  UserSelectMenuBuilder,
```

- [ ] **Step 2: Destructure it in the factory**

In `bot/handlers/raid/schedule/index.js`, in the `function createRaidScheduleCommand({ ... })` parameter list, add after `StringSelectMenuBuilder,` (line ~39):

```javascript
  UserSelectMenuBuilder,
```

- [ ] **Step 3: Add the add-member payloads + handlers**

In `bot/handlers/raid/schedule/index.js`, immediately AFTER the `handleKickSelect` function's closing brace (before `function markTurns`), insert:

```javascript
  // Lead add-member: a native User Select picks the target, then a char Select
  // (the target's eligible roster) writes the signup on their behalf via
  // applyJoin. Works even when locked (manager-add bypasses the lock gate).
  function addUserSelectPayload(event, lang) {
    const select = new UserSelectMenuBuilder()
      .setCustomId(`rse:adduser:${event._id}`)
      .setPlaceholder(t("raid-schedule.addMember.userPlaceholder", lang))
      .setMinValues(1)
      .setMaxValues(1);
    return {
      embeds: [
        noticeEmbed(
          "success",
          t("raid-schedule.addMember.title", lang),
          t("raid-schedule.addMember.intro", lang),
        ),
      ],
      components: [new ActionRowBuilder().addComponents(select)],
      flags: ephemeralFlag,
    };
  }

  function addCharSelectPayload(event, targetId, rows, lang) {
    const options = rows.slice(0, PICKER_LIMIT).map((row) => {
      const roleKey = row.role === "support" ? "support" : "dps";
      const cleared = row.alreadyCleared
        ? ` ${t("raid-schedule.picker.alreadyClearedSuffix", lang)}`
        : "";
      const emoji = classEmojiOption(row.className);
      return {
        label: clip(row.name, 100),
        value: String(row.index),
        description: clip(
          `${row.accountName} · ${row.itemLevel} · ${t(`raid-schedule.picker.role.${roleKey}`, lang)}${cleared}`,
          100,
        ),
        ...(emoji ? { emoji } : {}),
      };
    });
    const select = new StringSelectMenuBuilder()
      .setCustomId(`rse:addpick:${targetId}:${event._id}`)
      .setPlaceholder(t("raid-schedule.addMember.charPlaceholder", lang))
      .setMinValues(1)
      .setMaxValues(1)
      .addOptions(options);
    return {
      embeds: [
        noticeEmbed(
          "success",
          t("raid-schedule.addMember.charTitle", lang),
          t("raid-schedule.addMember.charIntro", lang, { user: `<@${targetId}>` }),
        ),
      ],
      components: [new ActionRowBuilder().addComponents(select)],
    };
  }

  async function handleAddMember(interaction, event, lang) {
    if (!isLeadActionAllowed(interaction)) {
      await replyNotice(interaction, lang, "danger", "managerOnlyTitle", "managerOnlyDescription");
      return;
    }
    // No lock check on purpose: manager-add is allowed on a locked board.
    if (event.status === "cleared" || event.status === "cancelled") {
      await replyNotice(interaction, lang, "warn", "eventClosedTitle", "eventClosedDescription");
      return;
    }
    await interaction.reply(addUserSelectPayload(event, lang));
  }

  async function handleAddUserSelect(interaction, event, lang) {
    if (!isLeadActionAllowed(interaction)) {
      await editNotice(interaction, lang, "danger", "managerOnlyTitle", "managerOnlyDescription");
      return;
    }
    if (event.status === "cleared" || event.status === "cancelled") {
      await editNotice(interaction, lang, "warn", "eventClosedTitle", "eventClosedDescription");
      return;
    }
    const targetId = interaction.values?.[0];
    if (!targetId) {
      await editNotice(interaction, lang, "warn", "pickerStaleTitle", "pickerStaleDescription");
      return;
    }
    const targetUser = await interaction.client.users.fetch(targetId).catch(() => null);
    if (targetUser?.bot) {
      await editNotice(interaction, lang, "warn", "addBotTargetTitle", "addBotTargetDescription");
      return;
    }
    const userDoc = await User.findOne({ discordId: targetId }).lean();
    if (!userDoc || !Array.isArray(userDoc.accounts) || userDoc.accounts.length === 0) {
      await editNotice(interaction, lang, "warn", "addNoRosterTitle", "addNoRosterDescription", {
        user: `<@${targetId}>`,
      });
      return;
    }
    const rows = findOwnEligibleRows(userDoc, event);
    if (rows.length === 0) {
      await editNotice(interaction, lang, "warn", "addNoEligibleTitle", "addNoEligibleDescription", {
        user: `<@${targetId}>`,
        ilvl: event.minItemLevel,
      });
      return;
    }
    const payload = addCharSelectPayload(event, targetId, rows, lang);
    await interaction.editReply({ embeds: payload.embeds, components: payload.components });
  }

  async function handleAddPickSelect(interaction, event, lang) {
    if (!isLeadActionAllowed(interaction)) {
      await editNotice(interaction, lang, "danger", "managerOnlyTitle", "managerOnlyDescription");
      return;
    }
    if (event.status === "cleared" || event.status === "cancelled") {
      await editNotice(interaction, lang, "warn", "eventClosedTitle", "eventClosedDescription");
      return;
    }
    const parsed = parseCustomId(interaction.customId);
    const targetId = parsed.action.split(":")[1];
    if (!targetId) {
      await editNotice(interaction, lang, "warn", "pickerStaleTitle", "pickerStaleDescription");
      return;
    }
    const rowIndex = Number(interaction.values?.[0]);
    const userDoc = await User.findOne({ discordId: targetId }).lean();
    const rows = findOwnEligibleRows(userDoc, event);
    const row = rows.find((candidate) => candidate.index === rowIndex);
    if (!row) {
      await editNotice(interaction, lang, "warn", "pickerStaleTitle", "pickerStaleDescription");
      return;
    }

    const before = Array.from(event.signups || []);
    const next = applyJoin(before, {
      discordId: targetId,
      accountName: row.accountName,
      characterName: row.name,
      characterClass: row.className,
      characterItemLevel: row.itemLevel,
      alreadyClearedThisWeek: row.alreadyCleared,
    });
    markSignups(event, next);
    await event.save();

    const langForBoard = await boardLang(event.guildId);
    await editBoardMessage(interaction, event, langForBoard);
    await interaction.editReply({
      embeds: [
        noticeEmbed(
          "success",
          t("raid-schedule.notice.addedTitle", lang),
          t("raid-schedule.notice.addedDescription", lang, {
            user: `<@${targetId}>`,
            character: row.name,
          }),
        ),
      ],
      components: [],
    });

    // Public ping so the added user actually gets notified (mentions only fire
    // from message content, not embeds · see feedback_discord_embed_mentions).
    try {
      const channel = await interaction.client.channels.fetch(event.channelId);
      await channel?.send?.({
        content: t("raid-schedule.notice.addedPing", langForBoard, {
          user: `<@${targetId}>`,
          title: event.title || "",
          character: row.name,
          rel: `<t:${Math.floor(new Date(event.startAt).getTime() / 1000)}:R>`,
        }),
      });
    } catch (error) {
      console.warn("[raid-schedule] add-member ping failed:", error?.message || error);
    }
  }
```

- [ ] **Step 4: Add the `➕ Thêm người` button to the Manage menu**

In `manageMenuPayload`, the `peopleRow` currently holds teams + kick. Insert the add button between them:

```javascript
    const peopleRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`rse:teams:${id}`)
        .setLabel(t("raid-schedule.btn.teams", lang))
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`rse:addmember:${id}`)
        .setLabel(t("raid-schedule.btn.addMember", lang))
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`rse:kick:${id}`)
        .setLabel(t("raid-schedule.btn.kick", lang))
        .setStyle(ButtonStyle.Danger),
    );
```

- [ ] **Step 5: Wire the three routes**

In `handleRaidScheduleButton`, after the `teams` route line (`if (parsed.action === "teams") return handleTeams(...)`), add:

```javascript
    if (parsed.action === "addmember") return handleAddMember(interaction, event, lang);
```

In `handleRaidScheduleSelect`, after the `kickpick` route line, add:

```javascript
    if (parsed.action === "adduser") return handleAddUserSelect(interaction, event, lang);
    if (parsed.action.startsWith("addpick")) return handleAddPickSelect(interaction, event, lang);
```

- [ ] **Step 6: Require-smoke + full suite**

Run:
```
node -e "require('./bot/handlers/raid/schedule/index.js'); require('./bot/commands.js'); console.log('require-smoke OK');"
node --test
```
Expected: `require-smoke OK`, and the full suite green (514+ tests, 0 fail). The i18n parity test passes (keys added in Task 2).

- [ ] **Step 7: Commit**

```bash
git add bot/commands.js bot/handlers/raid/schedule/index.js
git commit -m "raid-schedule: lead add-member (User Select target + char pick + public ping)"
```

---

## Task 4: Sync docs (raid-help + README + CHANGELOG)

**Files:**
- Modify: `bot/locales/vi.js`, `bot/locales/en.js`, `bot/locales/jp.js` (raid-help `raid-schedule-preview` notes)
- Modify: `README.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Add a raid-help note in all three locales**

In each locale's `raid-help.sections."raid-schedule-preview".notes`, add a bullet after the Manage bullet. vi.js:

```javascript
          "**➕ Thêm người**: lead tự xếp người vào đội (chọn user → chọn char đủ iLvl trong roster họ). Chạy được cả khi board đang Khóa. Người được thêm sẽ nhận ping.",
```

en.js:

```javascript
          "**➕ Add member**: the lead slots someone in directly (pick a user, then an iLvl-eligible character from their roster). Works even when the board is locked. The added player gets pinged.",
```

jp.js:

```javascript
          "**➕ メンバー追加**: lead が直接メンバーを編成に入れる（user を選ぶ → その人のロスターから iLvl 足りてる char を選ぶ）。board がロック中でも使える。追加された人には ping が飛ぶよ。",
```

Also update the Manage bullet in each to mention the add button (vi example):

```javascript
          "**Manage**: lead bấm Quản lý để Khóa/Mở khóa, End, đặt phòng/mật khẩu, sửa giờ, hủy event, 🧩 Phân turn, ➕ Thêm người, hoặc 👋 Kick.",
```

(Apply the equivalent edit in en.js and jp.js Manage bullets.)

- [ ] **Step 2: Update README**

In `README.md`, the `/raid-schedule-preview` feature bullet (~line 13) and command-table row (~line 30): add the add-member capability to the Manage menu list. Example bullet edit:

```markdown
- Raid signup board preview (`/raid-schedule-preview`): Support/DPS slots, waitlist, RSVP, auto-lock, a lead Manage menu (incl. add-member with public ping + member kick with auto waitlist-promotion), multi-turn (bus) team assignment, and a `show` turn plan; party size is derived from the selected raid (Act 4/Kazeros = 8, Serca = 4)
```

In the command-table row, append to the Manage list: `add-member (pick user + character from their roster, pings them; works while locked)`.

- [ ] **Step 3: Add a CHANGELOG entry**

In `CHANGELOG.md`, add a dated section at the top of the entries:

```markdown
## 2026-05-30 (raid-schedule: lead add-member)

### Added
- Lead add-member for `/raid-schedule-preview`. Manage menu gains a `➕ Thêm người` button (green, between Phân turn and Kick) that opens a native Discord User Select; picking a user loads their registered roster and shows an iLvl-eligible character Select; picking a character writes the signup on their behalf via the existing `applyJoin` and pings them publicly. Works even when the board is locked (manager-add bypasses the lock gate). Added members are full comp members (auto-cleared on End like everyone). No roster / no eligible char / bot target are handled with gentle notices.
- Interaction router now routes User Select (component type 5) through the same `selectRoutes` as String Select. Locale strings (vi/en/jp parity), `/raid-help`, and README synced. Tests green across two runs.
```

- [ ] **Step 4: Verify + commit**

Run: `node --test 2>&1 | Select-String "# pass|# fail"`
Expected: green (parity stays intact after the raid-help additions).

```bash
git add bot/locales/vi.js bot/locales/en.js bot/locales/jp.js README.md CHANGELOG.md
git commit -m "raid-schedule: sync raid-help + README + CHANGELOG for add-member"
```

---

## Task 5: Final verification + push

- [ ] **Step 1: Run the full suite twice**

Run (twice): `node --test 2>&1 | Select-String "# tests|# pass|# fail"`
Expected both runs: all tests pass, 0 fail.

- [ ] **Step 2: Require-smoke the whole command surface**

Run: `node -e "require('./bot/commands.js'); console.log('OK');"`
Expected: `OK` (no missing-symbol / syntax errors).

- [ ] **Step 3: Push**

```bash
git push origin main
```
Expected: push succeeds; Railway auto-deploys.

- [ ] **Step 4: Hand back for Discord smoke-test**

Tell Traine to smoke-test after deploy: `/raid-schedule-preview create` -> Quản lý -> `➕ Thêm người` -> pick a user -> pick a character -> confirm the board updates, the user is pinged, and (no roster / bot) edge notices behave. Also confirm add works while the board is Locked.

---

## Self-Review (Phase 1 coverage vs spec)

- Spec "Phase 1 - Manager-add" flow (User Select -> char Select -> applyJoin -> board + ping): Tasks 2-3. ✓
- Manager-add bypasses lock: Task 3 Step 3 (no lock check in `handleAddMember`; comment notes it). ✓
- Roster source = target's registered roster, no free-type: Task 3 uses `User.findOne({discordId: targetId})` + `findOwnEligibleRows`. ✓
- Consent = full member, auto-clear uniform: reuses `applyJoin` (same signup shape), no special flag. ✓
- Edges (no roster / no eligible / bot / stale): Task 3 `handleAddUserSelect` + `handleAddPickSelect`. ✓
- Routing under existing `rse:` prefixes + the User Select dispatch fix: Task 1 + Task 3 Step 5. ✓
- `UserSelectMenuBuilder` dep: Task 3 Steps 1-2. ✓
- i18n vi/en/jp parity: Task 2. ✓
- Docs synced (raid-help + README + CHANGELOG): Task 4. ✓
- TDD: Task 1 (router) is test-first. The handler layer follows the shipped untested-handler convention (teams/kick) - verified by require-smoke + full suite + Traine's Discord smoke-test (noted in spec's Testing section).
- Out of scope (Phase 2 "Raid của tôi", per-turn rooms, free-type, no-auto-clear flag): not in this plan. ✓
