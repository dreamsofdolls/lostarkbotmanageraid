"use strict";

/**
 * The one way to redraw the /raid-status message after it first renders.
 *
 * The card and the controls are built from the same moment of the session:
 * buildEmbedAndCanvas builds its embeds before it awaits the roster
 * background, so the controls are built right before it is called. A redraw
 * that a newer one started after it, or that finishes once the session has
 * ended, is dropped, so a slow background can never land one page's card
 * with another page's controls or switch expired controls back on.
 *
 * @param {object} deps
 * @param {object} deps.interaction - the /raid-status command interaction
 * @param {() => Promise<object>} deps.buildEmbedAndCanvas
 * @param {(disabled: boolean) => object[]} deps.buildComponents
 * @param {() => boolean} deps.isSessionEnded
 * @returns {() => Promise<boolean>} true when this redraw reached Discord;
 *   rejects when the edit itself fails
 */
function createStatusRedraw({ interaction, buildEmbedAndCanvas, buildComponents, isSessionEnded }) {
  let latestTicket = 0;
  return async function redraw() {
    const ticket = ++latestTicket;
    const components = buildComponents(false);
    const payload = await buildEmbedAndCanvas();
    if (ticket !== latestTicket || isSessionEnded()) return false;
    await interaction.editReply({ ...payload, components });
    return true;
  };
}

module.exports = {
  createStatusRedraw,
};
