"use strict";

function firstSelectValue(component, fallback = null) {
  return Array.isArray(component?.values) && component.values.length > 0
    ? component.values[0]
    : fallback;
}

module.exports = {
  firstSelectValue,
};
