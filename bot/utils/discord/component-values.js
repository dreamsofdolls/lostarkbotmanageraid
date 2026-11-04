"use strict";

function firstSelectValue(component, fallback = null) {
  return Array.isArray(component?.values) && component.values.length > 0
    ? component.values[0]
    : fallback;
}

/**
 * Every value a select submitted, as strings.
 * @param {{values?: unknown[]}} component - select interaction
 * @returns {string[]} empty when the component carries no values
 */
function selectValues(component) {
  return Array.isArray(component?.values) ? component.values.map(String) : [];
}

module.exports = {
  firstSelectValue,
  selectValues,
};
