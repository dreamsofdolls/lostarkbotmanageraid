"use strict";

/**
 * Stub User model for conditional findOneAndUpdate / findOne(.select().lean()) tests.
 * @param {{ findOneAndUpdateImpl?: Function, findOneImpl?: Function }} [options]
 * @returns {{ calls: { findOneAndUpdate: object[], findOne: object[] }, findOneAndUpdate: Function, findOne: Function }}
 */
function makeUserStub({ findOneAndUpdateImpl, findOneImpl } = {}) {
  const calls = { findOneAndUpdate: [], findOne: [] };
  const runFindOne = (filter) => (
    typeof findOneImpl === "function" ? findOneImpl(filter) : Promise.resolve(null)
  );
  return {
    calls,
    findOneAndUpdate: (filter, update, options) => {
      calls.findOneAndUpdate.push({ filter, update, options });
      if (typeof findOneAndUpdateImpl === "function") {
        return findOneAndUpdateImpl(filter, update, options);
      }
      return Promise.resolve(null);
    },
    findOne: (filter) => {
      calls.findOne.push({ filter });
      return {
        select: () => ({
          lean: () => runFindOne(filter),
        }),
        lean: () => runFindOne(filter),
      };
    },
  };
}

module.exports = { makeUserStub };
