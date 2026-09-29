import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { fixtureLibraries } from '../tools/fixtures.mjs';
import { parseLibrary, exportEvidence } from '../public/js/core/engine.js';
const root = fileURLToPath(new URL('../', import.meta.url));
async function fixture(fn) {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'nexus-test-'));
    try {
        await fn(dir);
    }
    finally {
        await rm(dir, { recursive: true, force: true });
    }
}
function run(args) {
    return spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', timeout: 10000 });
}
test('CLI default output contains counts without contact values', async () => fixture(async (dir) => {
    const file = path.join(dir, 'People.vcf');
    await writeFile(file, fixtureLibraries()[0].text);
    const r = run(['tools/nexus.mjs', file]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).records, 30);
    assert.ok(!r.stdout.includes('Amira'));
}));
test('CLI content export requires explicit acknowledgement', async () => fixture(async (dir) => {
    const file = path.join(dir, 'People.vcf');
    await writeFile(file, fixtureLibraries()[0].text);
    const r = run(['tools/nexus.mjs', file, '--format', 'evidence', '--output', path.join(dir, 'e.json')]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /include-content/);
}));
test('CLI refuses to overwrite an output', async () => fixture(async (dir) => {
    const file = path.join(dir, 'People.vcf'), output = path.join(dir, 'e.json');
    await writeFile(file, fixtureLibraries()[0].text);
    await writeFile(output, 'keep');
    const r = run(['tools/nexus.mjs', file, '--format', 'evidence', '--output', output, '--include-content']);
    assert.equal(r.status, 1);
    assert.equal(await readFile(output, 'utf8'), 'keep');
}));
test('CLI refuses symlink input', async () => fixture(async (dir) => {
    const file = path.join(dir, 'People.vcf'), link = path.join(dir, 'Linked.vcf');
    await writeFile(file, fixtureLibraries()[0].text);
    await symlink(file, link);
    assert.equal(run(['tools/nexus.mjs', link]).status, 1);
}));
test('relational verifier rejects altered normalised values even with valid raw hashes', async () => fixture(async (dir) => {
    const source = fixtureLibraries()[0], lib = parseLibrary(source.text, source.name), e = JSON.parse(exportEvidence(lib));
    e.contacts[0].fields.fn = 'Forged';
    const file = path.join(dir, 'e.json');
    await writeFile(file, JSON.stringify(e));
    const r = run(['tools/relational.mjs', file]);
    assert.equal(r.status, 1);
    assert.equal(r.stdout, '');
}));
test('SQLite snapshot has consistent source, records and shared-detail membership', async () => fixture(async (dir) => {
    const source = fixtureLibraries()[0], e = path.join(dir, 'e.json'), db = path.join(dir, 'n.sqlite');
    await writeFile(e, exportEvidence(parseLibrary(source.text, source.name)));
    const r = spawnSync('python', ['tools/sqlite.py', e, db], { cwd: root, encoding: 'utf8', timeout: 15000 });
    assert.equal(r.status, 0, r.stderr);
    const query = spawnSync('python', ['-c', "import sqlite3,sys,json;c=sqlite3.connect(sys.argv[1]);print(json.dumps([c.execute('select count(*) from contacts').fetchone()[0],c.execute('select count(*) from shared_groups').fetchone()[0],c.execute('select count(*) from shared_members').fetchone()[0],c.execute('pragma integrity_check').fetchone()[0]]))", db], { encoding: 'utf8' });
    assert.deepEqual(JSON.parse(query.stdout), [30, 1, 3, 'ok']);
    const again = spawnSync('python', ['tools/sqlite.py', e, db], { cwd: root, encoding: 'utf8' });
    assert.equal(again.status, 1);
    assert.match(again.stderr, /already exists/);
}));
test('CSV custom interpretation travels into relational verification', async () => fixture(async (dir) => {
    const lib = parseLibrary('person;mail\nA;a@example.com\n', 'Custom.csv', 'Custom.csv', { delimiter: ';', mapping: { fn: 0, email: 1 } }), e = path.join(dir, 'e.json');
    await writeFile(e, exportEvidence(lib));
    const r = run(['tools/relational.mjs', e]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).contacts[0].name, 'A');
}));
