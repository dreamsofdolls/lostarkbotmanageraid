"use strict";

/**
 * Lightweight fake Discord builders for pure unit tests that do not need
 * discord.js's module load overhead.
 */
class FakeEmbedBuilder {
  constructor() {
    this.data = { fields: [] };
  }

  setColor(color) {
    this.data.color = color;
    return this;
  }

  setTitle(title) {
    this.data.title = title;
    return this;
  }

  setDescription(description) {
    this.data.description = description;
    return this;
  }

  setFooter(footer) {
    this.data.footer = footer;
    return this;
  }

  setAuthor(author) {
    this.data.author = author;
    return this;
  }

  setTimestamp(timestamp = true) {
    this.data.timestamp = timestamp;
    return this;
  }

  addFields(...fields) {
    this.data.fields.push(...fields);
    return this;
  }
}

class FakeActionRowBuilder {
  constructor() {
    this.components = [];
  }

  addComponents(...components) {
    this.components.push(...components);
    return this;
  }
}

class FakeButtonBuilder {
  constructor() {
    this.data = {};
  }

  setCustomId(customId) {
    this.data.customId = customId;
    return this;
  }

  setLabel(label) {
    this.data.label = label;
    return this;
  }

  setEmoji(emoji) {
    this.data.emoji = emoji;
    return this;
  }

  setStyle(style) {
    this.data.style = style;
    return this;
  }

  setDisabled(disabled) {
    this.data.disabled = disabled;
    return this;
  }
}

class FakeSelectMenuBuilder {
  constructor() {
    this.data = {};
  }

  setCustomId(customId) {
    this.data.customId = customId;
    return this;
  }

  setPlaceholder(placeholder) {
    this.data.placeholder = placeholder;
    return this;
  }

  setDisabled(disabled) {
    this.data.disabled = disabled;
    return this;
  }

  addOptions(options) {
    this.data.options = options;
    return this;
  }
}

module.exports = {
  FakeActionRowBuilder,
  FakeButtonBuilder,
  FakeEmbedBuilder,
  FakeSelectMenuBuilder,
};
