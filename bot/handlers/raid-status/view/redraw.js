"use strict";

/**
 * The one way to redraw the /raid-status message after it first renders.
 *
 * The card and the controls are built from the same moment of the session:
 * buildEmbedAndCanvas builds its embeds before it awaits the roster
 * background, so the controls are built right before it is called. A redraw
 * that a newer one started after it is dropped. Discord writes run one at
 * a time, retaining only the latest waiting payload. finish() writes the
 * expired card last, including when an earlier edit is already in flight.
 *
 * @param {object} deps
 * @param {object} deps.interaction - the /raid-status command interaction
 * @param {() => Promise<object>} deps.buildEmbedAndCanvas
 * @param {(disabled: boolean) => object[]} deps.buildComponents
 * @param {() => boolean} deps.isSessionEnded
 * @returns {Function} redraw(), show(payload), and finish(payload) resolve
 *   true when their payload reached Discord; edit failures reject.
 */
function createStatusRedraw({ interaction, buildEmbedAndCanvas, buildComponents, isSessionEnded }) {
  let latestTicket = 0;
  let activeEdit = false;
  let pendingEdit = null;
  let finishing = false;
  let finalEdit;

  function discardPending() {
    pendingEdit?.resolve(false);
    pendingEdit = null;
  }

  const isCurrent = job => job.final || (!finishing && !isSessionEnded() && job.ticket === latestTicket);

  function dispatch() {
    if (activeEdit || !pendingEdit) return;
    const job = pendingEdit;
    pendingEdit = null;
    activeEdit = true;
    Promise.resolve().then(async () => {
      if (!isCurrent(job)) return false;
      await interaction.editReply(job.payload);
      return true;
    }).finally(() => {
      activeEdit = false;
      dispatch();
    }).then(job.resolve, job.reject);
  }

  function enqueue(payload, ticket, final = false) {
    return new Promise((resolve, reject) => {
      discardPending();
      pendingEdit = { payload, ticket, final, resolve, reject };
      dispatch();
    });
  }

  async function redraw() {
    if (finishing || isSessionEnded()) return false;
    const ticket = ++latestTicket;
    discardPending();
    const components = buildComponents(false);
    const payload = await buildEmbedAndCanvas();
    if (ticket !== latestTicket || finishing || isSessionEnded()) return false;
    return enqueue({ ...payload, components }, ticket);
  }

  redraw.show = payload => {
    if (finishing || isSessionEnded()) return Promise.resolve(false);
    return enqueue(payload, ++latestTicket);
  };
  redraw.finish = payload => {
    if (finishing) return finalEdit;
    finishing = true;
    finalEdit = enqueue(payload, ++latestTicket, true);
    return finalEdit;
  };
  return redraw;
}

module.exports = {
  createStatusRedraw,
};
