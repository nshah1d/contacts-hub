import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, cp, symlink, chmod } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';

const sourceRoot = path.resolve(import.meta.dirname, '..');
const work = await mkdtemp(path.join(tmpdir(), 'nexus-php-gate-'));
const runtime = path.join(work, 'runtime');
const sources = path.join(runtime, 'sources');
const backups = path.join(runtime, 'backups');
const locks = path.join(runtime, 'locks');
const sessions = path.join(runtime, 'sessions');
let server;
let passed = 0;
const check = (condition, message) => {
    if (!condition)
        throw new Error(message);
    passed++;
};
const phpString = value => "'" + String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
async function port() {
    const listener = net.createServer();
    await new Promise((resolve, reject) => listener.once('error', reject).listen(0, '127.0.0.1', resolve));
    const value = listener.address().port;
    await new Promise(resolve => listener.close(resolve));
    return value;
}
async function start(router = null) {
    const chosen = await port();
    const args = ['-S', `127.0.0.1:${chosen}`, '-t', path.join(runtime, 'public')];
    if (router)
        args.push(router);
    server = spawn('php', args, { cwd: runtime, stdio: ['ignore', 'pipe', 'pipe'] });
    let error = '';
    server.stderr.on('data', chunk => {
        error += chunk;
    });
    const base = `http://127.0.0.1:${chosen}/`;
    for (let i = 0; i < 100; i++) {
        try {
            const response = await fetch(base + 'session.php');
            if (response.status)
                return { base, error: () => error };
        }
        catch {
        }
        await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error('PHP server did not start. ' + error);
}
async function stop() {
    if (!server)
        return;
    server.kill('SIGTERM');
    await new Promise(resolve => server.once('exit', resolve));
    server = null;
}
function client(base) {
    let cookie = '';
    return async (route, options = {}) => {
        const headers = new Headers(options.headers || {});
        if (cookie)
            headers.set('Cookie', cookie);
        const response = await fetch(base + route, { ...options, headers, redirect: 'manual' });
        const setCookie = response.headers.get('set-cookie');
        if (setCookie)
            cookie = setCookie.split(';')[0];
        return response;
    };
}
async function json(response) {
    const text = await response.text();
    try {
        return JSON.parse(text);
    }
    catch {
        throw new Error(`Expected JSON from ${response.url}: ${response.status} ${text.slice(0, 200)}`);
    }
}
function config(mode, passwordHash) {
    return `<?php
declare(strict_types=1);
return [
    'auth_mode' => ${phpString(mode)},
    'password_hash' => ${phpString(passwordHash)},
    'app_key' => ${phpString(randomBytes(32).toString('hex'))},
    'secure_cookie' => false,
    'idle_seconds' => 3600,
    'absolute_seconds' => 43200,
    'contacts_root' => ${phpString(sources)},
    'backups_root' => ${phpString(backups)},
    'locks_root' => ${phpString(locks)},
    'sessions_root' => ${phpString(sessions)},
    'max_source_bytes' => 20971520,
    'max_request_bytes' => 67108864,
    'max_libraries' => 2000,
    'max_contacts' => 50000,
    'max_backup_bytes' => 1073741824,
    'max_backup_files' => 10000,
    'lock_timeout_seconds' => 2,
];
`;
}
const initial = 'BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Before\r\nX-PRIVATE:retain\r\nEND:VCARD\r\n';
const updated = initial.replace('FN:Before', 'FN:After');
try {
    await mkdir(runtime);
    await cp(path.join(sourceRoot, 'public'), path.join(runtime, 'public'), { recursive: true });
    await cp(path.join(sourceRoot, 'server'), path.join(runtime, 'server'), { recursive: true });
    for (const directory of [sources, backups, locks, sessions]) {
        await mkdir(directory);
        await chmod(directory, 0o700);
    }
    await writeFile(path.join(sources, 'People.vcf'), initial, { mode: 0o600 });
    await writeFile(path.join(sources, 'List.csv'), 'Name,Email\nOne,one@example.com\n', { mode: 0o600 });
    await writeFile(path.join(sources, 'Case.vcf'), initial, { mode: 0o600 });
    await writeFile(path.join(sources, '.hidden.vcf'), initial, { mode: 0o600 });
    await symlink(path.join(sources, 'People.vcf'), path.join(sources, 'linked.vcf'));
    const hash = spawnSync('php', ['-r', "echo password_hash('correct horse', PASSWORD_DEFAULT);"], { encoding: 'utf8' });
    check(hash.status === 0 && hash.stdout.length > 20, 'Password hash generation failed.');
    const nested = path.join(locks, 'nested-sessions');
    await mkdir(nested);
    await writeFile(path.join(runtime, 'server', 'config.php'), config('password', hash.stdout).replace(phpString(sessions), phpString(nested)), { mode: 0o600 });
    let started = await start();
    let response = await fetch(started.base + 'session.php');
    check(response.status === 503, 'Nested private roots were accepted.');
    await stop();
    await writeFile(path.join(runtime, 'server', 'config.php'), config('password', hash.stdout), { mode: 0o600 });
    started = await start();
    let request = client(started.base);
    response = await request('session.php');
    let status = await json(response);
    check(response.status === 200 && status.authenticated === false && /^[a-f0-9]{64}$/.test(status.csrf), 'Initial session status failed.');
    response = await request('scan.php');
    check(response.status === 401, 'Unauthenticated catalogue was accepted.');
    response = await request('session.php?action=login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'correct horse' }) });
    check(response.status === 403, 'Login without CSRF was accepted.');
    response = await request('session.php?action=login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Nexus-CSRF': status.csrf }, body: JSON.stringify({ password: 'wrong' }) });
    check(response.status === 401, 'Wrong password was accepted.');
    response = await request('session.php?action=login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Nexus-CSRF': status.csrf }, body: JSON.stringify({ password: 'correct horse' }) });
    status = await json(response);
    check(response.status === 200 && status.authenticated === true && /^[a-f0-9]{64}$/.test(status.csrf), 'Password login failed.');
    response = await request('scan.php');
    let catalogue = await json(response);
    check(response.status === 200 && catalogue.files.length === 3 && catalogue.ignored === 2, 'Catalogue did not include only supported regular sources: ' + JSON.stringify(catalogue));
    response = await request('People.vcf');
    const direct = await response.text();
    check(direct !== initial && !direct.includes('BEGIN:VCARD'), 'A source was served from the public root.');
    response = await request('read.php?file=People.vcf');
    const original = await response.text();
    const revision = createHash('sha256').update(original).digest('hex');
    check(response.status === 200 && original === initial && /^[a-f0-9]{64}$/.test(revision || ''), 'Guarded source read failed.');
    const save = { action: 'save', filename: 'People.vcf', baseRevision: revision, vcfContent: updated };
    response = await request('write.php', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(save) });
    check(response.status === 403, 'Write without CSRF was accepted.');
    response = await request('write.php', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Nexus-CSRF': status.csrf, Origin: 'https://wrong.example', 'Sec-Fetch-Site': 'cross-site' }, body: JSON.stringify(save) });
    check(response.status === 403, 'Cross-site write was accepted.');
    response = await request('write.php', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Nexus-CSRF': status.csrf, Origin: started.base.slice(0, -1), 'Sec-Fetch-Site': 'same-origin' }, body: JSON.stringify(save) });
    const saved = await json(response);
    check(response.status === 200 && saved.unchanged === false && /^[a-f0-9]{64}$/.test(saved.revision), 'Revision-checked write failed.');
    check(await readFile(path.join(sources, 'People.vcf'), 'utf8') === updated, 'Published source differs from the proposed bytes.');
    const backupFiles = await readdir(backups);
    check(backupFiles.length === 1 && await readFile(path.join(backups, backupFiles[0]), 'utf8') === initial, 'Exact prior source backup was not retained.');
    response = await request('write.php', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Nexus-CSRF': status.csrf }, body: JSON.stringify(save) });
    check(response.status === 409, 'A stale revision was accepted.');
    response = await request('write.php', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Nexus-CSRF': status.csrf }, body: JSON.stringify({ action: 'save', filename: 'case.vcf', baseRevision: null, vcfContent: '' }) });
    check(response.status === 409, 'A case-colliding filename was accepted.');
    response = await request('write.php', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Nexus-CSRF': status.csrf }, body: JSON.stringify({ action: 'save', filename: 'Empty.vcf', baseRevision: null, vcfContent: '' }) });
    const empty = await json(response);
    check(response.status === 200 && empty.unchanged === false && await readFile(path.join(sources, 'Empty.vcf'), 'utf8') === '', 'Empty library creation failed.');
    response = await request('session.php?action=logout', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Nexus-CSRF': status.csrf }, body: '{}' });
    check(response.status === 200, 'Logout failed.');
    response = await request('scan.php');
    check(response.status === 401, 'Logout retained password authority.');
    await stop();
    await writeFile(path.join(runtime, 'server', 'config.php'), config('remote_user', ''), { mode: 0o600 });
    const router = path.join(runtime, 'router.php');
    await writeFile(router, "<?php $_SERVER['REMOTE_USER']='tester'; return false;\n");
    started = await start(router);
    request = client(started.base);
    response = await request('session.php');
    status = await json(response);
    check(response.status === 200 && status.authenticated === true && status.authMode === 'remote_user', 'Remote-user authority failed.');
    response = await request('scan.php');
    catalogue = await json(response);
    check(response.status === 200 && catalogue.files.some(file => file.name === 'People.vcf'), 'Remote-user catalogue failed.');
    await stop();

    // Hosted layout: the application is flattened into the site root and the libraries live beside it.
    const site = path.join(work, 'site'), hosted = path.join(work, 'hosted');
    await cp(path.join(sourceRoot, 'public'), site, { recursive: true });
    await cp(path.join(sourceRoot, 'server'), path.join(site, 'server'), { recursive: true });
    for (const directory of ['backups', 'locks', 'sessions'])
        await mkdir(path.join(hosted, directory), { recursive: true, mode: 0o700 });
    await writeFile(path.join(site, 'Family.vcf'), initial, { mode: 0o644 });
    await writeFile(path.join(site, 'Export.csv'), 'Name,Email\nOne,one@example.com\n', { mode: 0o644 });
    const hostedConfig = (backupsRoot = path.join(hosted, 'backups')) => config('remote_user', '').replace(phpString(sources), phpString(site))
        .replace(phpString(backups), phpString(backupsRoot)).replace(phpString(locks), phpString(path.join(hosted, 'locks'))).replace(phpString(sessions), phpString(path.join(hosted, 'sessions')));
    const hostedRouter = path.join(work, 'hosted-router.php');
    await writeFile(hostedRouter, "<?php $_SERVER['REMOTE_USER']='tester'; return false;\n");
    const startHosted = async () => {
        const chosen = await port();
        server = spawn('php', ['-S', `127.0.0.1:${chosen}`, '-t', site, hostedRouter], { cwd: work, stdio: ['ignore', 'pipe', 'pipe'] });
        const base = `http://127.0.0.1:${chosen}/`;
        for (let i = 0; i < 100; i++) {
            try {
                if ((await fetch(base + 'session.php')).status)
                    return base;
            }
            catch {
            }
            await new Promise(resolve => setTimeout(resolve, 25));
        }
        throw new Error('Hosted PHP server did not start.');
    };
    await mkdir(path.join(site, 'exposed-backups'));
    await writeFile(path.join(site, 'server', 'config.php'), hostedConfig(path.join(site, 'exposed-backups')), { mode: 0o600 });
    let hostedBase = await startHosted();
    check((await fetch(hostedBase + 'session.php')).status === 503, 'A backup directory inside the site root was accepted.');
    await stop();
    await writeFile(path.join(site, 'server', 'config.php'), hostedConfig(), { mode: 0o600 });
    hostedBase = await startHosted();
    request = client(hostedBase);
    status = await json(await request('session.php'));
    response = await request('scan.php');
    catalogue = await json(response);
    check(response.status === 200 && JSON.stringify(catalogue.files.map(file => file.name)) === JSON.stringify(['Export.csv', 'Family.vcf']), 'Site-root catalogue did not list exactly the libraries: ' + JSON.stringify(catalogue.files));
    response = await request('read.php?file=Family.vcf');
    const hostedOriginal = await response.text();
    check(response.status === 200 && hostedOriginal === initial, 'Site-root library read failed.');
    response = await request('write.php', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Nexus-CSRF': status.csrf, Origin: hostedBase.slice(0, -1), 'Sec-Fetch-Site': 'same-origin' },
        body: JSON.stringify({ action: 'save', filename: 'Family.vcf', baseRevision: createHash('sha256').update(hostedOriginal).digest('hex'), vcfContent: updated }) });
    check(response.status === 200 && await readFile(path.join(site, 'Family.vcf'), 'utf8') === updated, 'Site-root library write failed.');
    const hostedBackups = await readdir(path.join(hosted, 'backups'));
    check(hostedBackups.length === 1 && await readFile(path.join(hosted, 'backups', hostedBackups[0]), 'utf8') === initial, 'Site-root write did not back up privately.');
    check(!(await readdir(site)).some(name => name.endsWith('.tmp')), 'A temporary write file was left in the site root.');
    response = await request('write.php', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Nexus-CSRF': status.csrf, Origin: hostedBase.slice(0, -1), 'Sec-Fetch-Site': 'same-origin' },
        body: JSON.stringify({ action: 'save', filename: 'index.php', baseRevision: null, vcfContent: '' }) });
    check(response.status === 400, 'A non-library filename was accepted in the site root.');
    await stop();
    console.log(JSON.stringify({ passed, php: true, sources: catalogue.files.length }, null, 2));
}
finally {
    await stop();
    await rm(work, { recursive: true, force: true });
}
