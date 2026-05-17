/**
 * handlers/raid/bg.js
 *
 * /raid-bg command · set, view, remove the per-user background image
 * for the /raid-status canvas card. Storage mirrors the LoaLogs evidence
 * rehost pattern: when the user uploads an attachment we re-send it
 * into the operator-guild background channel (env RAID_BG_CHANNEL_ID),
 * then store the rehosted message + channel ID on the user document
 * instead of Discord's signed CDN URL (which expires ~24h).
 *
 * All user-facing strings route through bot/services/i18n so Artist's
 * voice stays consistent with the rest of the bot and per-user language
 * (vi default / jp / en) is honored automatically.
 */

"use strict";

const { loadImage } = require("@napi-rs/canvas");
const { t, getUserLanguage } = require("../../services/i18n");

const RAID_BG_MIN_WIDTH = 1600;
const RAID_BG_MIN_HEIGHT = 900;
const RAID_BG_MAX_WIDTH = 3840;
const RAID_BG_MAX_HEIGHT = 2160;
const RAID_BG_MAX_BYTES = 8 * 1024 * 1024;
const RAID_BG_MAX_MB = RAID_BG_MAX_BYTES / 1024 / 1024;
const RAID_BG_ALLOWED_MIME = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
]);

function getBgChannelId() {
  return (process.env.RAID_BG_CHANNEL_ID || "").trim();
}

/**
 * Custom Error subclass that carries an i18n key + interpolation params
 * instead of a baked English message. Lets the caller translate at the
 * top of the handler so the user sees Artist's voice in their preferred
 * language regardless of where in the validation chain the throw fired.
 */
class RaidBgError extends Error {
  constructor(key, params = {}) {
    super(key);
    this.key = key;
    this.params = params;
  }
}

async function downloadAttachment(attachment) {
  const response = await fetch(attachment.url);
  if (!response.ok) {
    throw new RaidBgError("raidBg.errors.downloadFailed", { status: response.status });
  }
  return Buffer.from(await response.arrayBuffer());
}

async function validateBgAttachment(attachment, buffer) {
  if (attachment.size > RAID_BG_MAX_BYTES) {
    throw new RaidBgError("raidBg.errors.sizeTooBig", {
      sizeMb: (attachment.size / 1024 / 1024).toFixed(1),
      maxMb: RAID_BG_MAX_MB.toFixed(0),
    });
  }
  const mime = (attachment.contentType || "").toLowerCase().split(";")[0].trim();
  if (mime && !RAID_BG_ALLOWED_MIME.has(mime)) {
    throw new RaidBgError("raidBg.errors.formatUnsupported", { mime });
  }

  let img;
  try {
    img = await loadImage(buffer);
  } catch (err) {
    throw new RaidBgError("raidBg.errors.decodeFailed", { message: err.message });
  }

  if (img.width < RAID_BG_MIN_WIDTH || img.height < RAID_BG_MIN_HEIGHT) {
    throw new RaidBgError("raidBg.errors.tooSmall", {
      width: img.width,
      height: img.height,
      minW: RAID_BG_MIN_WIDTH,
      minH: RAID_BG_MIN_HEIGHT,
    });
  }
  if (img.width > RAID_BG_MAX_WIDTH || img.height > RAID_BG_MAX_HEIGHT) {
    throw new RaidBgError("raidBg.errors.tooLarge", {
      width: img.width,
      height: img.height,
      maxW: RAID_BG_MAX_WIDTH,
      maxH: RAID_BG_MAX_HEIGHT,
    });
  }

  return { width: img.width, height: img.height, mime };
}

async function rehostBackground({ client, buffer, attachment, AttachmentBuilder }) {
  const channelId = getBgChannelId();
  if (!channelId) {
    throw new RaidBgError("raidBg.errors.channelMissing");
  }

  let channel;
  try {
    channel = await client.channels.fetch(channelId);
  } catch (err) {
    throw new RaidBgError("raidBg.errors.channelFetchFailed", {
      channelId,
      message: err.message,
    });
  }
  if (!channel || !channel.isTextBased?.()) {
    throw new RaidBgError("raidBg.errors.notTextChannel", { channelId });
  }

  const filename = attachment.name || "background.png";
  const file = new AttachmentBuilder(buffer, { name: filename });

  const sent = await channel.send({
    content: `Background rehost · uploader <t:${Math.floor(Date.now() / 1000)}:f>`,
    files: [file],
    allowedMentions: { parse: [] },
  });

  return {
    messageId: sent.id,
    channelId: channel.id,
    filename,
  };
}

/**
 * Resolve a fresh attachment URL for a stored bg reference. Discord
 * re-signs the attachment URL on every message fetch, so this is the
 * canonical way to get a non-expired URL for a previously-rehosted
 * background. Returns null if the message was deleted / channel
 * removed / bot lost access · the caller falls back to the default
 * theme in that case.
 */
async function refreshBackgroundUrl({ client, messageId, channelId }) {
  if (!messageId || !channelId) return null;
  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel || !channel.isTextBased?.()) return null;
    const message = await channel.messages.fetch(messageId);
    const att = message.attachments?.first();
    return att?.url || null;
  } catch (err) {
    if (err.code !== 10008 && err.code !== 10003) {
      console.warn(
        `[raid-bg] refreshBackgroundUrl failed for ${channelId}/${messageId}:`,
        err.message,
      );
    }
    return null;
  }
}

// ─── Subcommand handlers ────────────────────────────────────────────────────

async function handleSet({ interaction, deps, lang }) {
  const { User, saveWithRetry, AttachmentBuilder, EmbedBuilder, MessageFlags } = deps;
  const client = interaction.client;
  const attachment = interaction.options.getAttachment("image", true);

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  let buffer;
  let dims;
  let rehosted;

  try {
    buffer = await downloadAttachment(attachment);
    dims = await validateBgAttachment(attachment, buffer);
    rehosted = await rehostBackground({ client, buffer, attachment, AttachmentBuilder });
  } catch (err) {
    if (!(err instanceof RaidBgError)) throw err;
    // Validation errors get a richer reject card with the requirements
    // recap; infra errors (download, channel) get a thinner alert.
    const isValidation =
      err.key === "raidBg.errors.sizeTooBig"
      || err.key === "raidBg.errors.formatUnsupported"
      || err.key === "raidBg.errors.decodeFailed"
      || err.key === "raidBg.errors.tooSmall"
      || err.key === "raidBg.errors.tooLarge";
    const title = isValidation
      ? t("raidBg.set.rejectTitle", lang)
      : t("raidBg.set.downloadFailedTitle", lang);
    const color = isValidation ? 0xfee75c : 0xed4245;
    const embed = new EmbedBuilder()
      .setTitle(title)
      .setDescription(t(err.key, lang, err.params))
      .setColor(color);
    if (isValidation) {
      embed.addFields({
        name: t("raidBg.set.requirementsHeader", lang),
        value: t("raidBg.set.requirementsLines", lang, {
          minW: RAID_BG_MIN_WIDTH,
          minH: RAID_BG_MIN_HEIGHT,
          maxW: RAID_BG_MAX_WIDTH,
          maxH: RAID_BG_MAX_HEIGHT,
          maxMb: RAID_BG_MAX_MB.toFixed(0),
        }),
        inline: false,
      });
    }
    await interaction.editReply({ embeds: [embed] });
    return;
  }

  await saveWithRetry(async () => {
    return User.findOneAndUpdate(
      { discordId: interaction.user.id },
      {
        $set: {
          backgroundImageMessageId: rehosted.messageId,
          backgroundImageChannelId: rehosted.channelId,
          backgroundImageFilename: rehosted.filename,
          backgroundImageUpdatedAt: Date.now(),
        },
      },
      { upsert: true, new: true },
    );
  });

  await interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setTitle(t("raidBg.set.successTitle", lang))
        .setDescription(t("raidBg.set.successDescription", lang))
        .addFields(
          { name: t("raidBg.set.fileLabel", lang), value: `\`${rehosted.filename}\``, inline: true },
          { name: t("raidBg.set.dimsLabel", lang), value: `\`${dims.width}x${dims.height}\``, inline: true },
          { name: t("raidBg.set.formatLabel", lang), value: `\`${dims.mime || "auto"}\``, inline: true },
        )
        .setFooter({ text: t("raidBg.set.footer", lang) })
        .setColor(0x57f287)
        .setImage(attachment.url),
    ],
  });
}

async function handleView({ interaction, deps, lang }) {
  const { User, EmbedBuilder, MessageFlags } = deps;
  const client = interaction.client;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const user = await User.findOne({ discordId: interaction.user.id }).lean();
  if (!user?.backgroundImageMessageId) {
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle(t("raidBg.view.noneTitle", lang))
          .setDescription(t("raidBg.view.noneDescription", lang))
          .setColor(0x5865f2),
      ],
    });
    return;
  }

  const freshUrl = await refreshBackgroundUrl({
    client,
    messageId: user.backgroundImageMessageId,
    channelId: user.backgroundImageChannelId,
  });

  if (!freshUrl) {
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle(t("raidBg.view.unavailableTitle", lang))
          .setDescription(t("raidBg.view.unavailableDescription", lang))
          .setColor(0xfee75c),
      ],
    });
    return;
  }

  const updatedAtTs = user.backgroundImageUpdatedAt
    ? Math.floor(user.backgroundImageUpdatedAt / 1000)
    : null;

  await interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setTitle(t("raidBg.view.currentTitle", lang))
        .setDescription(t("raidBg.view.currentDescription", lang))
        .addFields(
          {
            name: t("raidBg.view.fileLabel", lang),
            value: `\`${user.backgroundImageFilename || "background"}\``,
            inline: true,
          },
          {
            name: t("raidBg.view.uploadLabel", lang),
            value: updatedAtTs ? `<t:${updatedAtTs}:R>` : t("raidBg.view.uploadUnknown", lang),
            inline: true,
          },
        )
        .setFooter({ text: t("raidBg.view.footer", lang) })
        .setColor(0x5865f2)
        .setImage(freshUrl),
    ],
  });
}

async function handleRemove({ interaction, deps, lang }) {
  const { User, saveWithRetry, EmbedBuilder, MessageFlags } = deps;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const user = await User.findOne({ discordId: interaction.user.id }).lean();
  if (!user?.backgroundImageMessageId) {
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle(t("raidBg.remove.nothingTitle", lang))
          .setDescription(t("raidBg.remove.nothingDescription", lang))
          .setColor(0x5865f2),
      ],
    });
    return;
  }

  await saveWithRetry(async () => {
    return User.findOneAndUpdate(
      { discordId: interaction.user.id },
      {
        $set: {
          backgroundImageMessageId: "",
          backgroundImageChannelId: "",
          backgroundImageFilename: "",
          backgroundImageUpdatedAt: null,
        },
      },
      { new: true },
    );
  });

  await interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setTitle(t("raidBg.remove.successTitle", lang))
        .setDescription(t("raidBg.remove.successDescription", lang))
        .setColor(0x99aab5),
    ],
  });
}

// ─── Factory ────────────────────────────────────────────────────────────────

function createRaidBgCommand(deps) {
  const { User } = deps;
  async function handleRaidBgCommand(interaction) {
    // Resolve viewer language ONCE at handler entry so every subcommand
    // path renders in Artist's voice in the caller's preferred locale.
    const lang = await getUserLanguage(interaction.user.id, { UserModel: User });
    const sub = interaction.options.getSubcommand();
    if (sub === "set") return handleSet({ interaction, deps, lang });
    if (sub === "view") return handleView({ interaction, deps, lang });
    if (sub === "remove") return handleRemove({ interaction, deps, lang });
  }

  return {
    handleRaidBgCommand,
  };
}

module.exports = {
  createRaidBgCommand,
  refreshBackgroundUrl,
};
