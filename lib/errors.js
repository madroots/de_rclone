'use strict';

// Electron forwards only the message of an error thrown from an IPC handler, so
// the code is kept as a message prefix ("CODE: detail") and as a property for
// callers inside the main process.
class AppError extends Error {
    constructor(code, detail) {
        super(`${code}: ${detail}`);
        this.name = 'AppError';
        this.code = code;
        this.detail = detail;
    }
}

module.exports = { AppError };
