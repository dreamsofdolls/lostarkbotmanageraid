"use strict";

// Emulates a Mongoose assignedRaids subdoc: toObject() returns a plain copy,
// and the copy is itself subdoc-like so a mocked User.findOne that keeps
// returning the same doc matches the fresh document a real findOne returns
// for every write.
function subdocAssignedRaid(plain) {
  return {
    ...plain,
    toObject() {
      const { toObject, ...rest } = this;
      return subdocAssignedRaid(rest);
    },
  };
}

module.exports = { subdocAssignedRaid };
