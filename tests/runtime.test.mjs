import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { once } from 'node:events';
import { staticServer } from '../tools/serve.mjs';
import { fixtureLibraries } from '../tools/fixtures.mjs';
import { embeddedPhoto } from '../public/js/ui/photo.js';
async function worker() {
    const w = new Worker(new URL('./worker-bridge.mjs', import.meta.url));
    await once(w, 'message');
    let sequence = 0;
    return { close: () => w.terminate(), request: (type, payload = {}) => new Promise((resolve, reject) => {
            const id = ++sequence;
            const handler = data => {
                if (data.id !== id)
                    return;
                w.off('message', handler);
                data.error ? reject(Object.assign(new Error(data.error.message), { code: data.error.code })) : resolve(data.result);
            };
            w.on('message', handler);
            w.postMessage({ id, type, payload });
        }) };
}
test('native Node ESM worker runs production parsing and queries', async () => {
    const w = await worker();
    try {
        await w.request('open', fixtureLibraries()[0]);
        const result = await w.request('query', { query: 'amira', limit: 80 });
        assert.equal(result.total, 1);
        assert.equal((await w.request('detail', { id: result.items[0].id })).peers.length, 2);
    }
    finally {
        await w.close();
    }
});
test('native worker failed import leaves the previous snapshot intact', async () => {
    const w = await worker();
    try {
        await w.request('open', fixtureLibraries()[0]);
        await assert.rejects(w.request('open', { text: '\0', name: 'People.vcf' }));
        assert.equal((await w.request('query', { limit: 80 })).total, 30);
    }
    finally {
        await w.close();
    }
});
test('native worker clear releases sources and cached windows', async () => {
    const w = await worker();
    try {
        await w.request('open', fixtureLibraries()[0]);
        await w.request('query', { limit: 80 });
        await w.request('clear');
        assert.equal((await w.request('query', { limit: 80 })).total, 0);
    }
    finally {
        await w.close();
    }
});
test('native worker reports unsupported operations', async () => {
    const w = await worker();
    try {
        await assert.rejects(w.request('shell', { sourceId: 'none' }));
    }
    finally {
        await w.close();
    }
});
test('static HTTP inspection serves public modules and denies private surfaces', async () => {
    const server = staticServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
        for (const path of ['/', '/js/app.js']) {
            const res = await fetch(base + path);
            assert.equal(res.status, 200);
            assert.equal(res.headers.get('X-Content-Type-Options'), 'nosniff');
            await res.arrayBuffer();
        }
        for (const path of ['/scan.php', '/write.php', '/read.php', '/session.php', '/server/config.php', '/.git/config', '/%2e%2e/server/common.php', '/secret.vcf', '/%00', '/../.env', '/%5c..%5cserver']) {
            const res = await fetch(base + path);
            assert.equal(res.status, 404, path);
            await res.arrayBuffer();
        }
        assert.equal((await fetch(base + '/js/app.js', { method: 'POST' })).status, 405);
        const head = await fetch(base + '/', { method: 'HEAD' });
        assert.equal((await head.text()).length, 0);
    }
    finally {
        server.close();
        await once(server, 'close');
    }
});
test('remote photos are never interpreted as embedded preview bytes', () => {
    assert.equal(embeddedPhoto({ value: 'https://example.com/tracker.png', params: {} }), null);
});
test('SVG data is never an active photo preview', () => {
    assert.equal(embeddedPhoto({ value: 'data:image/svg+xml;base64,PHN2Zy8+', params: {} }), null);
});
test('lying PNG dimensions reject the preview before decoding', () => {
    const bytes = new Uint8Array(24);
    bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
    const d = new DataView(bytes.buffer);
    d.setUint32(16, 9000);
    d.setUint32(20, 9000);
    assert.throws(() => embeddedPhoto({ value: Buffer.from(bytes).toString('base64'), params: { ENCODING: 'b' } }));
});
test('tiny PNG preview requires matching MIME and dimensions', () => {
    const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aHAAAAABJRU5ErkJggg==', 'base64');
    assert.equal(embeddedPhoto({ value: bytes.toString('base64'), params: { ENCODING: 'b' } }).width, 1);
    assert.throws(() => embeddedPhoto({ value: 'data:image/jpeg;base64,' + bytes.toString('base64'), params: {} }));
});
