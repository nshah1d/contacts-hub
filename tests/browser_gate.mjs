import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { fixtureLibraries, largeLibrary } from '../tools/fixtures.mjs';
import { ROW_HEIGHT } from '../public/js/ui/virtual-list.js';

const toolsRoot = process.env.NEXUS_BROWSER_TOOLS;
const require = createRequire(import.meta.url);
const playwright = toolsRoot ? require(path.resolve(toolsRoot, 'node_modules/playwright')) : require('playwright');
const executablePath = process.env.NEXUS_CHROMIUM || undefined;
const sourceRoot = path.resolve(import.meta.dirname, '..');
const work = await mkdtemp(path.join(tmpdir(), 'nexus-browser-gate-'));
const site = path.join(work, 'site');
const privateRoot = path.join(work, 'private');
const sources = path.join(privateRoot, 'sources');
const backups = path.join(privateRoot, 'backups');
const locks = path.join(privateRoot, 'locks');
const sessions = path.join(privateRoot, 'sessions');
const errors = [];
let server;
let browser;
let passed = 0;
const check = (condition, message) => {
    assert.ok(condition, message);
    passed++;
};
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
            const response = await fetch(base + 'session.php');
            if (response.status)
                return;
        }
        catch {
        }
        await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error('PHP browser service did not start.');
}
try {
    await cp(path.join(sourceRoot, 'public'), site, { recursive: true });
    await cp(path.join(sourceRoot, 'server'), path.join(site, 'server'), { recursive: true });
    await mkdir(privateRoot);
    for (const directory of [sources, backups, locks, sessions])
        await mkdir(directory);
    for (const entry of fixtureLibraries())
        await writeFile(path.join(sources, entry.name), entry.text);
    await writeFile(path.join(sources, 'Large.vcf'), largeLibrary(5000));
    const config = `<?php
declare(strict_types=1);
return [
    'auth_mode' => 'remote_user',
    'password_hash' => '',
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
    await writeFile(path.join(site, 'server', 'config.php'), config);
    const router = path.join(work, 'router.php');
    await writeFile(router, "<?php $_SERVER['REMOTE_USER']='browser-gate'; return false;\n");
    const port = await freePort();
    const origin = `http://127.0.0.1:${port}/`;
    server = spawn('php', ['-S', `127.0.0.1:${port}`, '-t', site, router], { cwd: work, stdio: ['ignore', 'pipe', 'pipe'] });
    await waitForServer(origin);
    browser = await playwright.chromium.launch({ headless: true, executablePath, args: ['--no-sandbox'] });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(String(error)));
    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Open People.vcf', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Open People.vcf', exact: true }).click();
    await page.waitForFunction(() => document.getElementById('list-context')?.textContent === 'People');
    await page.getByRole('heading', { name: 'Amira Khan', exact: true }).waitFor();
    const peopleCount = await page.locator('#result-count').innerText();
    check(peopleCount === '30 contacts', 'People library count is wrong: ' + peopleCount);
    check(await page.locator('.contact-row').count() <= 80, 'The contact list exceeded its mounted row budget.');
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Desktop layout overflows horizontally.');
    check(errors.length === 0, 'The production module path raised a page error.');
    const shell = await page.evaluate(async () => {
        await document.fonts.ready;
        const root = getComputedStyle(document.documentElement), style = selector => getComputedStyle(document.querySelector(selector));
        const panes = ['.pane-libraries', '.pane-list', '.pane-detail'].map(selector => document.querySelector(selector).getBoundingClientRect());
        return {
            palette: ['--os-bg', '--os-header', '--os-panel', '--os-active', '--os-accent'].map(name => root.getPropertyValue(name).trim()),
            panes: panes.map(r => Math.round(r.width)), aligned: panes.every(r => r.top === 0) && panes[0].right <= panes[1].left + 1 && panes[1].right <= panes[2].left + 1,
            headers: [...document.querySelectorAll('.pane-header')].filter(node => node.getBoundingClientRect().height === 64).length,
            index: document.querySelector('.pane-libraries .header-content > span').textContent, indexCase: style('.header-content').textTransform,
            badge: style('.server-badge').fontFamily, body: style('body').fontFamily,
            inter: document.fonts.check('600 14px Inter'), mono: document.fonts.check('10px "JetBrains Mono"'),
            searchIcon: !!document.querySelector('.search-inner .search-icon svg'), gutter: document.querySelector('.alpha-gutter').getBoundingClientRect().width,
            fuzzy: !!document.getElementById('fuzzy'), topbar: !!document.querySelector('.topbar'),
        };
    });
    check(JSON.stringify(shell.palette) === JSON.stringify(['#1a1b26', '#16161e', '#1f2335', '#2a2f41', '#7aa2f7']), 'The Tokyo Night palette changed: ' + shell.palette);
    check(shell.panes[0] === 280 && shell.panes[1] === 360 && shell.panes[2] > 600 && shell.aligned, 'The three original panes are not side by side at 280, 360 and the remainder: ' + shell.panes);
    check(shell.headers === 2 && shell.index === 'Server Index' && shell.indexCase === 'uppercase', 'The 64px Server Index pane headers are missing.');
    check(shell.badge.startsWith('"JetBrains Mono"') && shell.body.startsWith('Inter') && shell.inter && shell.mono, 'The original Inter and JetBrains Mono type did not load.');
    check(shell.searchIcon && shell.gutter === 26, 'The search icon or alphabet gutter is missing.');
    check(!shell.fuzzy && !shell.topbar, 'A retired control or top bar is present.');
    await page.getByRole('searchbox', { name: 'Search contacts' }).fill('+447700900100');
    await page.waitForFunction(() => document.getElementById('result-count')?.textContent === '1 contact found');
    check(await page.getByRole('heading', { name: 'Amira Khan', exact: true }).isVisible(), 'Complete search did not find the formatted phone.');
    await page.getByRole('searchbox', { name: 'Search contacts' }).fill('');
    await page.waitForFunction(() => document.getElementById('result-count')?.textContent === '30 contacts');
    await page.getByRole('button', { name: 'Source', exact: true }).click();
    const sourceCopy = await page.locator('#modal').innerText();
    check(!sourceCopy.includes('SHA-256') && !/[a-f0-9]{64}/.test(sourceCopy), 'The interface exposes full internal hashes.');
    check(sourceCopy.includes('X-TEST-REFERENCE:NL-204'), 'The source inspector lost an opaque property.');
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await page.getByLabel('Full name', { exact: true }).fill('Amira Khan Updated');
    await page.getByRole('button', { name: 'Review changes', exact: true }).click();
    check(await page.getByRole('heading', { name: 'Amira Khan', exact: true }).isVisible(), 'A staged edit changed the committed profile.');
    await page.getByRole('button', { name: 'Save to server', exact: true }).click();
    await page.getByRole('heading', { name: 'Amira Khan Updated', exact: true }).waitFor();
    check((await readFile(path.join(sources, 'People.vcf'), 'utf8')).includes('FN:Amira Khan Updated'), 'The native browser save did not reach the private source.');
    check((await readdir(backups)).length === 1, 'The native browser save did not retain a backup.');
    await page.getByRole('button', { name: 'Source', exact: true }).click();
    check((await page.locator('#modal').innerText()).includes('X-TEST-REFERENCE:NL-204'), 'An ordinary browser edit destroyed an opaque property.');
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    await page.getByRole('button', { name: 'Copy details', exact: true }).click();
    await page.getByText('Contact details copied.', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Open Workshop.vcf', exact: true }).click();
    await page.getByRole('heading', { name: 'Ada Ellis', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Open People.vcf', exact: true }).click();
    await page.getByRole('button', { name: 'Shared details', exact: true }).click();
    await page.waitForFunction(() => document.getElementById('result-count')?.textContent.includes('contacts'));
    check(Number((await page.locator('#result-count').innerText()).split(' ')[0]) >= 3, 'Cross-library shared-detail review did not include open sources.');
    await page.getByRole('button', { name: 'Open Event sign-ups.csv', exact: true }).click();
    await page.getByRole('heading', { name: 'Amira Khan', exact: true }).waitFor();
    check(await page.getByRole('button', { name: 'Edit', exact: true }).isDisabled(), 'CSV source became directly editable.');
    await page.getByRole('button', { name: 'Source details', exact: true }).click();
    await page.getByRole('button', { name: 'Create editable copy', exact: true }).click();
    await page.getByRole('button', { name: 'Review conversion', exact: true }).click();
    await page.getByRole('button', { name: 'Save to server', exact: true }).click();
    await page.getByRole('button', { name: 'Open Event sign-ups-editable.vcf', exact: true }).waitFor();
    check(await readFile(path.join(sources, 'Event sign-ups.csv'), 'utf8') === fixtureLibraries()[2].text, 'CSV conversion changed the original source.');
    await page.getByRole('button', { name: 'Open Large.vcf', exact: true }).click();
    await page.getByRole('heading', { name: 'Contact 000000', exact: true }).waitFor();
    check(await page.locator('#list-spacer').evaluate(node => node.offsetHeight) === 5000 * ROW_HEIGHT, 'Large list scrollbar extent is incomplete.');
    await page.locator('#contact-list').focus();
    await page.keyboard.press('End');
    await page.getByRole('heading', { name: 'Contact 004999', exact: true }).waitFor();
    check(await page.locator('.contact-row').count() <= 80, 'Large-list scrolling mounted too many contacts.');
    await page.getByRole('searchbox', { name: 'Search contacts' }).fill('Contact 003210');
    await page.getByRole('heading', { name: 'Contact 003210', exact: true }).waitFor();
    check(await page.locator('#result-count').innerText() === '1 contact found', 'Search did not reach an unmounted large-list contact.');
    await mkdir(path.join(sourceRoot, '.test-build'), { recursive: true });
    await page.screenshot({ path: path.join(sourceRoot, '.test-build', 'nexus-desktop.png'), fullPage: true });
    await page.getByRole('searchbox', { name: 'Search contacts' }).fill('');
    await page.waitForFunction(() => document.querySelectorAll('.contact-row').length > 1);
    await page.getByRole('button', { name: 'Switch theme', exact: true }).click();
    await page.waitForTimeout(400);
    const light = await page.evaluate(() => {
        const text = element => getComputedStyle(element).color;
        const unselected = [...document.querySelectorAll('.contact-row')].find(row => row.getAttribute('aria-selected') !== 'true');
        return { theme: document.documentElement.dataset.theme, name: text(unselected.querySelector('strong')),
            view: text(document.querySelector('.smart-item:not(.active) span')), heading: text(document.querySelector('.contact-hero h2')) };
    });
    check(light.theme === 'light' && light.name === 'rgb(52, 59, 88)' && light.view === 'rgb(52, 59, 88)' && light.heading === 'rgb(26, 27, 38)', 'Light theme text is not neutral: ' + JSON.stringify(light));
    await page.screenshot({ path: path.join(sourceRoot, '.test-build', 'nexus-desktop-light.png'), fullPage: true });
    await page.getByRole('button', { name: 'Switch theme', exact: true }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(100);
    check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Mobile layout overflows horizontally.');
    await page.getByRole('option').first().click();
    await page.getByRole('button', { name: 'Back to contacts', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Back to contacts', exact: true }).click();
    check(await page.locator('.list-pane').isVisible(), 'Mobile back navigation did not return to the list.');
    await page.screenshot({ path: path.join(sourceRoot, '.test-build', 'nexus-mobile.png'), fullPage: true });
    check(errors.length === 0, 'The native browser run produced uncaught page errors.');
    await context.close();
    console.log(JSON.stringify({ passed, pageErrors: errors, screenshots: ['.test-build/nexus-desktop.png', '.test-build/nexus-desktop-light.png', '.test-build/nexus-mobile.png'] }, null, 2));
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
