import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const checks = [];
const check = (name, value) => {
    if (!value)
        throw new Error(name);
    checks.push(name);
};
async function filesBelow(directory) {
    const result = [];
    async function walk(current) {
        for (const entry of await fs.readdir(current, { withFileTypes: true })) {
            const full = path.join(current, entry.name);
            if (entry.isSymbolicLink())
                throw new Error('Symbolic link in checked source: ' + path.relative(root, full));
            if (entry.isDirectory())
                await walk(full);
            else if (entry.isFile())
                result.push(full);
        }
    }
    await walk(directory);
    return result;
}
async function absent(relative) {
    try {
        await fs.lstat(path.join(root, relative));
        return false;
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return true;
        throw error;
    }
}
try {
    const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
    check('Package is private', pkg.private === true);
    check('No runtime dependencies', Object.keys(pkg.dependencies || {}).length === 0);
    const scriptFiles = [];
    for (const directory of ['public/js', 'tools', 'tests'])
        for (const file of await filesBelow(path.join(root, directory)))
            if (/\.(?:js|mjs)$/.test(file))
                scriptFiles.push(file);
    for (const file of scriptFiles) {
        const relative = path.relative(root, file);
        const syntax = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
        check('JavaScript syntax: ' + relative, syntax.status === 0);
        const text = await fs.readFile(file, 'utf8');
        for (const match of text.matchAll(/(?:from\s*|import\s*)['"](\.[^'"]+)['"]/g)) {
            const target = path.resolve(path.dirname(file), match[1]);
            check('Local import: ' + relative + ' ' + match[1], (await fs.stat(target)).isFile());
        }
    }
    const phpFiles = ['public/bootstrap.php', 'public/session.php', 'public/scan.php', 'public/read.php', 'public/write.php', 'server/common.php', 'server/config.example.php'];
    const php = spawnSync('php', ['-v'], { encoding: 'utf8' });
    if (php.status === 0)
        for (const relative of phpFiles) {
            const lint = spawnSync('php', ['-l', path.join(root, relative)], { encoding: 'utf8' });
            check('PHP syntax: ' + relative, lint.status === 0);
        }
    for (const relative of phpFiles)
        check('Required PHP file: ' + relative, (await fs.stat(path.join(root, relative))).isFile());
    for (const relative of ['public/demo', 'public/showcase', 'public/docs', 'evidence', 'dist', 'tools/build.mjs', 'tools/publication.mjs', 'tools/generate-demo.mjs', 'tools/token.mjs', 'tools/test-browser.py', 'tools/browser_harness.py', 'tests/publication.test.mjs'])
        check('No publication or demo surface: ' + relative, await absent(relative));
    check('No private config', await absent('server/config.php'));
    const publicFiles = await filesBelow(path.join(root, 'public'));
    for (const file of publicFiles) {
        const relative = path.relative(root, file), text = await fs.readFile(file, 'utf8');
        if (/\.(?:js|html)$/i.test(file)) {
            check('No unsafe HTML construction: ' + relative, !/\b(?:innerHTML|outerHTML|insertAdjacentHTML|document\.write)\b/.test(text));
            check('No dynamic execution: ' + relative, !/\b(?:eval|Function)\s*\(/.test(text));
        }
        check('No browser credential: ' + relative, !/(?:SCAN_TOKEN|EXPECTED_TOKEN|X-Nexus-Token|Access token)/i.test(text));
        check('No demo or showcase reference: ' + relative, !/(?:fictional address book|explore the demo|showcase\/|\?demo)/i.test(text));
    }
    const html = await fs.readFile(path.join(root, 'public/index.html'), 'utf8');
    check('Private application is noindex', /name="robots" content="noindex,nofollow"/.test(html));
    check('CSP is present', /Content-Security-Policy/.test(html));
    check('Viewport permits zoom', !/(?:maximum-scale|user-scalable\s*=\s*no)/i.test(html));
    check('No inline handlers', !/\son[a-z]+\s*=/i.test(html));
    check('No remote runtime assets', !/<(?:script|img)[^>]+src="https?:|<link[^>]+rel="stylesheet"[^>]+href="https?:|<link[^>]+href="https?:[^>]+rel="stylesheet"/i.test(html));
    const app = await fs.readFile(path.join(root, 'public/js/app.js'), 'utf8');
    check('No visible full hash display', !/(?:SHA-256|BASE \$\{|NEXT \$\{|class:\s*['"]hash)/.test(app));
    for (const id of ['library-list', 'contact-list', 'detail-pane', 'search', 'alphabet', 'modal', 'settings-button', 'open-button'])
        check('Required interface control: ' + id, html.includes(`id="${id}"`));
    for (const relative of ['sources', 'var'])
        check('No private data in source tree: ' + relative, (await filesBelow(path.join(root, relative))).length === 0);
    console.log(JSON.stringify({ passed: checks.length, phpExecuted: php.status === 0, checks }, null, 2));
}
catch (error) {
    console.error(JSON.stringify({ passed: checks.length, error: error.message, checks }, null, 2));
    process.exitCode = 1;
}
