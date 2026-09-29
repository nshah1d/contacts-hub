import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryAdapter, FileAdapter, PHPAdapter, commitPlan } from '../public/js/adapters.js';
import { ContactEngine } from '../public/js/core/engine.js';
import { sha256 } from '../public/js/core/primitives.js';
import { fixtureLibraries, sampleCard } from '../tools/fixtures.mjs';
import { newVCard } from '../public/js/core/vcard.js';
const source = newVCard(sampleCard('Amira Khan', { org: 'Studio' }), 'test');
function setup() {
    const adapter = new MemoryAdapter('local', [{ name: 'People.vcf', text: source }]), core = new ContactEngine();
    core.open({ name: 'People.vcf', text: source });
    const engine = { request: async (type, p) => core.handle(type, p) };
    const c = core.libraries.get('People.vcf').contacts[0], plan = core.handle('plan', { sourceId: 'People.vcf', kind: 'edit', baseRevision: sha256(source), recordHash: c.hash, id: c.id, changes: { org: 'New studio' } });
    return { adapter, core, engine, plan };
}
test('successful commit reads back before changing worker snapshot', async () => {
    const { adapter, core, engine, plan } = setup();
    const result = await commitPlan(adapter, engine, plan);
    assert.equal(core.libraries.get('People.vcf').revision, plan.revision);
    assert.equal(result.receipt.persistence, 'session');
});
test('write denial retains committed source and draft', async () => {
    const { adapter, core, engine, plan } = setup();
    adapter.save = async () => {
        throw Object.assign(new Error('Denied'), { code: 'AUTH' });
    };
    await assert.rejects(commitPlan(adapter, engine, plan), /Denied/);
    assert.equal(core.libraries.get('People.vcf').text, source);
    assert.ok(plan.content.includes('New studio'));
});
test('a lost response is resolved by a matching read-back', async () => {
    const { adapter, engine, plan } = setup(), save = adapter.save.bind(adapter);
    adapter.save = async (p) => {
        await save(p);
        throw new Error('Lost response');
    };
    const result = await commitPlan(adapter, engine, plan);
    assert.equal(result.receipt.responseRecovered, true);
});
test('unknown outcome leaves worker unchanged', async () => {
    const { adapter, core, engine, plan } = setup(), save = adapter.save.bind(adapter);
    adapter.save = async (p) => {
        await save(p);
        throw new Error('Lost');
    };
    adapter.read = async () => {
        throw new Error('Offline');
    };
    await assert.rejects(commitPlan(adapter, engine, plan), { code: 'UNVERIFIED_SAVE' });
    assert.equal(core.libraries.get('People.vcf').text, source);
});
test('another writer cannot be overwritten with a stale plan', async () => {
    const { adapter, core, engine, plan } = setup();
    adapter.entries.get('People.vcf').text = source.replace('Studio', 'Other writer');
    await assert.rejects(commitPlan(adapter, engine, plan), { code: 'CONFLICT' });
    assert.equal(core.libraries.get('People.vcf').text, source);
    assert.match((await adapter.read('People.vcf')).text, /Other writer/);
});
test('successful response with wrong read-back never commits UI snapshot', async () => {
    const { adapter, core, engine, plan } = setup();
    adapter.save = async () => ({ revision: plan.revision });
    await assert.rejects(commitPlan(adapter, engine, plan), { code: 'CONFLICT' });
    assert.equal(core.libraries.get('People.vcf').text, source);
});
test('tampered draft checksum is rejected before transport', async () => {
    const { adapter, engine, plan } = setup();
    let called = false;
    adapter.save = async () => {
        called = true;
    };
    await assert.rejects(commitPlan(adapter, engine, { ...plan, content: plan.content + 'x' }), { code: 'INTEGRITY' });
    assert.equal(called, false);
});
test('new filename refuses replacement of an existing source', async () => {
    const { adapter } = setup();
    await assert.rejects(adapter.save({ filename: 'People.vcf', baseRevision: null, content: source, revision: sha256(source) }), { code: 'CONFLICT' });
});
test('zero-byte source is retained and can be read', async () => {
    const a = new MemoryAdapter();
    await a.save({ filename: 'Empty.vcf', baseRevision: null, revision: sha256(''), content: '' });
    assert.equal((await a.read('Empty.vcf')).text, '');
});
test('source filenames are validated at adapter boundary', async () => {
    assert.throws(() => new MemoryAdapter('local', [{ name: '../hidden.vcf', text: source }]));
});
test('duplicate selected filenames reject the whole workspace', () => {
    assert.throws(() => new MemoryAdapter('local', [{ name: 'a.vcf', text: source }, { name: 'a.vcf', text: source }]), /same or case-colliding filename/);
});
test('case-colliding filenames reject memory and file workspaces', () => {
    assert.throws(() => new MemoryAdapter('local', [{ name: 'People.vcf', text: source }, { name: 'people.VCF', text: source }]), /case-colliding/);
    assert.throws(() => new FileAdapter([new File([source], 'People.vcf'), new File([source], 'people.VCF')]), /case-colliding/);
});
test('case-colliding new saves are rejected before replacing an existing source', async () => {
    const memory = new MemoryAdapter('local', [{ name: 'People.vcf', text: source }]);
    await assert.rejects(memory.save({ filename: 'people.VCF', baseRevision: null, content: '', revision: sha256('') }), { code: 'CONFLICT' });
    const files = new FileAdapter([new File([source], 'People.vcf')]);
    await assert.rejects(files.save({ filename: 'people.VCF', baseRevision: null, content: '', revision: sha256('') }), { code: 'CONFLICT' });
});
test('local File adapter reads on demand and never mutates File objects', async () => {
    const file = new File([source], 'People.vcf');
    const a = new FileAdapter([file]);
    assert.equal(a.entries.size, 0);
    const read = await a.read('People.vcf');
    assert.equal(a.entries.size, 0);
    await a.save({ filename: file.name, baseRevision: read.revision, content: '', revision: sha256('') });
    assert.equal(await file.text(), source);
    assert.equal((await a.read(file.name)).text, '');
});
test('clearing the adapter releases file references', () => {
    const a = new FileAdapter([new File([source], 'People.vcf')]);
    a.clear();
    assert.equal(a.files.size, 0);
    assert.equal(a.entries.size, 0);
});
function mock(handler) {
    return new PHPAdapter('./', async (url, options) => handler(url, options));
}
function json(x, status = 200) {
    return new Response(JSON.stringify(x), { status, headers: { 'Content-Type': 'application/json' } });
}
test('PHP catalogue uses authenticated same-origin no-store reads', async () => {
    const a = mock((url, o) => {
        assert.equal(url, './scan.php');
        assert.equal(o.headers['X-Nexus-Token'], undefined);
        assert.equal(o.cache, 'no-store');
        assert.equal(o.credentials, 'same-origin');
        return json({ files: [{ name: 'People.vcf', bytes: source.length }] });
    });
    assert.equal((await a.catalogue()).length, 1);
    assert.equal(a.controllers.size, 0);
});
for (const [name, data] of [['array response', []], ['duplicate files', { files: [{ name: 'a.vcf', bytes: 0 }, { name: 'a.vcf', bytes: 0 }] }], ['negative size', { files: [{ name: 'a.vcf', bytes: -1 }] }], ['path escape', { files: [{ name: '../a.vcf', bytes: 1 }] }], ['partial catalogue', { files: [], truncated: true }]])
    test(`PHP catalogue rejects ${name}`, async () => {
        await assert.rejects(mock(() => json(data)).catalogue());
    });
test('PHP raw source derives its revision from delivered bytes despite a rewritten ETag', async () => {
    const a = mock(() => new Response(source, { headers: { ETag: '"rewritten-by-host"' } }));
    assert.equal((await a.read('People.vcf')).revision, sha256(source));
    assert.equal(a.controllers.size, 0);
});
test('PHP source filename is URL encoded', async () => {
    const a = mock(url => {
        assert.equal(url, './read.php?file=A%20%26%20B.vcf');
        return new Response('');
    });
    await a.read('A & B.vcf');
});
test('PHP 409 is a conflict, never a generic saved result', async () => {
    const { plan } = setup();
    const a = mock(() => json({ error: 'Stale' }, 409));
    a.csrf = 'a'.repeat(64);
    await assert.rejects(a.save(plan), { code: 'CONFLICT', status: 409 });
});
test('PHP response cannot invent a different saved revision', async () => {
    const { plan } = setup();
    const a = mock(() => json({ revision: sha256('other') }));
    a.csrf = 'a'.repeat(64);
    await assert.rejects(a.save(plan), { code: 'INTEGRITY' });
});
test('PHP write preserves endpoint action and extended revision contract', async () => {
    const { plan } = setup();
    const a = mock((url, o) => {
        assert.equal(url, './write.php');
        const b = JSON.parse(o.body);
        assert.equal(b.action, 'save');
        assert.equal(b.baseRevision, sha256(source));
        assert.equal(b.vcfContent, plan.content);
        assert.equal(o.headers['X-Nexus-CSRF'], 'a'.repeat(64));
        return json({ revision: plan.revision });
    });
    a.csrf = 'a'.repeat(64);
    await a.save(plan);
});
test('PHP session establishes CSRF and remote-user authority without a browser secret', async () => {
    const a = mock((url, o) => {
        assert.equal(url, './session.php');
        assert.equal(o.headers['X-Nexus-Token'], undefined);
        return json({ authenticated: true, csrf: 'b'.repeat(64), authMode: 'remote_user' });
    });
    const status = await a.login();
    assert.equal(status.authenticated, true);
    assert.equal(a.csrf, 'b'.repeat(64));
});
test('PHP password login sends the session CSRF token', async () => {
    let calls = 0;
    const a = mock((url, o) => {
        calls++;
        if (calls === 1) return json({ authenticated: false, csrf: 'c'.repeat(64), authMode: 'password' });
        assert.equal(url, './session.php?action=login');
        assert.equal(o.headers['X-Nexus-CSRF'], 'c'.repeat(64));
        assert.equal(JSON.parse(o.body).password, 'secret');
        return json({ authenticated: true, csrf: 'd'.repeat(64) });
    });
    await a.login('secret');
    assert.equal(a.csrf, 'd'.repeat(64));
});
test('PHP clear drops session authority and outstanding request handles', async () => {
    const a = mock(() => json({ files: [] }));
    await a.catalogue();
    a.csrf = 'a'.repeat(64);
    a.authenticated = true;
    a.clear();
    assert.equal(a.csrf, '');
    assert.equal(a.authenticated, false);
    assert.equal(a.controllers.size, 0);
    assert.equal(a.releases.size, 0);
});
test('literal compact telephone search finds spaced source number', () => {
    const core = new ContactEngine();
    core.open(fixtureLibraries()[0]);
    const result = core.handle('query', { query: '+447700900100', limit: 80 });
    assert.equal(result.total, 1);
    assert.equal(result.items[0].name, 'Amira Khan');
});
test('query cache retains full height and serves bounded windows', () => {
    const core = new ContactEngine();
    core.open(fixtureLibraries()[0]);
    const first = core.handle('query', { offset: 0, limit: 4 }), cache = core.queryCache;
    const next = core.handle('query', { offset: 4, limit: 4 });
    assert.equal(next.total, 30);
    assert.equal(next.items.length, 4);
    assert.equal(core.queryCache, cache);
    assert.notEqual(first.items[0].id, next.items[0].id);
});
test('exact source text accompanies evidence for independent hash verification', () => {
    const core = new ContactEngine();
    core.open({ text: source, name: 'People.vcf' });
    const e = JSON.parse(core.handle('export', { sourceId: 'People.vcf', format: 'evidence' }));
    assert.equal(sha256(e.source.text), e.source.sha256);
});
test('current source review sees shared details in other open libraries', () => {
    const core = new ContactEngine();
    for (const source of fixtureLibraries().slice(0, 2))
        core.open(source);
    const result = core.handle('query', { sourceId: 'Workshop.vcf', filter: 'review', limit: 80 });
    assert.equal(result.total, 1);
    assert.equal(result.items[0].name, 'Amira Khan');
});
test('focused row index follows the record after a sort-changing edit', () => {
    const { core, plan } = setup();
    core.open({ name: 'People.vcf', text: plan.content });
    const r = core.handle('query', { focusId: 'People.vcf:0', limit: 80 });
    assert.equal(r.focusIndex, 0);
});
test('an edit keeps an explicit no-UID bookmark trace', () => {
    const core = new ContactEngine(), text = 'BEGIN:VCARD\nVERSION:3.0\nFN:Before\nEND:VCARD\n';
    core.open({ name: 'A.vcf', text });
    const c = core.libraries.get('A.vcf').contacts[0];
    const plan = core.handle('plan', { sourceId: 'A.vcf', kind: 'edit', id: c.id, recordHash: c.hash, baseRevision: sha256(text), changes: { fn: 'After' } });
    assert.equal(plan.bookmarkChange.from, c.bookmark);
    assert.notEqual(plan.bookmarkChange.to, c.bookmark);
});
test('change planning preflights the total workspace byte budget', () => {
    const { core } = setup();
    core.libraries.set('Large', { id: 'Large', bytes: 64 * 1024 * 1024, contacts: [] });
    const c = core.libraries.get('People.vcf').contacts[0];
    assert.throws(() => core.handle('plan', { sourceId: 'People.vcf', kind: 'edit', id: c.id, recordHash: c.hash, baseRevision: sha256(source), changes: { org: 'New' } }), { code: 'SESSION_LIMIT' });
    assert.equal(core.libraries.get('People.vcf').text, source);
});
test('a source with 10,800 shared groups fits the declared workspace contract', () => {
    const { core } = setup();
    let text = '';
    for (let group = 0; group < 6; group++) {
        const phones = Array.from({ length: 1800 }, (_, i) => `TEL:+44${String(group * 1800 + i).padStart(10, '0')}`).join('\n');
        for (let n = 0; n < 2; n++)
            text += `BEGIN:VCARD\nVERSION:3.0\nFN:Shared ${group} ${n}\n${phones}\nEND:VCARD\n`;
    }
    const summary = core.open({ name: 'Shared.vcf', text });
    assert.equal(summary.sharedGroups, 10800);
    assert.equal(core.libraries.get('People.vcf').text, source);
    assert.ok(core.libraries.has('Shared.vcf'));
});
import { checkReceiptCapacity } from '../public/js/adapters.js';
test('receipt limit refuses a change before transport', () => {
    assert.throws(() => checkReceiptCapacity(Array(1000).fill({}), {}), { code: 'RECEIPT_LIMIT' });
});
test('receipt byte limit refuses an oversized import audit', () => {
    assert.throws(() => checkReceiptCapacity([], { data: 'a'.repeat(8 * 1024 * 1024) }), { code: 'RECEIPT_LIMIT' });
    checkReceiptCapacity([{ operation: 'edit' }], { operation: 'edit' });
});
