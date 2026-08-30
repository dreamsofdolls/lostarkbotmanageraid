"use strict";

function createProcessTerminator({
  client,
  getLocalSyncWeb = () => null,
  disconnect,
  exit = (code) => process.exit(code),
  logger = console,
} = {}) {
  let terminating = false;

  return async function terminate({ label, error = null, exitCode = 1 } = {}) {
    if (terminating) return false;
    terminating = true;

    if (error) logger.error(`[bot] ${label}:`, error);
    else logger.log(`[bot] ${label}`);

    try {
      await Promise.resolve(getLocalSyncWeb()?.stop?.());
    } catch (stopError) {
      logger.warn(
        "[bot] Local Reader shutdown failed:",
        stopError?.message || stopError
      );
    }

    try {
      await Promise.resolve(client?.destroy?.());
    } catch (destroyError) {
      logger.warn(
        "[bot] Discord shutdown failed:",
        destroyError?.message || destroyError
      );
    }

    try {
      await disconnect?.();
    } catch (disconnectError) {
      logger.warn(
        "[bot] MongoDB shutdown failed:",
        disconnectError?.message || disconnectError
      );
    }

    exit(exitCode);
    return true;
  };
}

function installProcessLifecycle({ terminate, processRef = process } = {}) {
  processRef.on("unhandledRejection", (reason) => {
    void terminate({ label: "Unhandled promise rejection", error: reason, exitCode: 1 });
  });
  processRef.on("uncaughtException", (error) => {
    void terminate({ label: "Uncaught exception", error, exitCode: 1 });
  });
  processRef.once("SIGINT", () => {
    void terminate({ label: "SIGINT received, shutting down...", exitCode: 0 });
  });
  processRef.once("SIGTERM", () => {
    void terminate({ label: "SIGTERM received, shutting down...", exitCode: 0 });
  });
}

module.exports = {
  createProcessTerminator,
  installProcessLifecycle,
};
