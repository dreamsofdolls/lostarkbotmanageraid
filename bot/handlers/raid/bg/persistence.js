"use strict";

const UserBackground = require("../../../models/userBackground");

const LEGACY_IMAGE_UNSET = Object.freeze({
  imageData: "",
  mime: "",
  width: "",
  height: "",
  sizeBytes: "",
  originalWidth: "",
  originalHeight: "",
  originalFilename: "",
  originalMime: "",
  storageQuality: "",
});

function buildLibraryUpdate({ discordId, images, assignments, mode }) {
  return {
    $set: {
      discordId,
      mode: mode || "even",
      images,
      assignments,
    },
    $unset: LEGACY_IMAGE_UNSET,
  };
}

async function upsertLibrary(discordId, images, assignments, mode) {
  return UserBackground.findOneAndUpdate(
    { discordId },
    buildLibraryUpdate({ discordId, images, assignments, mode }),
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
}

async function saveLibrary(discordId, images, assignments, mode) {
  return UserBackground.findOneAndUpdate(
    { discordId },
    buildLibraryUpdate({ discordId, images, assignments, mode }),
    { new: true },
  );
}

module.exports = {
  buildLibraryUpdate,
  saveLibrary,
  upsertLibrary,
};
