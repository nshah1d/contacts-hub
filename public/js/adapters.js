import { LIMITS, invariant, safeFilename, sha256, decodeBytes, checkedText, utf8 } from './core/primitives.js';
/**
 * Session-only storage. Saved changes live in memory until the user downloads them; the
 * files the session was opened from are never modified.
 */
export class MemoryAdapter {
    constructor(kind = 'local', entries = []) {
        this.kind = kind;
        this.entries = new Map();
        this.changed = false;
        const names = new Set();
        for (const e of entries) {
            safeFilename(e.name);
            const key = e.name.toLocaleLowerCase();
            invariant(!names.has(key), 'Two files have the same or case-colliding filename. Open them in separate workspaces.');
            names.add(key);
            this.entries.set(e.name, { name: e.name, text: checkedText(e.text) });
        }
    }
    async catalogue() {
        return [...this.entries.values()].map(e => ({ name: e.name, bytes: utf8.encode(e.text).length, modified: null }));
    }
    async read(name) {
        safeFilename(name);
        const e = this.entries.get(name);
        invariant(e, 'This source is no longer available.', 'NOT_FOUND');
        return { ...e, revision: sha256(e.text) };
    }
    async save(plan) {
        safeFilename(plan.filename, 'vcf');
        const collision = [...this.entries.keys()].find(name => name !== plan.filename && name.toLocaleLowerCase() === plan.filename.toLocaleLowerCase());
        invariant(!collision, 'A source with the same name in different letter case already exists.', 'CONFLICT');
        const old = this.entries.get(plan.filename), revision = old ? sha256(old.text) : null;
        invariant(revision === plan.baseRevision, 'This source changed after the draft opened.', 'CONFLICT');
        checkedText(plan.content);
        invariant(sha256(plan.content) === plan.revision, 'The draft changed unexpectedly. Reopen it and try again.');
        this.entries.set(plan.filename, { name: plan.filename, text: plan.content });
        this.changed = true;
        return { revision: plan.revision, backup: null, persistence: 'session' };
    }
    clear() {
        this.entries.clear();
        this.changed = false;
    }
}
/**
 * Client for the PHP endpoints. Every request is same-origin, uncached and aborted after
 * 45 seconds, and every state change carries the session's CSRF token.
 */
export class PHPAdapter {
    constructor(base = './', fetcher = (...args) => fetch(...args)) {
        this.kind = 'server';
        this.fetcher = fetcher;
        this.base = base;
        this.csrf = '';
        this.authMode = '';
        this.authenticated = false;
        this.controllers = new Set();
        this.releases = new Map();
    }
    async request(path, options = {}) {
        const controller = new AbortController();
        this.controllers.add(controller);
        const timer = setTimeout(() => controller.abort(), 45000);
        try {
            const response = await this.fetcher(this.base + path, { ...options, signal: controller.signal, cache: 'no-store', credentials: 'same-origin',
                headers: { ...options.headers } });
            if (!response.ok) {
                let data;
                try {
                    data = await response.json();
                }
                catch {
                }
                const error = new Error(data?.error || `Server request failed (${response.status}).`);
                error.code = response.status === 409 ? 'CONFLICT' : response.status === 401 || response.status === 403 ? 'AUTH' : 'HTTP';
                error.status = response.status;
                throw error;
            }
            this.releases.set(response, () => {
                clearTimeout(timer);
                this.controllers.delete(controller);
            });
            return response;
        }
        catch (error) {
            clearTimeout(timer);
            this.controllers.delete(controller);
            throw error;
        }
    }
    async session() {
        const response = await this.request('session.php');
        let data;
        try {
            data = await response.json();
        }
        finally {
            this.release(response);
        }
        invariant(data && typeof data.authenticated === 'boolean' && typeof data.csrf === 'string' && /^[a-f0-9]{64}$/.test(data.csrf) && ['password', 'remote_user'].includes(data.authMode), 'The session response is invalid.');
        this.csrf = data.csrf;
        this.authMode = data.authMode;
        this.authenticated = data.authenticated;
        return data;
    }
    async login(password) {
        const status = await this.session();
        if (status.authenticated)
            return status;
        invariant(status.authMode === 'password', 'Sign in through the web-server authentication prompt.');
        invariant(typeof password === 'string', 'Enter the library password.');
        const response = await this.request('session.php?action=login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Nexus-CSRF': this.csrf }, body: JSON.stringify({ password }) });
        let data;
        try {
            data = await response.json();
        }
        finally {
            this.release(response);
        }
        invariant(data?.authenticated === true && typeof data.csrf === 'string' && /^[a-f0-9]{64}$/.test(data.csrf), 'The sign-in response is invalid.');
        this.csrf = data.csrf;
        this.authenticated = true;
        return data;
    }
    async logout() {
        if (!this.csrf)
            return;
        const response = await this.request('session.php?action=logout', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Nexus-CSRF': this.csrf }, body: '{}' });
        try {
            await response.json();
        }
        finally {
            this.release(response);
            this.csrf = '';
            this.authenticated = false;
        }
    }
    release(response) {
        this.releases.get(response)?.();
        this.releases.delete(response);
    }
    async catalogue() {
        const response = await this.request('scan.php');
        let data;
        try {
            data = await response.json();
        }
        finally {
            this.release(response);
        }
        invariant(data && Array.isArray(data.files) && data.files.length <= LIMITS.libraries, 'The catalogue response is invalid.');
        invariant(!data.truncated, 'The server catalogue exceeds its limit. Narrow the configured directory.', 'CATALOGUE_LIMIT');
        this.lastCatalogueInfo = { ignored: Number.isSafeInteger(data.ignored) && data.ignored >= 0 ? data.ignored : 0 };
        const seen = new Set();
        return data.files.map(e => {
            safeFilename(e.name);
            const key = e.name.toLocaleLowerCase();
            invariant(!seen.has(key), 'The catalogue contains repeated or case-colliding filenames.');
            seen.add(key);
            invariant(Number.isSafeInteger(e.bytes) && e.bytes >= 0, 'Invalid source size.');
            return { name: e.name, bytes: e.bytes, modified: e.modified || null };
        });
    }
    /**
     * Reads one library. The body is read in chunks and abandoned at 20 MiB even when
     * Content-Length is missing or wrong. The revision is hashed from the bytes received,
     * never taken from a response header, because hosts and proxies may rewrite headers.
     * @param {string} name
     * @returns {Promise<{name: string, text: string, revision: string}>}
     */
    async read(name) {
        safeFilename(name);
        const response = await this.request('read.php?file=' + encodeURIComponent(name));
        try {
            const claimed = response.headers.get('Content-Length');
            if (claimed)
                invariant(Number(claimed) <= LIMITS.sourceBytes, 'The source exceeds 20 MiB.', 'SOURCE_LIMIT');
            const reader = response.body?.getReader();
            let bytes;
            if (reader) {
                let length = 0;
                const chunks = [];
                try {
                    for (;;) {
                        const { value, done } = await reader.read();
                        if (done)
                            break;
                        length += value.length;
                        invariant(length <= LIMITS.sourceBytes, 'The source exceeds 20 MiB.', 'SOURCE_LIMIT');
                        chunks.push(value);
                    }
                }
                catch (e) {
                    await reader.cancel().catch(() => {
                    });
                    throw e;
                }
                finally {
                    reader.releaseLock();
                }
                bytes = new Uint8Array(length);
                let offset = 0;
                for (const c of chunks) {
                    bytes.set(c, offset);
                    offset += c.length;
                }
            }
            else
                bytes = new Uint8Array(await response.arrayBuffer());
            invariant(bytes.byteLength <= LIMITS.sourceBytes, 'The source exceeds 20 MiB.', 'SOURCE_LIMIT');
            const text = decodeBytes(bytes), revision = sha256(bytes);
            return { name, text, revision };
        }
        finally {
            this.release(response);
        }
    }
    async save(plan) {
        safeFilename(plan.filename, 'vcf');
        invariant(/^[a-f0-9]{64}$/.test(this.csrf), 'Reload Contacts Hub before saving.', 'AUTH');
        const response = await this.request('write.php', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Nexus-CSRF': this.csrf },
            body: JSON.stringify({ action: 'save', filename: plan.filename, baseRevision: plan.baseRevision, vcfContent: plan.content }) });
        let data;
        try {
            data = await response.json();
        }
        finally {
            this.release(response);
        }
        invariant(data?.revision === plan.revision, 'The saved file differs from the reviewed change. Reload the library.', 'INTEGRITY');
        return data;
    }
    clear() {
        this.csrf = '';
        this.authMode = '';
        this.authenticated = false;
        for (const c of this.controllers)
            c.abort();
        this.controllers.clear();
        for (const release of this.releases.values())
            release();
        this.releases.clear();
    }
}
/**
 * Saves a plan and publishes the new library to the engine only after reading the file
 * back and matching the planned revision. A lost response can follow a successful write,
 * so the outcome is always settled by the read-back, never by the save response alone.
 * @param {MemoryAdapter|FileAdapter|PHPAdapter} adapter
 * @param {EngineClient} engine
 * @param {object} plan From planChange() or convertLibrary().
 * @returns {Promise<{summary: object, receipt: object}>}
 * @throws {Error} UNVERIFIED_SAVE when the read-back fails, CONFLICT when the file differs.
 */
export async function commitPlan(adapter, engine, plan) {
    invariant(sha256(plan.content) === plan.revision, 'The draft changed unexpectedly. Reopen it and try again.', 'INTEGRITY');
    let receipt = null, writeError = null;
    try {
        receipt = await adapter.save(plan);
    }
    catch (error) {
        writeError = error;
    }
    let current;
    try {
        current = await adapter.read(plan.filename);
    }
    catch (error) {
        const e = new Error('The save outcome is unknown because read-back failed. Keep the draft, refresh the library and compare revisions before trying again.');
        e.code = 'UNVERIFIED_SAVE';
        e.cause = error;
        throw e;
    }
    if (current.revision !== plan.revision) {
        const e = writeError || new Error('The server source differs from the proposed change. Refresh before retrying.');
        e.code = writeError?.code || 'CONFLICT';
        throw e;
    }
    const summary = await engine.request('open', { text: current.text, name: plan.filename, id: plan.sourceId || plan.filename });
    return { summary, receipt: { ...plan.receipt, afterSha256: plan.revision, verifiedAt: new Date().toISOString(),
            persistence: adapter.kind === 'server' ? 'server' : 'session', responseRecovered: !!writeError, backup: receipt?.backup || null } };
}
/** Files chosen from this device. They are read on demand and never written; changes are kept as session entries. */
export class FileAdapter extends MemoryAdapter {
    constructor(files) {
        super('local');
        this.files = new Map();
        const names = new Set();
        for (const file of files) {
            safeFilename(file.name);
            const key = file.name.toLocaleLowerCase();
            invariant(!names.has(key), 'The selection has two files with the same or case-colliding filename. Open them in separate workspaces.');
            names.add(key);
            invariant(file.size <= LIMITS.sourceBytes, `${file.name} exceeds 20 MiB.`, 'SOURCE_LIMIT');
            this.files.set(file.name, file);
        }
        invariant(this.files.size <= LIMITS.libraries, 'Choose at most 2,000 libraries.', 'CATALOGUE_LIMIT');
    }
    async catalogue() {
        const entries = new Map([...this.files.values()].map(f => [f.name, { name: f.name, bytes: f.size, modified: new Date(f.lastModified).toISOString() }]));
        for (const e of this.entries.values())
            entries.set(e.name, { name: e.name, bytes: utf8.encode(e.text).length, modified: null });
        return [...entries.values()];
    }
    async read(name) {
        if (this.entries.has(name))
            return super.read(name);
        safeFilename(name);
        const file = this.files.get(name);
        invariant(file, 'Source not found.', 'NOT_FOUND');
        const bytes = new Uint8Array(await file.arrayBuffer());
        return { name, text: decodeBytes(bytes), revision: sha256(bytes) };
    }
    async save(plan) {
        safeFilename(plan.filename, 'vcf');
        const collision = [...this.files.keys(), ...this.entries.keys()].find(name => name !== plan.filename && name.toLocaleLowerCase() === plan.filename.toLocaleLowerCase());
        invariant(!collision, 'A source with the same name in different letter case already exists.', 'CONFLICT');
        let revision = null;
        if (this.files.has(plan.filename) || this.entries.has(plan.filename))
            revision = (await this.read(plan.filename)).revision;
        invariant(revision === plan.baseRevision, 'The local source differs from the draft.', 'CONFLICT');
        checkedText(plan.content);
        invariant(sha256(plan.content) === plan.revision, 'The draft changed unexpectedly. Reopen it and try again.');
        this.entries.set(plan.filename, { name: plan.filename, text: plan.content });
        this.changed = true;
        return { revision: plan.revision, persistence: 'session' };
    }
    clear() {
        super.clear();
        this.files.clear();
    }
}
/** Refuse a mutation before transport when its session audit cannot be retained. */
export function checkReceiptCapacity(receipts, next) {
    invariant(Array.isArray(receipts) && receipts.length < LIMITS.receipts, 'The session has 1,000 change receipts. Download and clear the receipts in Settings before another change.', 'RECEIPT_LIMIT');
    const bytes = utf8.encode(JSON.stringify(receipts)).length + utf8.encode(JSON.stringify(next)).length + 4096;
    invariant(bytes <= LIMITS.receiptBytes, 'Change receipts would exceed 8 MiB. Download and clear the receipts in Settings, or import fewer rows.', 'RECEIPT_LIMIT');
}
