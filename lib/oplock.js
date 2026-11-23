'use strict';

// Non-blocking, all-or-nothing operation locks (issue #9). A caller that finds
// any of its keys held does not queue: it learns who holds the key and backs
// off. Check-and-acquire happens in one synchronous tick, so two concurrent
// callers can never both own an overlapping key. Locks are NOT reentrant.

function normalizeKeys(keys) {
    const list = typeof keys === 'string' ? [keys] : keys;
    if (!Array.isArray(list) || list.length === 0) {
        throw new TypeError('keys must be a non-empty string or array of strings');
    }
    for (const key of list) {
        if (typeof key !== 'string' || key === '') {
            throw new TypeError('every lock key must be a non-empty string');
        }
    }
    return [...new Set(list)];
}

function createOperationLocks({ now = Date.now } = {}) {
    // key -> { operation, since }
    const held = new Map();
    // callbacks invoked whenever the held set becomes empty
    const idleWaiters = new Set();

    function snapshot() {
        return [...held].map(([key, { operation, since }]) => ({ key, operation, since }));
    }

    function isBusy(key) {
        return held.has(key);
    }

    async function run(keys, operation, fn) {
        const list = normalizeKeys(keys);
        if (typeof operation !== 'string' || operation === '') {
            throw new TypeError('operation must be a non-empty string');
        }
        if (typeof fn !== 'function') throw new TypeError('fn must be a function');

        // Check + acquire with no await in between: atomic on the event loop.
        for (const key of list) {
            const holder = held.get(key);
            if (holder) {
                return { busy: true, key, operation: holder.operation, since: holder.since };
            }
        }
        const since = now();
        for (const key of list) held.set(key, { operation, since });

        try {
            const value = await fn();
            return { busy: false, value };
        } finally {
            for (const key of list) held.delete(key);
            if (held.size === 0) {
                const waiters = [...idleWaiters];
                idleWaiters.clear();
                for (const wake of waiters) wake();
            }
        }
    }

    function waitIdle(timeoutMs) {
        if (typeof timeoutMs !== 'number' || !(timeoutMs >= 0)) {
            return Promise.reject(new TypeError('timeoutMs must be a non-negative number'));
        }
        if (held.size === 0) return Promise.resolve({ idle: true, pending: [] });
        return new Promise((resolve) => {
            let timer = null;
            const wake = () => {
                clearTimeout(timer);
                resolve({ idle: true, pending: [] });
            };
            timer = setTimeout(() => {
                idleWaiters.delete(wake);
                resolve({ idle: false, pending: snapshot() });
            }, timeoutMs);
            idleWaiters.add(wake);
        });
    }

    return { run, isBusy, snapshot, waitIdle, busyMessage };
}

function describeKey(key) {
    if (key === 'config') return 'the rclone config';
    if (key === 'crontab') return 'the crontab';
    if (typeof key === 'string' && key.startsWith('remote:')) return key.slice('remote:'.length);
    return String(key);
}

function busyMessage(busyResult) {
    const { key, operation } = busyResult;
    return `Another operation is in progress on ${describeKey(key)} (${operation}). Wait for it to finish.`;
}

module.exports = { createOperationLocks, busyMessage };
