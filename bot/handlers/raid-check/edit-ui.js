/**
 * edit-ui.js
 *
 * The full Edit cascading-select flow for /raid-check: embed + component
 * builders, the click handler that wires up the message collector, the
 * apply-and-confirm path, the DM the target member receives after a
 * Raid Manager mutates their progress, and the public-channel session
 * expired notice for when the ephemeral followup token has lapsed.
 *
 * Pulled out of commands/raid-check.js (Phase 3d) so the orchestrator
 * stays focused on routing. The factory accepts a wide dep surface
 * (~23 deps) because the Edit handler crosses many seams: discord.js
 * builders, Mongoose User model, limiters, the raid-set apply service,
 * and several pure helpers from edit-helpers.js + snapshot.js.
 *
 * The 6 returned functions cross-call each other (handleRaidCheckEditClick
 * calls applyEditAndConfirm + postEditSessionExpiredNotice + the embed
 * builders) so they all live in the same factory closure.
 */

const { buildNoticeEmbed } = require("../../utils/raid/shared");
const { t, getUserLanguage } = require("../../services/i18n");
const { getRaidModeLabel } = require("../../utils/raid/labels");

function createEditUi({
  EmbedBuilder,
  StringSelectMenuBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  UI,
  User,
  truncateText,
  RAID_REQUIREMENT_MAP,
  resolveDiscordDisplay,
  resolveCachedDisplayName,
  discordUserLimiter,
  applyRaidSetForDiscordId,
  computeRaidCheckSnapshot,
  buildEditableCharsByUser,
  getCharRaidGateStatus,
  formatGateStateLine,
  formatCharEditLabel,
  formatUserEditLabel,
  applyLocalRaidEditToChar,
  RAID_CHECK_EDIT_SESSION_MS,
}) {

  function buildEditEmbed(state) {
    const lang = state.lang || "vi";
    // Resolve the picked raid label once for use across nextStep, header
    // and the raid line. Falls back to "_not picked_" sentinel.
    const resolveRaidLabel = () => {
      if (!state.selectedRaid) return null;
      const meta = RAID_REQUIREMENT_MAP[state.selectedRaid];
      if (meta?.raidKey && meta?.modeKey) {
        return getRaidModeLabel(meta.raidKey, meta.modeKey, lang);
      }
      return meta?.label || state.raidMeta?.label || state.selectedRaid;
    };
    const pickedRaidLabel = resolveRaidLabel();

    // Pick the next step hint so the leader always knows which dropdown
    // to look at. The dropdown itself also updates live but a dense UI
    // with 3 selects stacked needs a verbal anchor in the embed too.
    let nextStep = null;
    if (state.applied) {
      nextStep = t("raid-check.editFlow.nextStepCompleted", lang);
    } else if (state.scopeAll && !state.raidMeta) {
      nextStep = t("raid-check.editFlow.nextStepPickRaid", lang);
    } else if (state.scopeAll && state.editableByUser.size === 0) {
      nextStep = t("raid-check.editFlow.nextStepNoEditable", lang);
    } else if (!state.selectedUser) {
      nextStep = t("raid-check.editFlow.nextStepPickUser", lang);
    } else if (!state.selectedChar) {
      const raidLabelForChar = state.raidMeta
        ? getRaidModeLabel(state.raidMeta.raidKey, state.raidMeta.modeKey, lang)
        : pickedRaidLabel || "";
      nextStep = t("raid-check.editFlow.nextStepPickChar", lang, {
        raidLabel: raidLabelForChar,
      });
    } else if (state.awaitingGate) {
      nextStep = t("raid-check.editFlow.nextStepPickGate", lang);
    } else {
      nextStep = t("raid-check.editFlow.nextStepPickStatus", lang);
    }

    // User label priorities (in order):
    //   1. Explicit selection (state.selectedUser) - post-pick state
    //   2. scopeAll pre-select carried from the all-mode source page -
    //      pending raid pick but we show it so leader sees context
    //   3. Nothing picked yet
    let userLabel;
    if (state.selectedUser) {
      userLabel = state.displayMap.get(state.selectedUser) || state.selectedUser;
    } else if (
      state.scopeAll &&
      state.preSelectedUserId &&
      state.preSelectedDisplayName
    ) {
      userLabel = t("raid-check.editFlow.preSelectHint", lang, {
        name: state.preSelectedDisplayName,
      });
    } else {
      userLabel = t("raid-check.editFlow.noneSelected", lang);
    }
    const charLabel = state.selectedChar
      ? `${state.selectedChar.charName} · ${Math.round(state.selectedChar.itemLevel)}${state.selectedChar.publicLogDisabled ? " · 🔒 log off" : ""}`
      : t("raid-check.editFlow.noneSelected", lang);
    const raidLabel = pickedRaidLabel || t("raid-check.editFlow.noneSelected", lang);

    // Header copy changes per mode. All-mode leader can flip raids
    // mid-session (cascade resets when they do), while specific-raid
    // mode locks to whatever /raid-check was opened against.
    const headerLine = state.scopeAll
      ? (state.raidMeta
          ? t("raid-check.editFlow.headerScopeAllPicked", lang, { raidLabel })
          : t("raid-check.editFlow.headerScopeAllUnpicked", lang))
      : t("raid-check.editFlow.headerScopeLocked", lang, { raidLabel });

    const raidLineSuffix = state.scopeAll
      ? (state.raidMeta ? t("raid-check.editFlow.raidSuffixScopeAllPicked", lang) : "")
      : t("raid-check.editFlow.raidSuffixScopeLocked", lang);

    const description = [
      headerLine,
      "",
      t("raid-check.editFlow.userLine", lang, { value: userLabel }),
      t("raid-check.editFlow.charLine", lang, { value: charLabel }),
      t("raid-check.editFlow.raidLine", lang, { value: raidLabel, suffix: raidLineSuffix }),
    ];

    // Show live gate state once a raid is picked so the leader can see
    // what's already done before picking a status button. 🟢 = done at
    // the picked mode, 🟠 = done at a DIFFERENT mode (Complete/Process
    // at the new mode will wipe it), ⚪ = pending.
    if (state.selectedChar && state.selectedRaid) {
      const raidMeta = RAID_REQUIREMENT_MAP[state.selectedRaid];
      const gateStatus = getCharRaidGateStatus(
        state.selectedChar,
        raidMeta?.raidKey,
        raidMeta?.modeKey
      );
      const gateLine = formatGateStateLine(gateStatus, raidMeta?.raidKey, lang);
      if (gateLine) {
        description.push(t("raid-check.editFlow.currentLine", lang, { value: gateLine }));
      }
      if (gateStatus.modeChangeNeeded) {
        description.push(
          t("raid-check.editFlow.modeChangeWarn", lang, { warnIcon: UI.icons.warn })
        );
      }
      if (gateStatus.overallStatus === "complete") {
        description.push(
          t("raid-check.editFlow.alreadyDoneInfo", lang, { infoIcon: UI.icons.info })
        );
      }
    }

    description.push("");
    description.push(`👉 ${nextStep}`);

    if (state.selectedChar?.autoManageEnabled && state.selectedChar?.publicLogDisabled) {
      description.push("");
      description.push(
        t("raid-check.editFlow.autoSyncLogOffNote", lang, { warnIcon: UI.icons.warn })
      );
    }

    const embed = new EmbedBuilder()
      .setTitle(t("raid-check.editFlow.title", lang))
      .setColor(state.applied ? UI.colors.success : UI.colors.neutral)
      .setDescription(description.join("\n"));

    if (state.applied && state.message) {
      embed.addFields({ name: t("raid-check.editFlow.resultFieldName", lang), value: state.message });
    }
    if (!state.applied && state.warning) {
      embed.addFields({ name: t("raid-check.editFlow.noteFieldName", lang), value: state.warning });
    }

    embed.setFooter({
      text: t("raid-check.editFlow.footerActive", lang, {
        minutes: RAID_CHECK_EDIT_SESSION_MS / 60_000,
      }),
    });
    return embed;
  }

  function buildEditComponents(state) {
    const lang = state.lang || "vi";
    const rows = [];
    const disabled = state.applied || state.locked;

    // Row 1 (scopeAll only): Raid dropdown sits on top because in
    // all-mode the snapshot itself has to be re-loaded per picked raid
    // (editableByUser changes per raid×mode). Per Traine's ordering
    // note: "nếu thêm all raid thì raid dropdown nằm trên char" - the
    // same logic applies to user select: picking a raid filters which
    // users have any editable char. Specific-raid mode does NOT render
    // this row because the raid is locked upstream.
    if (state.scopeAll) {
      const raidOptions = Object.entries(RAID_REQUIREMENT_MAP)
        .sort(([, a], [, b]) => a.minItemLevel - b.minItemLevel)
        .slice(0, 25)
        .map(([raidKey, entry]) => ({
          label: truncateText(
            t("raid-check.editFlow.raidOptionLabel", lang, {
              label: getRaidModeLabel(entry.raidKey, entry.modeKey, lang),
              minItemLevel: entry.minItemLevel,
            }),
            100
          ),
          value: raidKey,
          default: state.selectedRaid === raidKey,
        }));
      rows.push(
        new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId("raid-check-edit:raid")
            .setPlaceholder(t("raid-check.editFlow.raidPickerPlaceholder", lang))
            .setDisabled(disabled)
            .addOptions(raidOptions)
        )
      );
    }

    // In scopeAll, bail out if no raid picked yet - the user / char
    // rows below reach into state.editableByUser, which is only
    // populated AFTER a raid pick loads its snapshot.
    if (state.scopeAll && !state.raidMeta) return rows;

    // Row 2 (or Row 1 when not scopeAll): user select. Always present
    // when we have a snapshot so leader can re-pick.
    const userOptions = [...state.editableByUser.values()]
      .slice(0, 25)
      .map((group) => ({
        label: formatUserEditLabel(group, state.displayMap.get(group.discordId) || group.discordId, lang),
        value: group.discordId,
        emoji: group.autoManageEnabled ? "🤖" : "👤",
        default: state.selectedUser === group.discordId,
      }));
    if (userOptions.length > 0) {
      rows.push(
        new ActionRowBuilder().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId("raid-check-edit:user")
            .setPlaceholder(t("raid-check.editFlow.userPickerPlaceholder", lang))
            .setDisabled(disabled)
            .addOptions(userOptions)
        )
      );
    }

    // Char select (only when user picked).
    if (state.selectedUser) {
      const group = state.editableByUser.get(state.selectedUser);
      const charOptions = (group?.chars || [])
        .slice(0, 25)
        .map((char) => ({
          label: formatCharEditLabel(char, state.raidMeta, lang),
          value: `${char.accountName}||${char.charName}`,
          emoji: char.publicLogDisabled ? "🔒" : "⚔️",
          default:
            state.selectedChar?.charName === char.charName &&
            state.selectedChar?.accountName === char.accountName,
        }));
      if (charOptions.length > 0) {
        rows.push(
          new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
              .setCustomId("raid-check-edit:char")
              .setPlaceholder(t("raid-check.editFlow.charPickerPlaceholder", lang))
              .setDisabled(disabled)
              .addOptions(charOptions)
          )
        );
      }
    }

    // In specific-raid mode, state.raidMeta is locked at init to whatever
    // /raid-check was opened against. In scopeAll mode, picking the raid
    // dropdown above triggers a snapshot reload that sets raidMeta and
    // rebuilds editableByUser, so the user/char rows below stay valid
    // for the picked raid. Either way, applyEditAndConfirm reads
    // state.selectedRaid (the combined map key) for RAID_REQUIREMENT_MAP.

    // Status buttons (only when char picked). Disable Complete
    // when the raid is already done at the picked mode (would be a
    // no-op server-side) and disable Process when there are no open
    // gates left to mark. Reset is always enabled - it's useful even
    // on a complete raid (e.g. undoing an accidental mark).
    if (state.selectedChar) {
      const raidMeta = RAID_REQUIREMENT_MAP[state.selectedRaid];
      const gateStatus = getCharRaidGateStatus(
        state.selectedChar,
        raidMeta?.raidKey,
        raidMeta?.modeKey
      );
      const allGatesDoneAtPickedMode = gateStatus?.overallStatus === "complete";
      const hasOpenGateAtPickedMode = gateStatus
        ? gateStatus.gates.some((g) => !g.doneAtPickedMode)
        : true;

      rows.push(
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId("raid-check-edit:status:complete")
            .setLabel(t("raid-check.editFlow.buttonComplete", lang))
            .setEmoji("✅")
            .setStyle(ButtonStyle.Success)
            .setDisabled(disabled || allGatesDoneAtPickedMode),
          new ButtonBuilder()
            .setCustomId("raid-check-edit:status:process")
            .setLabel(t("raid-check.editFlow.buttonProcess", lang))
            .setEmoji("📝")
            .setStyle(ButtonStyle.Primary)
            .setDisabled(disabled || !hasOpenGateAtPickedMode),
          new ButtonBuilder()
            .setCustomId("raid-check-edit:status:reset")
            .setLabel(t("raid-check.editFlow.buttonReset", lang))
            .setEmoji("🔄")
            .setStyle(ButtonStyle.Danger)
            .setDisabled(disabled),
          new ButtonBuilder()
            .setCustomId("raid-check-edit:cancel")
            .setLabel(
              state.applied
                ? t("raid-check.editFlow.buttonClose", lang)
                : t("raid-check.editFlow.buttonCancel", lang)
            )
            .setEmoji("✖️")
            .setStyle(ButtonStyle.Secondary)
        )
      );
    }

    // Gate buttons (only when Process mode entered). Gate buttons
    // reflect current state: 🟢 emoji + disabled for gates already done
    // at the picked mode (re-marking would be a no-op), 🟠 for gates
    // done at a different mode (clicking triggers the mode-wipe path),
    // ⚪ for clean pending.
    if (state.selectedChar && state.awaitingGate) {
      const raidMeta = RAID_REQUIREMENT_MAP[state.selectedRaid];
      const gateStatus = getCharRaidGateStatus(
        state.selectedChar,
        raidMeta?.raidKey,
        raidMeta?.modeKey
      );
      const gateRow = new ActionRowBuilder();
      for (const g of gateStatus.gates.slice(0, 5)) {
        const btn = new ButtonBuilder()
          .setCustomId(`raid-check-edit:gate:${g.gate}`)
          .setLabel(g.gate)
          .setDisabled(disabled || g.doneAtPickedMode);
        if (g.doneAtPickedMode) {
          btn.setEmoji("🟢").setStyle(ButtonStyle.Secondary);
        } else if (g.doneAtSomeMode) {
          btn.setEmoji("🟠").setStyle(ButtonStyle.Primary);
        } else {
          btn.setEmoji("⚪").setStyle(ButtonStyle.Primary);
        }
        gateRow.addComponents(btn);
      }
      if (gateRow.components.length > 0) rows.push(gateRow);
    }

    return rows;
  }

  async function handleRaidCheckEditClick(interaction, raidMeta, raidKey, preSelectedUserId = null) {
    const started = Date.now();
    // Manager (Edit-button clicker) is the sole viewer of the ephemeral
    // followup + every cascading select. Resolve once, thread through
    // state so every render path uses the same lang.
    const lang = await getUserLanguage(interaction.user.id, { UserModel: User });
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    // Two entry modes:
    //   - specific-raid: raidMeta + raidKey passed in, we preload the
    //     snapshot + editableByUser + displayMap for exactly that raid.
    //   - scopeAll (raidMeta null): no preload; leader picks raid via
    //     a dropdown inside the Edit UI, and the `raid` action handler
    //     below loads the per-raid snapshot on the fly.
    //
    // preSelectedUserId: scopeAll-only hint carrying the discordId of
    // the user shown on the source all-mode page. Applied after the
    // leader picks a raid, IF that user has at least one editable char
    // for the picked raid. If not (floor too high / fully auto-sync
    // with log-on), the pre-select silently drops and user dropdown
    // works as normal.
    const scopeAll = !raidMeta;

    let editableByUser = new Map();
    let displayMap = new Map();
    let snapshot = null;

    // Resolve pre-select display name upfront so the User line shows
    // context from the very first render, not just after the leader
    // picks a raid. Without this, leader clicks Edit from Du's page,
    // sees "User: chưa chọn" until they also pick a raid - which
    // reads as "context was lost" even though the discordId is
    // stashed in state.
    let preSelectedDisplayName = null;
    if (scopeAll && preSelectedUserId) {
      try {
        const preDoc = await User.findOne({ discordId: preSelectedUserId })
          .select("discordUsername discordGlobalName discordDisplayName")
          .lean();
        const cached =
          preDoc?.discordDisplayName ||
          preDoc?.discordGlobalName ||
          preDoc?.discordUsername ||
          "";
        if (cached) {
          preSelectedDisplayName = cached;
        } else {
          preSelectedDisplayName = await resolveDiscordDisplay(
            interaction.client,
            preSelectedUserId
          );
        }
      } catch (err) {
        console.warn(
          `[raid-check edit scopeAll] pre-select display resolve failed for ${preSelectedUserId}:`,
          err?.message || err
        );
        preSelectedDisplayName = preSelectedUserId;
      }
    }

    if (!scopeAll) {
      snapshot = await computeRaidCheckSnapshot(raidMeta, {
        syncFreshData: true,
      });
      editableByUser = buildEditableCharsByUser(snapshot);

      if (editableByUser.size === 0) {
        await interaction.editReply({
          content: null,
          embeds: [
            buildNoticeEmbed(EmbedBuilder, {
              type: "info",
              title: t("raid-check.editFlow.noEditableTitle", lang),
              description: t("raid-check.editFlow.noEditableDescription", lang, {
                minItemLevel: raidMeta.minItemLevel,
              }),
            }),
          ],
        });
        return;
      }

      // Resolve display names for just the editable users, via the shared
      // cache-first helper. See resolveCachedDisplayName for why we prefer the
      // User doc's cached identity over discord.js's own users cache.
      await Promise.all(
        [...editableByUser.keys()].map(async (discordId) => {
          const meta = snapshot.userMeta.get(discordId) || {};
          const name = await resolveCachedDisplayName(
            interaction.client,
            discordId,
            meta
          );
          displayMap.set(discordId, name);
        })
      );
    }

    const state = {
      scopeAll,
      lang,
      raidMeta: raidMeta || null,
      editableByUser,
      displayMap,
      // Stored for the `raid` action handler to consume once the
      // per-raid snapshot is loaded. Only meaningful in scopeAll.
      preSelectedUserId: scopeAll ? preSelectedUserId : null,
      preSelectedDisplayName,
      selectedUser: null,
      selectedChar: null,
      // Specific-raid: locked at init to the combined map key
      // ("serca_hard"), preserved through every user/char re-pick.
      // ScopeAll: starts null; set when the raid dropdown fires a `raid`
      // action and reloads the snapshot for the picked raid.
      //
      // IMPORTANT: this is the combined map key, NOT raidMeta.raidKey
      // (just "serca"). RAID_REQUIREMENT_MAP is keyed by the combined
      // form; misusing the object field would make every downstream
      // RAID_REQUIREMENT_MAP lookup (embed render, status-button guard,
      // applyEditAndConfirm) return undefined and silently no-op the
      // apply. This regression happened in 639ac03 / fixed in f8cd84a.
      selectedRaid: raidKey || null,
      awaitingGate: false,
      applied: false,
      locked: false,
      message: null,
      warning: null,
    };

    await interaction.editReply({
      embeds: [buildEditEmbed(state)],
      components: buildEditComponents(state),
    });
    const followup = await interaction.fetchReply();
    // scopeAll opens with raidMeta=null (the raid is picked inside the
    // UI), so log a sentinel instead of dereferencing raidMeta.raidKey.
    // Before this guard a TypeError fired between editReply and the
    // collector setup below, which meant the raid dropdown rendered
    // but had no handler to process clicks - a silent dead UI.
    // Caught by Codex review of commit e15b275.
    const openedRaidLabel = scopeAll
      ? "all"
      : `${raidMeta.raidKey}:${raidMeta.modeKey}`;
    console.log(
      `[raid-check edit] opened raid=${openedRaidLabel} users=${editableByUser.size} openMs=${Date.now() - started}`
    );

    const collector = followup.createMessageComponentCollector({
      time: RAID_CHECK_EDIT_SESSION_MS,
    });

    collector.on("collect", async (component) => {
      if (component.user.id !== interaction.user.id) {
        // Lock message read by unauthorized clicker - render in their lang.
        const clickerLang = await getUserLanguage(component.user.id, { UserModel: User });
        await component.reply({
          embeds: [
            buildNoticeEmbed(EmbedBuilder, {
              type: "lock",
              title: t("raid-check.editFlow.lockOtherTitle", clickerLang),
              description: t("raid-check.editFlow.lockOtherDescription", clickerLang),
            }),
          ],
          flags: MessageFlags.Ephemeral,
        }).catch(() => {});
        return;
      }
      const parts = (component.customId || "").split(":");
      // parts[0] = "raid-check-edit", parts[1] = action, parts[2] = value (if any)
      const action = parts[1];

      if (action === "raid") {
        // Scope-all raid picker. Load the snapshot + editableByUser +
        // displayMap for the picked raid so the user/char cascade below
        // can render against real data. Ack immediately with deferUpdate
        // so Discord doesn't time out the 3-second interaction window
        // while computeRaidCheckSnapshot hits the DB.
        const pickedRaidKey = component.values[0];
        const pickedRaidMeta = RAID_REQUIREMENT_MAP[pickedRaidKey];
        if (!pickedRaidMeta) {
          state.warning = t("raid-check.editFlow.raidInvalidWarning", lang, {
            warnIcon: UI.icons.warn,
          });
          await component.update({
            embeds: [buildEditEmbed(state)],
            components: buildEditComponents(state),
          }).catch(() => {});
          return;
        }
        await component.deferUpdate().catch(() => {});
        try {
          const newSnapshot = await computeRaidCheckSnapshot(pickedRaidMeta, {
            syncFreshData: true,
          });
          const newEditableByUser = buildEditableCharsByUser(newSnapshot);
          const newDisplayMap = new Map();
          await Promise.all(
            [...newEditableByUser.keys()].map(async (discordId) => {
              const meta = newSnapshot.userMeta.get(discordId) || {};
              const name = await resolveCachedDisplayName(
                interaction.client,
                discordId,
                meta
              );
              newDisplayMap.set(discordId, name);
            })
          );

          state.raidMeta = pickedRaidMeta;
          state.selectedRaid = pickedRaidKey;
          state.editableByUser = newEditableByUser;
          state.displayMap = newDisplayMap;
          // Changing raid invalidates any previously picked user/char -
          // a user who was editable for Serca Hard might have no char
          // eligible for Act 4 Normal at all.
          state.selectedUser = null;
          state.selectedChar = null;
          state.awaitingGate = false;
          state.warning = null;

          // Pre-select the user the leader was viewing on the source
          // all-mode page, IF they're still editable for the picked
          // raid. Consumed-once: clear the hint after applying so
          // subsequent raid re-picks use the leader's own explicit
          // user choice (or lack thereof) without re-pre-selecting.
          if (state.preSelectedUserId) {
            if (newEditableByUser.has(state.preSelectedUserId)) {
              state.selectedUser = state.preSelectedUserId;
            } else {
              // Pre-select dropped silently because the focused user
              // has no editable char for this raid (floor too high,
              // or all chars auto-sync + log on). Surface a warning
              // so the leader understands why User went from pre-
              // selected back to none.
              const preName = state.preSelectedDisplayName || state.preSelectedUserId;
              state.warning = t("raid-check.editFlow.preSelectDropped", lang, {
                infoIcon: UI.icons.info,
                name: preName,
                raidLabel: getRaidModeLabel(pickedRaidMeta.raidKey, pickedRaidMeta.modeKey, lang),
              });
            }
          }
          state.preSelectedUserId = null;
          state.preSelectedDisplayName = null;
        } catch (err) {
          state.warning = t("raid-check.editFlow.snapshotLoadFailWarning", lang, {
            warnIcon: UI.icons.warn,
            error: err?.message || String(err),
          });
          console.warn(`[raid-check edit scopeAll] raid-pick load failed:`, err?.message || err);
        }
        await interaction.editReply({
          embeds: [buildEditEmbed(state)],
          components: buildEditComponents(state),
        }).catch(() => {});
        return;
      }

      if (action === "user") {
        state.selectedUser = component.values[0];
        state.selectedChar = null;
        // selectedRaid stays locked to raidMeta.raidKey (the raid the
        // leader opened /raid-check against) through every re-pick.
        state.awaitingGate = false;
        state.warning = null;
        await component.update({
          embeds: [buildEditEmbed(state)],
          components: buildEditComponents(state),
        }).catch(() => {});
        return;
      }
      if (action === "char") {
        const group = state.editableByUser.get(state.selectedUser);
        const [accountName, charName] = (component.values[0] || "").split("||");
        const picked = (group?.chars || []).find(
          (c) => c.accountName === accountName && c.charName === charName
        );
        state.selectedChar = picked || null;
        state.awaitingGate = false;
        state.warning = null;
        await component.update({
          embeds: [buildEditEmbed(state)],
          components: buildEditComponents(state),
        }).catch(() => {});
        return;
      }
      if (action === "status") {
        const statusType = parts[2];
        if (statusType === "process") {
          state.awaitingGate = true;
          state.warning = t("raid-check.editFlow.pickGateWarning", lang);
          await component.update({
            embeds: [buildEditEmbed(state)],
            components: buildEditComponents(state),
          }).catch(() => {});
          return;
        }
        // Complete / Reset: apply immediately.
        await applyEditAndConfirm(component, state, statusType, null);
        return;
      }
      if (action === "gate") {
        const gate = parts[2];
        await applyEditAndConfirm(component, state, "process", gate);
        return;
      }
      if (action === "cancel") {
        state.locked = true;
        await component.update({
          embeds: [
            EmbedBuilder.from(buildEditEmbed(state)).setFooter({
              text: t("raid-check.editFlow.footerClosed", lang),
            }),
          ],
          components: buildEditComponents(state).map((row) => {
            for (const c of row.components) {
              if (typeof c.setDisabled === "function") c.setDisabled(true);
            }
            return row;
          }),
        }).catch(() => {});
        collector.stop("cancelled");
        return;
      }
    });

    collector.on("end", async (_collected, reason) => {
      if (reason === "cancelled" || state.applied) return;
      let refreshed = false;
      try {
        await interaction.editReply({
          embeds: [
            EmbedBuilder.from(buildEditEmbed(state)).setFooter({
              text: t("raid-check.editFlow.footerExpired", lang),
            }),
          ],
          components: buildEditComponents(state).map((row) => {
            for (const c of row.components) {
              if (typeof c.setDisabled === "function") c.setDisabled(true);
            }
            return row;
          }),
        });
        refreshed = true;
      } catch (err) {
        // Ephemeral followup interaction token has already expired (> 15 min
        // idle after deferReply). We can't edit that message any more, so
        // fall through to the public tag so the leader at least understands
        // why their last click did nothing.
        console.warn(`[raid-check edit] session-end edit failed:`, err?.message || err);
      }
      if (!refreshed) {
        await postEditSessionExpiredNotice(
          interaction,
          t("raid-check.editFlow.sessionExpiredNotice", lang)
        );
      }
    });
  }

  /**
   * When the Edit flow's ephemeral follow-up can no longer be edited
   * (interaction token past the 15-minute window, Discord outage, etc.)
   * we lose the channel to talk back. Post a public-channel tag so the
   * leader sees a concrete "here's why that click did nothing" instead
   * of a silent UI. Best-effort + auto-delete so the channel doesn't
   * accumulate stale notices.
   */
  async function postEditSessionExpiredNotice(interaction, note) {
    const channel = interaction.channel;
    if (!channel || typeof channel.send !== "function") return;
    try {
      const sent = await channel.send({
        content: `<@${interaction.user.id}> ${note}`,
        allowedMentions: { users: [interaction.user.id] },
      });
      setTimeout(() => {
        sent.delete().catch(() => {});
      }, 30_000);
    } catch (err) {
      console.warn(
        `[raid-check edit] session-expired tag post failed:`,
        err?.message || err
      );
    }
  }

  /**
   * DM sent to the target member after a Raid Manager uses the Edit flow
   * to change their progress. Artist speaks in first-person: the specific
   * Raid Manager's identity is intentionally NOT surfaced (roles only, no
   * names) so the DM reads as a system notification from the bot, not a
   * finger-point at a particular leader. Best-effort: never blocks apply,
   * never re-tried on failure.
   */
  function buildRaidCheckEditDMEmbed({
    targetChar,
    raidMeta,
    statusType,
    gate,
    modeResetHappened,
    lang = "vi",
  }) {
    const actionLine =
      statusType === "complete"
        ? t("raid-check.editDm.actionComplete", lang)
        : statusType === "reset"
          ? t("raid-check.editDm.actionReset", lang)
          : t("raid-check.editDm.actionProcess", lang, {
              gate: gate || t("raid-check.editDm.actionProcessFallback", lang),
            });
    const color =
      statusType === "reset" ? UI.colors.progress : UI.colors.success;
    const raidLabel = getRaidModeLabel(raidMeta.raidKey, raidMeta.modeKey, lang);
    const lines = [
      t("raid-check.editDm.intro", lang),
      "",
      t("raid-check.editDm.charLine", lang, {
        charName: targetChar.charName,
        itemLevel: Math.round(targetChar.itemLevel),
      }),
      t("raid-check.editDm.raidLine", lang, { raidLabel }),
      t("raid-check.editDm.changeLine", lang, { action: actionLine }),
    ];
    if (modeResetHappened) {
      lines.push("");
      lines.push(t("raid-check.editDm.modeResetNote", lang, { warnIcon: UI.icons.warn }));
    }
    lines.push("");
    lines.push(t("raid-check.editDm.footer", lang));

    return new EmbedBuilder()
      .setColor(color)
      .setTitle(t("raid-check.editDm.title", lang, { doneIcon: UI.icons.done }))
      .setDescription(lines.join("\n"))
      .setTimestamp();
  }

  async function applyEditAndConfirm(component, state, statusType, gate) {
    const lang = state.lang || "vi";
    state.locked = true;
    // Freeze components visually while the apply is in-flight.
    await component.update({
      embeds: [buildEditEmbed(state)],
      components: buildEditComponents(state),
    }).catch(() => {});

    const raidKey = state.selectedRaid;
    const raidMeta = RAID_REQUIREMENT_MAP[raidKey];
    const targetChar = state.selectedChar;
    const effectiveGates = statusType === "process" && gate ? [gate] : [];

    let result;
    try {
      result = await applyRaidSetForDiscordId({
        discordId: state.selectedUser,
        characterName: targetChar.charName,
        rosterName: targetChar.accountName,
        raidMeta,
        statusType,
        effectiveGates,
      });
    } catch (err) {
      state.locked = false;
      state.applied = false;
      state.warning = t("raid-check.editFlow.applyFailedWarning", lang, {
        warnIcon: UI.icons.warn,
        error: err?.message || String(err),
      });
      await component.message.edit({
        embeds: [buildEditEmbed(state)],
        components: buildEditComponents(state),
      }).catch(() => {});
      console.warn(`[raid-check edit] apply failed:`, err?.message || err);
      return;
    }

    if (result?.updated) {
      applyLocalRaidEditToChar(targetChar, raidMeta, statusType, effectiveGates);
    }
    state.applied = true;

    // DM the target member when their progress actually changed on disk.
    // Skip three cases: (1) no-op apply (result.updated false; nothing for
    // the target to hear about), (2) self-edit (leader edited their own
    // char; they already see the confirmation in the ephemeral UI), and
    // (3) write did not land (noRoster / matched===0 / ineligible - the
    // summary below handles those). The DM is Artist's voice with no
    // leader identity per Traine's rule.
    const isSelfEdit = state.selectedUser === component.user.id;
    const didApplyWrite =
      result?.updated === true &&
      !result?.noRoster &&
      result?.matched !== 0 &&
      !result?.ineligibleItemLevel;
    let dmOutcome = null; // "sent" | "failed" | "skipped-self" | null (not attempted)
    if (didApplyWrite && isSelfEdit) {
      dmOutcome = "skipped-self";
    } else if (didApplyWrite) {
      try {
        // Gate the REST fetch through discordUserLimiter (same limiter the
        // Sync DM path uses) to keep /raid-check consistent with Discord's
        // global rate ceiling. Single-user apply is low volume on its own,
        // but funneling every REST call through the same limiter means
        // burst-edit sessions do not race Sync DM traffic.
        const user = await discordUserLimiter.run(() =>
          component.client.users.fetch(state.selectedUser)
        );
        const dmChannel = await user.createDM();
        // DM is delivered to the target, not the manager - render in
        // the target's lang per viewer-language rule.
        const targetLang = await getUserLanguage(state.selectedUser, { UserModel: User });
        const dmEmbed = buildRaidCheckEditDMEmbed({
          targetChar,
          raidMeta,
          statusType,
          gate,
          modeResetHappened: result?.modeResetCount > 0,
          lang: targetLang,
        });
        await dmChannel.send({ embeds: [dmEmbed] });
        dmOutcome = "sent";
      } catch (err) {
        dmOutcome = "failed";
        console.warn(
          `[raid-check edit] DM to ${state.selectedUser} failed:`,
          err?.message || err
        );
      }
    }

    const summaryParts = [];
    const statusLabel =
      statusType === "complete" ? t("raid-check.editFlow.statusLabelComplete", lang) :
      statusType === "reset" ? t("raid-check.editFlow.statusLabelReset", lang) :
      gate
        ? t("raid-check.editFlow.statusLabelProcess", lang, { gate })
        : t("raid-check.editFlow.statusLabelProcessFallback", lang);
    const raidLabelManager = getRaidModeLabel(raidMeta.raidKey, raidMeta.modeKey, lang);
    if (result?.noRoster) {
      summaryParts.push(t("raid-check.editFlow.applySummaryNoRoster", lang, { warnIcon: UI.icons.warn }));
    } else if (result?.matched === 0) {
      summaryParts.push(t("raid-check.editFlow.applySummaryCharNotFound", lang, {
        warnIcon: UI.icons.warn,
        charName: targetChar.charName,
      }));
    } else if (result?.ineligibleItemLevel) {
      summaryParts.push(t("raid-check.editFlow.applySummaryIneligible", lang, {
        warnIcon: UI.icons.warn,
        itemLevel: result.ineligibleItemLevel,
        raidLabel: raidLabelManager,
        minItemLevel: raidMeta.minItemLevel,
      }));
    } else if (result?.alreadyComplete) {
      summaryParts.push(t("raid-check.editFlow.applySummaryAlreadyComplete", lang, {
        infoIcon: UI.icons.info,
        charName: targetChar.charName,
        raidLabel: raidLabelManager,
      }));
    } else if (result?.alreadyReset) {
      summaryParts.push(t("raid-check.editFlow.applySummaryAlreadyReset", lang, {
        infoIcon: UI.icons.info,
        charName: targetChar.charName,
        raidLabel: raidLabelManager,
      }));
    } else {
      summaryParts.push(t("raid-check.editFlow.applySummaryDone", lang, {
        doneIcon: UI.icons.done,
        statusLabel,
        charName: targetChar.charName,
        raidLabel: raidLabelManager,
      }));
      if (result?.modeResetCount > 0) {
        summaryParts.push(t("raid-check.editFlow.applySummaryModeWipe", lang));
      }
    }
    if (dmOutcome === "sent") {
      summaryParts.push(t("raid-check.editFlow.applySummaryDmSent", lang));
    } else if (dmOutcome === "failed") {
      summaryParts.push(t("raid-check.editFlow.applySummaryDmFailed", lang, { warnIcon: UI.icons.warn }));
    } else if (dmOutcome === "skipped-self") {
      summaryParts.push(t("raid-check.editFlow.applySummaryDmSkippedSelf", lang));
    }
    summaryParts.push("");
    summaryParts.push(t("raid-check.editFlow.applySummaryHint", lang, { raidLabel: raidLabelManager }));
    state.message = summaryParts.join("\n");

    let uiRefreshed = false;
    try {
      await component.message.edit({
        embeds: [buildEditEmbed(state)],
        components: buildEditComponents(state),
      });
      uiRefreshed = true;
    } catch (err) {
      console.warn(
        `[raid-check edit] post-apply UI refresh failed:`,
        err?.message || err
      );
    }
    console.log(
      `[raid-check edit] applied user=${state.selectedUser} char=${targetChar.charName} raid=${raidKey} status=${statusType}${gate ? ` gate=${gate}` : ""}`
    );
    if (!uiRefreshed) {
      // Apply succeeded but we can't update the ephemeral UI. Surface a
      // public tag so the leader sees confirmation + knows to rerun.
      await postEditSessionExpiredNotice(
        component,
        t("raid-check.editFlow.applyUiRefreshFailNotice", lang, {
          statusLabel,
          charName: targetChar.charName,
          raidLabel: raidLabelManager,
        })
      );
    }
  }

  return {
    buildEditEmbed,
    buildEditComponents,
    handleRaidCheckEditClick,
    postEditSessionExpiredNotice,
    buildRaidCheckEditDMEmbed,
    applyEditAndConfirm,
  };
}

module.exports = { createEditUi };
