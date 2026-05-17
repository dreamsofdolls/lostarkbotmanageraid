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
 * Strings are VN-first (this bot's voice; see project_raidmanage_loalogs_voice
 * memory). The i18n pipeline isn't wired through yet · a later commit
 * can extract these into bot/locales/* without changing behavior here.
 */

"use strict";

const { loadImage } = require("@napi-rs/canvas");

const RAID_BG_MIN_WIDTH = 1600;
const RAID_BG_MIN_HEIGHT = 900;
const RAID_BG_MAX_WIDTH = 3840;
const RAID_BG_MAX_HEIGHT = 2160;
const RAID_BG_MAX_BYTES = 8 * 1024 * 1024;
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
 * Download the user-supplied attachment so the bot can both inspect
 * dimensions and re-upload to the bg channel. Failure modes here are
 * non-recoverable for /raid-bg set · the command bails with a clear
 * alert so the user can retry with a different URL.
 */
async function downloadAttachment(attachment) {
  const response = await fetch(attachment.url);
  if (!response.ok) {
    throw new Error(`Discord returned HTTP ${response.status} when downloading the attachment.`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  return buffer;
}

/**
 * Validate the supplied attachment against the dimension / size / MIME
 * constraints announced in the user-facing prompt. Throws with a VN
 * error message if anything fails; the caller wraps the throw into an
 * alert embed reply.
 */
async function validateBgAttachment(attachment, buffer) {
  if (attachment.size > RAID_BG_MAX_BYTES) {
    throw new Error(
      `File quá lớn (${(attachment.size / 1024 / 1024).toFixed(1)} MB). ` +
        `Giới hạn là ${(RAID_BG_MAX_BYTES / 1024 / 1024).toFixed(0)} MB.`,
    );
  }
  const mime = (attachment.contentType || "").toLowerCase().split(";")[0].trim();
  if (mime && !RAID_BG_ALLOWED_MIME.has(mime)) {
    throw new Error(
      `Định dạng "${mime}" không hỗ trợ. Chỉ chấp nhận PNG / JPG / WEBP.`,
    );
  }

  let img;
  try {
    img = await loadImage(buffer);
  } catch (err) {
    throw new Error(`Không decode được ảnh: ${err.message}`);
  }

  if (img.width < RAID_BG_MIN_WIDTH || img.height < RAID_BG_MIN_HEIGHT) {
    throw new Error(
      `Ảnh quá nhỏ (${img.width}x${img.height}). ` +
        `Tối thiểu ${RAID_BG_MIN_WIDTH}x${RAID_BG_MIN_HEIGHT} để raid card không bị mờ.`,
    );
  }
  if (img.width > RAID_BG_MAX_WIDTH || img.height > RAID_BG_MAX_HEIGHT) {
    throw new Error(
      `Ảnh quá lớn (${img.width}x${img.height}). ` +
        `Tối đa ${RAID_BG_MAX_WIDTH}x${RAID_BG_MAX_HEIGHT} (4K) để bot xử lý nhẹ.`,
    );
  }

  return { width: img.width, height: img.height, mime };
}

/**
 * Re-upload the validated attachment buffer into the operator-guild
 * background channel so the resulting message ID + channel ID can be
 * stored on the user document. Returns the saved refs the caller will
 * persist; throws on infrastructure failure (channel missing, missing
 * Send perms, etc.) so the command surfaces an actionable alert.
 */
async function rehostBackground({ client, buffer, attachment, AttachmentBuilder }) {
  const channelId = getBgChannelId();
  if (!channelId) {
    throw new Error(
      "RAID_BG_CHANNEL_ID chưa được set trên Railway. Liên hệ bot owner để cấu hình.",
    );
  }

  let channel;
  try {
    channel = await client.channels.fetch(channelId);
  } catch (err) {
    throw new Error(`Không fetch được bg channel ${channelId}: ${err.message}`);
  }
  if (!channel || !channel.isTextBased?.()) {
    throw new Error(`Bg channel ${channelId} không phải text channel.`);
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
    // Unknown message / channel · acceptable failure mode (user
    // removed image from channel, channel deleted, etc.).
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

async function handleSet({ interaction, deps }) {
  const { User, saveWithRetry, AttachmentBuilder, EmbedBuilder, MessageFlags } = deps;
  const client = interaction.client;
  const attachment = interaction.options.getAttachment("image", true);

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  let buffer;
  try {
    buffer = await downloadAttachment(attachment);
  } catch (err) {
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle("❌ Tải ảnh thất bại")
          .setDescription(err.message)
          .setColor(0xed4245),
      ],
    });
    return;
  }

  let dims;
  try {
    dims = await validateBgAttachment(attachment, buffer);
  } catch (err) {
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle("⚠️ Ảnh chưa đạt yêu cầu")
          .setDescription(err.message)
          .addFields(
            {
              name: "Yêu cầu",
              value: [
                `• Kích thước: tối thiểu **${RAID_BG_MIN_WIDTH}x${RAID_BG_MIN_HEIGHT}**, tối đa **${RAID_BG_MAX_WIDTH}x${RAID_BG_MAX_HEIGHT}**`,
                `• Dung lượng: tối đa **${(RAID_BG_MAX_BYTES / 1024 / 1024).toFixed(0)} MB**`,
                `• Định dạng: PNG / JPG / WEBP`,
              ].join("\n"),
              inline: false,
            },
          )
          .setColor(0xfee75c),
      ],
    });
    return;
  }

  let rehosted;
  try {
    rehosted = await rehostBackground({
      client,
      buffer,
      attachment,
      AttachmentBuilder,
    });
  } catch (err) {
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle("❌ Lưu ảnh thất bại")
          .setDescription(err.message)
          .setColor(0xed4245),
      ],
    });
    return;
  }

  // Persist refs on the user document. Upsert because new users who run
  // /raid-bg before any other command don't have a User row yet.
  await saveWithRetry(async () => {
    const user = await User.findOneAndUpdate(
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
    return user;
  });

  await interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setTitle("✅ Background đã được lưu")
        .setDescription(
          `Lần tới cậu chạy \`/raid-status\` sẽ thấy raid card với ảnh này làm background.`,
        )
        .addFields(
          { name: "🖼️ File", value: `\`${rehosted.filename}\``, inline: true },
          { name: "📐 Kích thước", value: `\`${dims.width}x${dims.height}\``, inline: true },
          { name: "💾 Định dạng", value: `\`${dims.mime || "auto"}\``, inline: true },
        )
        .setFooter({ text: "Dùng /raid-bg view để preview · /raid-bg remove để xoá" })
        .setColor(0x57f287)
        .setImage(attachment.url),
    ],
  });
}

async function handleView({ interaction, deps }) {
  const { User, EmbedBuilder, MessageFlags } = deps;
  const client = interaction.client;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const user = await User.findOne({ discordId: interaction.user.id }).lean();
  if (!user?.backgroundImageMessageId) {
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle("ℹ️ Chưa có background")
          .setDescription(
            "Cậu chưa upload background. Chạy `/raid-bg set image:<file>` để thêm ảnh đầu tiên.",
          )
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
          .setTitle("⚠️ Background không truy cập được")
          .setDescription(
            "Ảnh đã lưu nhưng bot không fetch được nữa (channel bị xoá / message bị remove). " +
              "Chạy `/raid-bg set` để upload lại, hoặc `/raid-bg remove` để revert.",
          )
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
        .setTitle("🖼️ Background hiện tại")
        .setDescription(`Đang được dùng cho \`/raid-status\` raid card của cậu.`)
        .addFields(
          { name: "📁 File", value: `\`${user.backgroundImageFilename || "background"}\``, inline: true },
          {
            name: "🕐 Upload",
            value: updatedAtTs ? `<t:${updatedAtTs}:R>` : "không rõ",
            inline: true,
          },
        )
        .setFooter({ text: "Dùng /raid-bg set để đổi · /raid-bg remove để xoá" })
        .setColor(0x5865f2)
        .setImage(freshUrl),
    ],
  });
}

async function handleRemove({ interaction, deps }) {
  const { User, saveWithRetry, EmbedBuilder, MessageFlags } = deps;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const user = await User.findOne({ discordId: interaction.user.id }).lean();
  if (!user?.backgroundImageMessageId) {
    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle("ℹ️ Không có gì để xoá")
          .setDescription("Cậu chưa upload background nào.")
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
        .setTitle("🗑️ Background đã xoá")
        .setDescription(
          "Cậu đã trở lại với text embed mặc định cho `/raid-status`. " +
            "Chạy `/raid-bg set` để upload background mới bất kỳ lúc nào.",
        )
        .setColor(0x99aab5),
      ],
  });
}

// ─── Factory ────────────────────────────────────────────────────────────────

function createRaidBgCommand(deps) {
  async function handleRaidBgCommand(interaction) {
    const sub = interaction.options.getSubcommand();
    if (sub === "set") return handleSet({ interaction, deps });
    if (sub === "view") return handleView({ interaction, deps });
    if (sub === "remove") return handleRemove({ interaction, deps });
  }

  return {
    handleRaidBgCommand,
  };
}

module.exports = {
  createRaidBgCommand,
  refreshBackgroundUrl,
};
