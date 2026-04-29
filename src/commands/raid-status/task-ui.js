const { getClassEmoji } = require("../../data/Class");
const { buildAccountTaskFields } = require("../../raid/task-view");

function createRaidStatusTaskUi(deps) {
  const {
    EmbedBuilder,
    ActionRowBuilder,
    StringSelectMenuBuilder,
    UI,
    getCharacterName,
    truncateText,
    getAccounts,
    getCurrentPage,
    getCurrentView,
    getTaskCharFilter,
  } = deps;

    // Parse a Discord custom-emoji string `<:name:id>` (or `<a:name:id>`
    // for animated) into an object the StringSelectMenu option's `emoji`
    // property accepts. Returns null on miss so callers can `|| undefined`
    // to skip the emoji slot. StringSelectMenu does NOT render custom
    // emoji embedded in the label string - it shows the raw `<:name:id>`
    // text - so the emoji has to ride the structured field instead.
    const parseCustomEmoji = (raw) => {
      if (typeof raw !== "string" || raw.length === 0) return null;
      const match = raw.match(/^<(a?):([^:]+):(\d+)>$/);
      if (!match) return null;
      return {
        animated: match[1] === "a",
        name: match[2],
        id: match[3],
      };
    };

    // Build the Task-view embed for the current page's account. Body
    // (per-char fields + 2-column ZWS-spacer packing + totals math) is
    // delegated to the shared `buildAccountTaskFields` helper so the
    // /raid-check Manager Task view renders the same look
    // without duplicating ~80 LOC of layout code. This wrapper owns
    // the surface-specific bits: title, description, the "🌟 sắp có"
    // placeholder, and the page-indicator footer.
    const buildTaskViewEmbed = (account) => {
      const accountName = String(account?.accountName || "(unnamed roster)");
      const embed = new EmbedBuilder()
        .setColor(UI.colors.neutral)
        .setTitle(`📝 Side tasks · ${accountName}`);

      const { fields, totals } = buildAccountTaskFields(account, {
        UI,
        getClassEmoji,
        truncateText,
      });

      if (totals.charsWithTasks === 0) {
        embed.setDescription(
          [
            "Account này chưa có side task nào nha.",
            "",
            "**Cách thêm:** `/raid-task add character:<char> name:<tên> reset:<daily|weekly>`",
            "**Cap:** 3 daily + 5 weekly mỗi character.",
            "**Auto-reset:** Daily 17:00 VN · Weekly 17:00 VN thứ 4.",
          ].join("\n")
        );
        return embed;
      }

      embed.setDescription(
        [
          "Bấm dropdown bên dưới để toggle complete cho từng task.",
          `Auto-reset: Daily 17:00 VN ${UI.icons.reset} Weekly 17:00 VN thứ 4.`,
        ].join("\n")
      );

      embed.addFields(...fields);

      // Placeholder field for the upcoming "shared task per roster"
      // feature - one task definition that applies to every char in
      // the account (vs the current per-char model). Sits between the
      // char cards and the footer legend so users see the roadmap at
      // a glance. Artist-voice copy keeps the persona consistent.
      // Remove this addFields() block when the real feature lands.
      embed.addFields({
        name: "🌟 Task chung của roster (sắp có)",
        value: [
          "Tớ ngóng feature này dữ lắm~ Sắp tới mỗi roster sẽ có thêm 1 list task **áp cho mọi char trong account** (kiểu chore chung Owner đăng ký, không phải gõ `/raid-task add` cho từng con).",
          "Trong lúc chờ, cậu cứ dùng `action:all` ở `/raid-task add` để bulk add tạm cho mọi char nha~",
        ].join("\n"),
        inline: false,
      });

      const footerParts = [];
      if (totals.daily > 0) {
        footerParts.push(`${UI.icons.done} ${totals.dailyDone}/${totals.daily} daily`);
      }
      if (totals.weekly > 0) {
        footerParts.push(`${UI.icons.done} ${totals.weeklyDone}/${totals.weekly} weekly`);
      }
      if (getAccounts().length > 1) {
        footerParts.push(`Page ${getCurrentPage() + 1}/${getAccounts().length}`);
      }
      if (footerParts.length > 0) {
        embed.setFooter({ text: footerParts.join(" · ") });
      }
      return embed;
    };

    const buildViewToggleRow = (disabled) => {
      const options = [
        {
          label: "Tiến độ raid",
          description: "Xem progress raid đã/chưa clear theo từng character",
          value: "raid",
          emoji: "📋",
          default: getCurrentView() === "raid",
        },
        {
          label: "Side tasks",
          description: "Xem + toggle daily/weekly task tự đăng ký",
          value: "task",
          emoji: "📝",
          default: getCurrentView() === "task",
        },
      ];
      return new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId("status-view:toggle")
          .setPlaceholder("Chọn view...")
          .setDisabled(disabled)
          .addOptions(options)
      );
    };

    // List the chars in the current account that have at least one
    // side task, in display order. Driver for both the char-filter
    // dropdown and the resolveTaskCharFilter() default-picker.
    const charsWithTasksOnPage = () => {
      const account = getAccounts()[getCurrentPage()];
      const characters = Array.isArray(account?.characters)
        ? account.characters
        : [];
      return characters.filter(
        (c) => Array.isArray(c?.sideTasks) && c.sideTasks.length > 0
      );
    };

    // Sentinel value for the char-filter "All characters" mode - sits at
    // the top of the dropdown so the user can flip the same task across
    // every char in one click (use case: just finished Paradise on 6
    // alts, don't want to toggle 6 times). Pick anything that can't be
    // a Discord-allowed char name to keep the namespace collision-free.
    const ALL_CHARS_SENTINEL = "__ALL_CHARS__";

    // Resolve the effective char filter for the current page. Explicit
    // user pick wins; otherwise auto-pick the first char with tasks so
    // the toggle dropdown always has actionable items when at least one
    // task exists. Returns null when the page has zero tasks. Returns
    // ALL_CHARS_SENTINEL when the user explicitly picked the bulk mode.
    const resolveTaskCharFilter = () => {
      const explicit = getTaskCharFilter(getCurrentPage());
      const candidates = charsWithTasksOnPage();
      if (candidates.length === 0) return null;
      if (explicit === ALL_CHARS_SENTINEL) return ALL_CHARS_SENTINEL;
      if (explicit) {
        const stillExists = candidates.find(
          (c) =>
            getCharacterName(c).trim().toLowerCase() ===
            explicit.trim().toLowerCase()
        );
        if (stillExists) return getCharacterName(stillExists);
      }
      return getCharacterName(candidates[0]);
    };

    // Aggregate every (name, reset) task across the current page's
    // chars-with-tasks. Each entry rolls up:
    //   - chars that own this task ID-set
    //   - count completed across those chars
    // Used by the all-mode toggle dropdown to render `(X/N done)` and
    // to flip the bulk state in a single Mongo write.
    const aggregateTasksOnPage = () => {
      const candidates = charsWithTasksOnPage();
      const byKey = new Map();
      for (const character of candidates) {
        const charName = getCharacterName(character);
        const sideTasks = Array.isArray(character.sideTasks)
          ? character.sideTasks
          : [];
        for (const task of sideTasks) {
          if (!task?.name) continue;
          const key = `${task.name.trim().toLowerCase()}::${task.reset}`;
          let entry = byKey.get(key);
          if (!entry) {
            entry = {
              name: task.name,
              reset: task.reset,
              owners: [],
              doneCount: 0,
            };
            byKey.set(key, entry);
          }
          entry.owners.push({
            charName,
            taskId: task.taskId,
            completed: !!task.completed,
          });
          if (task.completed) entry.doneCount += 1;
        }
      }
      return [...byKey.values()].sort((a, b) =>
        a.name.localeCompare(b.name) || a.reset.localeCompare(b.reset)
      );
    };

    // Char-filter dropdown: lists every char on the current page that
    // has at least one side task. User pick scopes the toggle dropdown
    // to that char only - because per-char cap is 8, the toggle
    // dropdown after filter is guaranteed to fit Discord's 25-option
    // StringSelect cap. Hidden when the page has no tasks (toggle row
    // would be a disabled placeholder anyway).
    const buildTaskCharFilterRow = (disabled) => {
      const candidates = charsWithTasksOnPage();
      if (candidates.length === 0) return null;
      const activeName = resolveTaskCharFilter();
      const options = [];
      // Bulk-mode entry first when the page has > 1 char with tasks -
      // single-char accounts don't need the bulk option (it would just
      // duplicate the per-char view). 24 char options + 1 bulk = 25 cap.
      if (candidates.length > 1) {
        const totalTaskCount = candidates.reduce(
          (sum, c) =>
            sum + (Array.isArray(c.sideTasks) ? c.sideTasks.length : 0),
          0
        );
        const totalDone = candidates.reduce(
          (sum, c) =>
            sum +
            (Array.isArray(c.sideTasks)
              ? c.sideTasks.filter((t) => t?.completed).length
              : 0),
          0
        );
        options.push({
          label: truncateText(
            `🌐 Tất cả character · ${totalDone}/${totalTaskCount}`,
            100
          ),
          value: ALL_CHARS_SENTINEL,
          description: "Bulk toggle 1 task cho mọi char cùng có nó",
          default: activeName === ALL_CHARS_SENTINEL,
        });
      }
      const charSlots = candidates.length > 1 ? 24 : 25;
      candidates.slice(0, charSlots).forEach((character) => {
        const name = getCharacterName(character);
        const itemLevel = Number(character.itemLevel) || 0;
        const taskCount = Array.isArray(character.sideTasks)
          ? character.sideTasks.length
          : 0;
        const doneCount = Array.isArray(character.sideTasks)
          ? character.sideTasks.filter((t) => t?.completed).length
          : 0;
        const label = truncateText(
          `${name} · ${itemLevel} · ${doneCount}/${taskCount}`,
          100
        );
        const classEmojiObj = parseCustomEmoji(getClassEmoji(character.class));
        const option = {
          label,
          value: name.slice(0, 100),
          default:
            !!activeName &&
            name.trim().toLowerCase() === activeName.trim().toLowerCase(),
        };
        // StringSelectMenu options accept custom emoji ONLY via the
        // structured `emoji` field, never inline in `label` text -
        // embedding `<:name:id>` in the label renders as raw markup
        // (Discord regression Trainee caught on the live deploy).
        if (classEmojiObj) option.emoji = classEmojiObj;
        options.push(option);
      });
      return new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId("status-task:char-filter")
          .setPlaceholder("Chọn character để toggle task...")
          .setDisabled(disabled)
          .addOptions(options)
      );
    };

    // Toggle dropdown for Task view. After the Codex-round-28 fix this
    // is scoped to ONE character at a time (selected via the char-filter
    // dropdown above). With per-char cap 8 the result always fits the
    // 25-option Discord StringSelect cap. Value shape:
    // `<charName>::<taskId>` so the collector can resolve back to the
    // character + task pair without a second lookup. Char names never
    // contain `::` so the separator is collision-safe.
    const buildTaskToggleRow = (disabled) => {
      const activeName = resolveTaskCharFilter();
      if (!activeName) {
        return new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId("status-task:toggle")
            .setPlaceholder("Chưa có task nào - dùng /raid-task add để thêm")
            .setDisabled(true)
            .addOptions([{ label: "(empty)", value: "noop" }])
        );
      }
      // Bulk mode: dropdown lists every (name, reset) task aggregated
      // across all chars on the page. Picking one toggles the same task
      // ID on every owner-char in a single Mongo write. State icon
      // reflects aggregate completion: 🟢 when every owner-char has it
      // done, ⚪ otherwise. Clicking when 🟢 marks all as undone, when
      // ⚪ marks all as done (favors completion since "I just finished"
      // is the typical trigger).
      if (activeName === ALL_CHARS_SENTINEL) {
        const aggregates = aggregateTasksOnPage();
        if (aggregates.length === 0) {
          return new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
              .setCustomId("status-task:toggle")
              .setPlaceholder("Account chưa có task nào")
              .setDisabled(true)
              .addOptions([{ label: "(empty)", value: "noop" }])
          );
        }
        const options = aggregates.slice(0, 25).map((agg) => {
          const allDone = agg.doneCount === agg.owners.length;
          const icon = allDone ? UI.icons.done : UI.icons.pending;
          const label = truncateText(
            `${icon} ${agg.name} · ${agg.reset} (${agg.doneCount}/${agg.owners.length})`,
            100
          );
          // Value shape `__all__::<reset>::<lowercaseName>` so the
          // toggle handler can re-resolve owners safely. lowercaseName
          // because aggregateTasksOnPage keys on normalized name.
          return {
            label,
            value: `__all__::${agg.reset}::${agg.name.trim().toLowerCase()}`.slice(0, 100),
          };
        });
        return new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId("status-task:toggle")
            .setPlaceholder("Bulk toggle task cho mọi char...")
            .setDisabled(disabled)
            .addOptions(options)
        );
      }
      const account = getAccounts()[getCurrentPage()];
      const character = (account?.characters || []).find(
        (c) =>
          getCharacterName(c).trim().toLowerCase() ===
          activeName.trim().toLowerCase()
      );
      const sideTasks =
        character && Array.isArray(character.sideTasks)
          ? character.sideTasks
          : [];
      if (sideTasks.length === 0) {
        return new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId("status-task:toggle")
            .setPlaceholder(`${activeName} chưa có task - dùng /raid-task add`)
            .setDisabled(true)
            .addOptions([{ label: "(empty)", value: "noop" }])
        );
      }
      const options = sideTasks.slice(0, 25).map((task) => {
        // Match raid-view icon set (UI.icons.done/pending) + drop the
        // calendar emoji which Discord rendered as a bare "17" tile in
        // some clients. Cycle (daily/weekly) shown as text suffix so
        // the dropdown stays readable when both cycles coexist.
        const icon = task.completed ? UI.icons.done : UI.icons.pending;
        const label = truncateText(
          `${icon} ${task.name} · ${task.reset}`,
          100
        );
        return {
          label,
          value: `${activeName}::${task.taskId}`.slice(0, 100),
        };
      });
      return new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId("status-task:toggle")
          .setPlaceholder(`Toggle task của ${activeName}...`)
          .setDisabled(disabled)
          .addOptions(options)
      );
    };

  return {
    ALL_CHARS_SENTINEL,
    buildTaskViewEmbed,
    buildViewToggleRow,
    charsWithTasksOnPage,
    resolveTaskCharFilter,
    aggregateTasksOnPage,
    buildTaskCharFilterRow,
    buildTaskToggleRow,
  };
}

module.exports = { createRaidStatusTaskUi };
