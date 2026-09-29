import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { largeLibrary } from '../tools/fixtures.mjs';
import { ROW_HEIGHT } from '../public/js/ui/virtual-list.js';

const toolsRoot = process.env.NEXUS_BROWSER_TOOLS;
const require = createRequire(import.meta.url);
const playwright = toolsRoot ? require(path.resolve(toolsRoot, 'node_modules/playwright')) : require('playwright');
const executablePath = process.env.NEXUS_CHROMIUM || undefined;
const sourceRoot = path.resolve(import.meta.dirname, '..');
const work = await mkdtemp(path.join(tmpdir(), 'nexus-performance-gate-'));
const site = path.join(work, 'site');
const privateRoot = path.join(work, 'private');
const errors = [];
let browser;
let server;
const phpString = value => "'" + String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
async function freePort() {
    const listener = net.createServer();
    listener.listen(0, '127.0.0.1');
    await once(listener, 'listening');
    const value = listener.address().port;
    await new Promise(resolve => listener.close(resolve));
    return value;
}
async function waitForServer(base) {
    for (let i = 0; i < 100; i++) {
        try {
            if ((await fetch(base)).status)
                return;
        }
        catch {
        }
        await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error('Performance server did not start.');
}
async function measure(context, origin, files, expected, query, expectedMatches) {
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(String(error)));
    const cdp = await context.newCDPSession(page);
    await cdp.send('Performance.enable');
    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    const before = performance.now();
    await page.locator('#file-input').setInputFiles(files);
    await page.waitForFunction(total => document.getElementById('result-count')?.textContent.startsWith(total.toLocaleString('en-GB')), expected, { timeout: 120000 });
    const loadMs = performance.now() - before;
    const mounted = await page.locator('.contact-row').count();
    const extent = await page.locator('#list-spacer').evaluate(node => node.offsetHeight);
    const searchStart = performance.now();
    await page.getByRole('searchbox', { name: 'Search contacts' }).fill(query);
    await page.waitForFunction(total => document.getElementById('result-count')?.textContent.startsWith(total.toLocaleString('en-GB')), expectedMatches, { timeout: 30000 });
    const searchMs = performance.now() - searchStart;
    const dom = await cdp.send('Memory.getDOMCounters');
    const metrics = await cdp.send('Performance.getMetrics');
    const metric = name => metrics.metrics.find(entry => entry.name === name)?.value || 0;
    assert.ok(mounted <= 80);
    assert.equal(extent, expected * ROW_HEIGHT);
    assert.ok(dom.nodes < 5000);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.close();
    return { contacts: expected, loadMs, searchMs, mountedRows: mounted, domNodes: dom.nodes, jsHeapUsedMiB: metric('JSHeapUsedSize') / 1048576 };
}
try {
    await cp(path.join(sourceRoot, 'public'), site, { recursive: true });
    await cp(path.join(sourceRoot, 'server'), path.join(site, 'server'), { recursive: true });
    await mkdir(privateRoot);
    for (const directory of ['sources', 'backups', 'locks', 'sessions'])
        await mkdir(path.join(privateRoot, directory));
    await writeFile(path.join(site, 'server', 'config.php'), `<?php
declare(strict_types=1);
return [
    'auth_mode' => 'remote_user',
    'password_hash' => '',
    'app_key' => ${phpString(randomBytes(32).toString('hex'))},
    'secure_cookie' => false,
    'idle_seconds' => 3600,
    'absolute_seconds' => 43200,
    'contacts_root' => ${phpString(path.join(privateRoot, 'sources'))},
    'backups_root' => ${phpString(path.join(privateRoot, 'backups'))},
    'locks_root' => ${phpString(path.join(privateRoot, 'locks'))},
    'sessions_root' => ${phpString(path.join(privateRoot, 'sessions'))},
    'max_source_bytes' => 20971520,
    'max_request_bytes' => 67108864,
    'max_libraries' => 2000,
    'max_contacts' => 50000,
    'max_backup_bytes' => 1073741824,
    'max_backup_files' => 10000,
    'lock_timeout_seconds' => 2,
];
`);
    const router = path.join(work, 'router.php');
    await writeFile(router, "<?php $_SERVER['REMOTE_USER']='performance-gate'; return false;\n");
    const port = await freePort();
    const origin = `http://127.0.0.1:${port}/`;
    server = spawn('php', ['-S', `127.0.0.1:${port}`, '-t', site, router], { cwd: work, stdio: ['ignore', 'pipe', 'pipe'] });
    await waitForServer(origin);
    browser = await playwright.chromium.launch({ headless: true, executablePath, args: ['--no-sandbox'] });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const ten = largeLibrary(10000);
    const fifty = largeLibrary(50000);
    const results = [];
    results.push(await measure(context, origin, [{ name: 'Ten.vcf', mimeType: 'text/vcard', buffer: Buffer.from(ten) }], 10000, 'Contact 009999', 1));
    results.push(await measure(context, origin, [{ name: 'Fifty.vcf', mimeType: 'text/vcard', buffer: Buffer.from(fifty) }], 50000, 'Contact 049999', 1));
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(String(error)));
    const cdp = await context.newCDPSession(page);
    await cdp.send('Performance.enable');
    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    const before = performance.now();
    await page.locator('#file-input').setInputFiles([
        { name: 'Fifty-A.vcf', mimeType: 'text/vcard', buffer: Buffer.from(fifty) },
        { name: 'Fifty-B.vcf', mimeType: 'text/vcard', buffer: Buffer.from(fifty) },
    ]);
    await page.waitForFunction(() => document.getElementById('result-count')?.textContent.startsWith('50,000'), null, { timeout: 120000 });
    await page.getByRole('button', { name: 'Open Fifty-B.vcf', exact: true }).click();
    await page.waitForFunction(() => document.getElementById('list-context')?.textContent === 'Fifty-B', null, { timeout: 120000 });
    await page.getByRole('button', { name: 'Workspace settings', exact: true }).click();
    await page.getByRole('button', { name: 'All open libraries', exact: true }).click();
    await page.waitForFunction(() => document.getElementById('result-count')?.textContent.startsWith('100,000'), null, { timeout: 120000 });
    const loadMs = performance.now() - before;
    assert.equal(await page.locator('#list-spacer').evaluate(node => node.offsetHeight), 100000 * ROW_HEIGHT);
    const searchStart = performance.now();
    await page.getByRole('searchbox', { name: 'Search contacts' }).fill('Contact 049999');
    await page.waitForFunction(() => document.getElementById('result-count')?.textContent.startsWith('2 contacts'), null, { timeout: 30000 });
    const searchMs = performance.now() - searchStart;
    const dom = await cdp.send('Memory.getDOMCounters');
    const metrics = await cdp.send('Performance.getMetrics');
    const heap = metrics.metrics.find(entry => entry.name === 'JSHeapUsedSize')?.value || 0;
    const mounted = await page.locator('.contact-row').count();
    assert.ok(mounted <= 80);
    assert.equal(await page.locator('#list-spacer').evaluate(node => node.offsetHeight), 2 * ROW_HEIGHT);
    assert.ok(dom.nodes < 5000);
    results.push({ contacts: 100000, loadMs, searchMs, mountedRows: mounted, domNodes: dom.nodes, jsHeapUsedMiB: heap / 1048576 });
    await page.close();
    assert.deepEqual(errors, []);
    await context.close();
    console.log(JSON.stringify({ passed: 3, results, pageErrors: errors }, null, 2));
}
finally {
    if (browser)
        await browser.close();
    if (server) {
        server.kill('SIGTERM');
        await once(server, 'exit');
    }
    await rm(work, { recursive: true, force: true });
}
