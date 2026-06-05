"use strict";

function disableComponentRows(rows) {
  for (const row of rows || []) {
    for (const component of row?.components || []) {
      if (typeof component.setDisabled === "function") {
        component.setDisabled(true);
      }
    }
  }
  return rows;
}

module.exports = {
  disableComponentRows,
};
