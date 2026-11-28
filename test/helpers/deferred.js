"use strict";

/**
 * Create an externally resolvable/rejectable Promise for concurrency tests.
 * @returns {{ promise: Promise<any>, resolve: Function, reject: Function }}
 */
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

module.exports = { deferred };
