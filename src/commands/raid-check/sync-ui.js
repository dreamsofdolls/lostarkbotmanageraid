/**
 * sync-ui.js
 *
 * The /raid-check Sync button flow + the cache-first display-name
 * resolver used by every view inside /raid-check.
 *
 * Three exports:
 *   - resolveCachedDisplayName: shared by main render path, Edit flow,
 *     and the Sync DM path. Prefers cached User-doc identity strings
 *     over discord.js's local user cache because the doc reflects the
 *     guild-displayed nickname/global name, not the raw username
 *     handle.
 *   - buildRaidCheckSyncDMEmbed: pure embed builder for the DM the
 *     target member receives after Sync surfaces new gates from bible.
 *   - handleRaidCheckSyncClick: the Sync button handler. Walks every
 *     opted-in pending user, runs the auto-manage gather + apply via
 *     limiter, then DMs each user whose progress changed.
 *
 * Order matters at the compose root: sync-ui must be wired BEFORE
 * edit-ui because edit-ui consumes resolveCachedDisplayName as a dep
 * (Edit cascade also resolves display names per editable user).
 */

function createSyncUi({
  EmbedBuilder,
  MessageFlags,
  UI,
  User,
  ensureFreshWeek,
  normalizeName,
  saveWithRetry,
  weekResetStartMs,
  autoManageEntryKey,
  gatherAutoManageLogsForUserDoc,
  applyAutoManageCollected,
  stampAutoManageAttempt,
  acquireAutoManageSyncSlot,
  releaseAutoManageSyncSlot,
  raidCheckSyncLimiter,
  discordUserLimiter,
  resolveDiscordDisplay,
  computeRaidCheckSnapshot,
}) {

  // Shared display-name resolver for every view inside /raid-check (main
  // render + Edit cascade + Sync DM). Prefers the cached identity strings
  // on the User doc (stamped every slash-command invocation) because those
  // reflect the guild-displayed nickname / global name rather than the raw
  // username handle discord.js's local cache typically holds. Falls back
  // to `resolveDiscordDisplay` (already gated by discordUserLimiter
  // internally) for users whose doc fields are empty, and finally to the
  // snowflake.
  async function resolveCachedDisplayName(client, discordId, meta) {
    const cached =
      meta?.discordDisplayName ||
      meta?.discordGlobalName ||
      meta?.discordUsername ||
      "";
    if (cached) return cached;
    try {
      const live = await resolveDiscordDisplay(client, discordId);
      return live || discordId;
    } catch {
      return discordId;
    }
  }

  function buildRaidCheckSyncDMEmbed(raidMeta, delta) {
    const lines = delta.map((entry) => {
      const applied = Array.isArray(entry.applied) ? entry.applied : [];
      const gateInfo = applied
        .map((item) => `${item.raidLabel || item.raidKey} ${item.gate}`)
        .join(", ");
      return `**${entry.charName}** · ${applied.length} gate mới: ${gateInfo || "_(detail không có)_"}`;
    });

    return new EmbedBuilder()
      .setColor(UI.colors.success)
      .setTitle(`${UI.icons.done} Artist vừa sync progress raid giúp cậu`)
      .setDescription(
        [
          "Chào cậu~ Có Raid Manager vừa nhờ Artist pull logs từ bible sync progress raid cho cậu đây nha. Sau khi sync xong, Artist thấy mấy gate mới này cho char của cậu:",
          "",
          ...lines,
          "",
          "Cậu ghé `/raid-status` xem full progress nha~",
        ].join("\n")
      )
      .setTimestamp();
  }

  async function handleRaidCheckSyncClick(interaction, raidMeta) {
    const started = Date.now();
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const snapshotStarted = Date.now();
    const snapshot = await computeRaidCheckSnapshot(raidMeta);
    const snapshotMs = Date.now() - snapshotStarted;

    const pendingEntryKeysByDiscordId = new Map();
    for (const pendingChar of snapshot.pendingChars) {
      if (!snapshot.userMeta.get(pendingChar.discordId)?.autoManageEnabled) continue;
      if (!pendingEntryKeysByDiscordId.has(pendingChar.discordId)) {
        pendingEntryKeysByDiscordId.set(pendingChar.discordId, new Set());
      }
      pendingEntryKeysByDiscordId
        .get(pendingChar.discordId)
        .add(autoManageEntryKey(pendingChar.accountName, pendingChar.charName));
    }
    const optedInDiscordIds = [...pendingEntryKeysByDiscordId.keys()];
    const scopedCharCount = [...pendingEntryKeysByDiscordId.values()].reduce(
      (sum, entryKeys) => sum + entryKeys.size,
      0
    );
    const pendingUserCount = new Set(snapshot.pendingChars.map((c) => c.discordId)).size;
    if (optedInDiscordIds.length === 0) {
      console.log(
        `[raid-check sync] raid=${raidMeta.raidKey}:${raidMeta.modeKey} pendingUsers=${pendingUserCount} optedIn=0 snapshotMs=${snapshotMs} totalMs=${Date.now() - started}`
      );
      await interaction.editReply({
        content: `${UI.icons.info} Không có user nào opt-in \`/raid-auto-manage\` trong list pending. Nhắc họ gõ \`/raid-auto-manage action:on\` hoặc tự update bằng \`/raid-set\`.`,
      });
      return;
    }

    const weekResetStart = weekResetStartMs();
    let syncedCount = 0;
    let attemptedOnlyCount = 0;
    let skippedCount = 0;
    let failedCount = 0;
    const deltasPerUser = new Map();

    const syncStarted = Date.now();
    await Promise.all(
      optedInDiscordIds.map((discordId) =>
        raidCheckSyncLimiter.run(async () => {
          const guard = await acquireAutoManageSyncSlot(discordId, { ignoreCooldown: true });
          if (!guard.acquired) {
            skippedCount += 1;
            return;
          }

          let bibleHit = false;
          try {
            const seedDoc = await User.findOne({ discordId });
            if (!seedDoc || !Array.isArray(seedDoc.accounts) || seedDoc.accounts.length === 0) {
              skippedCount += 1;
              return;
            }
            if (!seedDoc.autoManageEnabled) {
              skippedCount += 1;
              return;
            }

            ensureFreshWeek(seedDoc);
            const collected = await gatherAutoManageLogsForUserDoc(seedDoc, weekResetStart, {
              includeEntryKeys: pendingEntryKeysByDiscordId.get(discordId),
            });
            bibleHit = true;

            let outcome = "attempted-only";
            let delta = null;
            await saveWithRetry(async () => {
              const fresh = await User.findOne({ discordId });
              if (!fresh || !Array.isArray(fresh.accounts) || fresh.accounts.length === 0) return;

              ensureFreshWeek(fresh);
              if (!fresh.autoManageEnabled) {
                fresh.lastAutoManageAttemptAt = Date.now();
                await fresh.save();
                return;
              }

              const report = applyAutoManageCollected(fresh, weekResetStart, collected);
              const now = Date.now();
              fresh.lastAutoManageAttemptAt = now;
              if (report.perChar.some((c) => !c.error)) {
                fresh.lastAutoManageSyncAt = now;
                outcome = "synced";
              }
              const appliedEntries = report.perChar.filter(
                (entry) => Array.isArray(entry.applied) && entry.applied.length > 0
              );
              if (appliedEntries.length > 0) delta = appliedEntries;
              await fresh.save();
            });

            if (outcome === "synced") syncedCount += 1;
            else attemptedOnlyCount += 1;
            if (delta) deltasPerUser.set(discordId, delta);
          } catch (err) {
            failedCount += 1;
            if (bibleHit) await stampAutoManageAttempt(discordId);
            console.warn(`[raid-check sync] user ${discordId} failed:`, err?.message || err);
          } finally {
            releaseAutoManageSyncSlot(discordId);
          }
        })
      )
    );
    const syncMs = Date.now() - syncStarted;

    const dmStarted = Date.now();
    const dmResults = await Promise.all(
      [...deltasPerUser.entries()].map(([discordId, delta]) =>
        discordUserLimiter.run(async () => {
          try {
            const user = await interaction.client.users.fetch(discordId);
            const dmChannel = await user.createDM();
            const embed = buildRaidCheckSyncDMEmbed(raidMeta, delta);
            await dmChannel.send({ embeds: [embed] });
            return { ok: true };
          } catch {
            return { ok: false };
          }
        })
      )
    );
    const dmMs = Date.now() - dmStarted;
    const dmSent = dmResults.filter((result) => result.ok).length;
    const dmFailed = dmResults.length - dmSent;

    console.log(
      `[raid-check sync] raid=${raidMeta.raidKey}:${raidMeta.modeKey} pendingUsers=${pendingUserCount} optedIn=${optedInDiscordIds.length} scopedChars=${scopedCharCount} synced=${syncedCount} attemptedOnly=${attemptedOnlyCount} skipped=${skippedCount} failed=${failedCount} dmSent=${dmSent} dmFailed=${dmFailed} snapshotMs=${snapshotMs} syncMs=${syncMs} dmMs=${dmMs} totalMs=${Date.now() - started}`
    );

    const lines = [
      `${UI.icons.done} Đã trigger sync cho **${optedInDiscordIds.length}** opted-in user (**${scopedCharCount}** pending char).`,
      `- Synced (có data mới): **${syncedCount}** · Attempted-only (no fresh data): **${attemptedOnlyCount}**`,
      `- Skipped (cooldown/in-flight): **${skippedCount}** · Failed: **${failedCount}**`,
      `- Chars có update mới: **${deltasPerUser.size}** user · DM sent: **${dmSent}**${dmFailed > 0 ? ` · DM failed: **${dmFailed}**` : ""}`,
      "",
      `_Gõ \`/raid-check raid:${raidMeta.raidKey}_${normalizeName(raidMeta.modeKey)}\` để xem list pending mới._`,
    ];
    await interaction.editReply({ content: lines.join("\n") });
  }

  return {
    resolveCachedDisplayName,
    buildRaidCheckSyncDMEmbed,
    handleRaidCheckSyncClick,
  };
}

module.exports = { createSyncUi };
