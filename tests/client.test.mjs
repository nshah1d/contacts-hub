import test from 'node:test';
import assert from 'node:assert/strict';
import { EngineClient } from '../public/js/client.js';

function workers() {
    const created = [];
    const factory = () => {
        const worker = {
            messages: [],
            terminated: false,
            postMessage(message) { this.messages.push(message); },
            terminate() { this.terminated = true; }
        };
        created.push(worker);
        return worker;
    };
    return { created, factory };
}

test('a timed-out worker is replaced before later work', async () => {
    const { created, factory } = workers(), client = new EngineClient(factory, 10);
    await assert.rejects(client.request('query'), /timed out/);
    assert.equal(created.length, 2);
    assert.equal(created[0].terminated, true);
    const waiting = client.request('clear');
    const message = created[1].messages[0];
    created[1].onmessage({ data: { id: message.id, result: true } });
    assert.equal(await waiting, true);
    client.destroy();
});

test('a worker error rejects waiters and publishes a fresh worker', async () => {
    const { created, factory } = workers(), client = new EngineClient(factory, 1000);
    const waiting = client.request('open');
    created[0].onerror(new Error('broken'));
    await assert.rejects(waiting, /worker stopped/);
    assert.equal(created.length, 2);
    client.destroy();
});

test('destroyed clients reject new work without creating another worker', async () => {
    const { created, factory } = workers(), client = new EngineClient(factory, 1000);
    client.destroy();
    await assert.rejects(client.request('query'), /closed/);
    assert.equal(created.length, 1);
});
