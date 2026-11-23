'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createOperationLocks, busyMessage } = require('../lib/oplock');

function deferred() {
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

test('same key: one runs, second is busy with holder operation and since', async () => {
    let t = 1000;
    const locks = createOperationLocks({ now: () => t });
    const gate = deferred();
    let ran = 0;
    const first = locks.run('remote:foo', 'mounting', async () => { ran++; await gate.promise; return 'a'; });
    t = 2000;
    const second = await locks.run('remote:foo', 'unmounting', async () => { ran++; });
    assert.deepEqual(second, { busy: true, key: 'remote:foo', operation: 'mounting', since: 1000 });
    assert.equal(ran, 1);
    assert.equal(locks.isBusy('remote:foo'), true);
    gate.resolve();
    assert.deepEqual(await first, { busy: false, value: 'a' });
    assert.equal(locks.isBusy('remote:foo'), false);
    assert.deepEqual(await locks.run('remote:foo', 'again', () => 7), { busy: false, value: 7 });
});

test('different keys run concurrently', async () => {
    const locks = createOperationLocks();
    const g1 = deferred(), g2 = deferred();
    const started = [];
    const a = locks.run('remote:a', 'mounting', async () => { started.push('a'); await g1.promise; return 1; });
    const b = locks.run('remote:b', 'mounting', async () => { started.push('b'); await g2.promise; return 2; });
    assert.deepEqual(started, ['a', 'b']);
    assert.equal(locks.snapshot().length, 2);
    g2.resolve(); g1.resolve();
    assert.deepEqual(await Promise.all([a, b]), [{ busy: false, value: 1 }, { busy: false, value: 2 }]);
    assert.deepEqual(locks.snapshot(), []);
});

test('multi-key is all-or-nothing: busy second key leaves first key free', async () => {
    const locks = createOperationLocks();
    const gate = deferred();
    const holder = locks.run('crontab', 'saving schedule', () => gate.promise);
    let ran = false;
    const res = await locks.run(['remote:foo', 'crontab'], 'deleting', () => { ran = true; });
    assert.equal(res.busy, true);
    assert.equal(res.key, 'crontab');
    assert.equal(res.operation, 'saving schedule');
    assert.equal(ran, false);
    assert.equal(locks.isBusy('remote:foo'), false);
    assert.deepEqual(locks.snapshot().map((s) => s.key), ['crontab']);
    gate.resolve();
    await holder;
});

test('multi-key acquires every key and releases every key; duplicates deduplicated', async () => {
    const locks = createOperationLocks();
    const gate = deferred();
    const p = locks.run(['config', 'remote:foo', 'config'], 'deleting', () => gate.promise);
    assert.deepEqual(locks.snapshot().map((s) => s.key), ['config', 'remote:foo']);
    assert.equal(locks.isBusy('config'), true);
    assert.equal(locks.isBusy('remote:foo'), true);
    gate.resolve();
    await p;
    assert.deepEqual(locks.snapshot(), []);
});

test('lock is released after fn throws synchronously and after it rejects; error propagates unchanged', async () => {
    const locks = createOperationLocks();
    const err1 = new Error('sync boom');
    await assert.rejects(locks.run('config', 'op', () => { throw err1; }), (e) => e === err1);
    assert.equal(locks.isBusy('config'), false);
    const err2 = new Error('async boom');
    await assert.rejects(locks.run(['config', 'crontab'], 'op', async () => { throw err2; }), (e) => e === err2);
    assert.deepEqual(locks.snapshot(), []);
    assert.deepEqual(await locks.run('config', 'op', () => 'ok'), { busy: false, value: 'ok' });
});

test('not reentrant: nested run of the same key from inside fn is busy', async () => {
    const locks = createOperationLocks();
    let inner;
    const outer = await locks.run('config', 'outer', async () => {
        inner = await locks.run('config', 'inner', () => 'nope');
        return 'done';
    });
    assert.deepEqual(outer, { busy: false, value: 'done' });
    assert.equal(inner.busy, true);
    assert.equal(inner.operation, 'outer');
    assert.equal(locks.isBusy('config'), false);
});

test('atomic acquisition: 50 concurrent callers on one key, exactly one runs', async () => {
    const locks = createOperationLocks();
    const gate = deferred();
    let ran = 0;
    const calls = Array.from({ length: 50 }, (_, i) =>
        locks.run('remote:foo', `op${i}`, async () => { ran++; await gate.promise; }));
    // Overlapping multi-key callers must not slip in either.
    const overlapping = locks.run(['remote:bar', 'remote:foo'], 'multi', async () => { ran++; });
    gate.resolve();
    const results = await Promise.all([...calls, overlapping]);
    assert.equal(ran, 1);
    assert.equal(results.filter((r) => !r.busy).length, 1);
    assert.equal(results[0].busy, false);
    for (const r of results.slice(1)) {
        assert.equal(r.busy, true);
        assert.equal(r.operation, 'op0');
    }
    assert.equal(locks.isBusy('remote:bar'), false);
});

test('first busy key in given order is reported', async () => {
    const locks = createOperationLocks();
    const g = deferred();
    const h1 = locks.run('remote:b', 'opB', () => g.promise);
    const h2 = locks.run('remote:a', 'opA', () => g.promise);
    const r1 = await locks.run(['remote:a', 'remote:b'], 'x', () => {});
    assert.equal(r1.key, 'remote:a');
    assert.equal(r1.operation, 'opA');
    const r2 = await locks.run(['remote:free', 'remote:b', 'remote:a'], 'x', () => {});
    assert.equal(r2.key, 'remote:b');
    assert.equal(r2.operation, 'opB');
    g.resolve();
    await Promise.all([h1, h2]);
});

test('snapshot reports key, operation, since', async () => {
    let t = 5;
    const locks = createOperationLocks({ now: () => t });
    const g = deferred();
    const p = locks.run('crontab', 'saving', () => g.promise);
    assert.deepEqual(locks.snapshot(), [{ key: 'crontab', operation: 'saving', since: 5 }]);
    g.resolve();
    await p;
});

test('waitIdle resolves immediately when idle and creates no timer', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const spy = t.mock.method(globalThis, 'setTimeout');
    const locks = createOperationLocks();
    const res = await locks.waitIdle(1000);
    assert.deepEqual(res, { idle: true, pending: [] });
    assert.equal(spy.mock.callCount(), 0);
});

test('waitIdle resolves after release and clears its timer', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const setSpy = t.mock.method(globalThis, 'setTimeout');
    const clearSpy = t.mock.method(globalThis, 'clearTimeout');
    const locks = createOperationLocks();
    const g = deferred();
    const p = locks.run('config', 'op', () => g.promise);
    const waiting = locks.waitIdle(1000);
    assert.equal(setSpy.mock.callCount(), 1);
    const timer = setSpy.mock.calls[0].result;
    let settled = null;
    waiting.then((r) => { settled = r; });
    g.resolve();
    await p;
    assert.deepEqual(await waiting, { idle: true, pending: [] });
    assert.equal(clearSpy.mock.callCount(), 1);
    assert.equal(clearSpy.mock.calls[0].arguments[0], timer);
    // Timer was cleared: ticking past the timeout must not change the result.
    t.mock.timers.tick(5000);
    await Promise.resolve();
    assert.deepEqual(settled, { idle: true, pending: [] });
});

test('waitIdle waits for ALL locks, not just the first release', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const locks = createOperationLocks();
    const g1 = deferred(), g2 = deferred();
    const p1 = locks.run('config', 'a', () => g1.promise);
    const p2 = locks.run('crontab', 'b', () => g2.promise);
    let done = false;
    const waiting = locks.waitIdle(1000).then((r) => { done = true; return r; });
    g1.resolve();
    await p1;
    await Promise.resolve();
    assert.equal(done, false);
    g2.resolve();
    await p2;
    assert.deepEqual(await waiting, { idle: true, pending: [] });
});

test('waitIdle times out with pending list; later release does not re-resolve or throw', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let now = 10;
    const locks = createOperationLocks({ now: () => now });
    const g = deferred();
    const p = locks.run('remote:foo', 'mounting', () => g.promise);
    const waiting = locks.waitIdle(200);
    t.mock.timers.tick(199);
    let done = false;
    waiting.then(() => { done = true; });
    await Promise.resolve();
    assert.equal(done, false);
    t.mock.timers.tick(1);
    assert.deepEqual(await waiting, {
        idle: false,
        pending: [{ key: 'remote:foo', operation: 'mounting', since: 10 }],
    });
    g.resolve();
    await p;
    assert.deepEqual(locks.snapshot(), []);
});

test('busyMessage maps keys to human names', () => {
    assert.equal(
        busyMessage({ busy: true, key: 'remote:foo', operation: 'mounting', since: 1 }),
        'Another operation is in progress on foo (mounting). Wait for it to finish.');
    assert.equal(
        busyMessage({ busy: true, key: 'config', operation: 'deleting remote', since: 1 }),
        'Another operation is in progress on the rclone config (deleting remote). Wait for it to finish.');
    assert.equal(
        busyMessage({ busy: true, key: 'crontab', operation: 'saving schedule', since: 1 }),
        'Another operation is in progress on the crontab (saving schedule). Wait for it to finish.');
    assert.equal(
        busyMessage({ busy: true, key: 'weird', operation: 'x', since: 1 }),
        'Another operation is in progress on weird (x). Wait for it to finish.');
    assert.equal(
        busyMessage({ busy: true, key: 'remote:a:b', operation: 'x', since: 1 }),
        'Another operation is in progress on a:b (x). Wait for it to finish.');
});

test('createOperationLocks exposes busyMessage on the instance', () => {
    const locks = createOperationLocks();
    assert.equal(locks.busyMessage, busyMessage);
});

test('argument validation', async () => {
    const locks = createOperationLocks();
    await assert.rejects(locks.run([], 'op', () => {}), TypeError);
    await assert.rejects(locks.run('', 'op', () => {}), TypeError);
    await assert.rejects(locks.run(undefined, 'op', () => {}), TypeError);
    await assert.rejects(locks.run(['a', 3], 'op', () => {}), TypeError);
    await assert.rejects(locks.run('a', 'op', 'nope'), TypeError);
    await assert.rejects(locks.run('a', 'op'), TypeError);
    await assert.rejects(locks.run('a', '', () => {}), TypeError);
    await assert.rejects(locks.waitIdle(-1), TypeError);
    await assert.rejects(locks.waitIdle('x'), TypeError);
    assert.deepEqual(locks.snapshot(), []);
});
