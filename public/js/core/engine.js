import { LIMITS, invariant, safeFilename, sha256, phoneKey, emailKey, searchText, csvCell, utf8, asciiDigits } from './primitives.js';
import { parseVCard, patchCard, newVCard } from './vcard.js';
import { parseContactCSV } from './csv.js';
export function parseLibrary(text, name, id = name, options = {}) {
    safeFilename(name);
    const lib = name.toLowerCase().endsWith('.csv') ? parseContactCSV(text, name, id, options) : parseVCard(text, name, id);
    indexLibrary(lib);
    return lib;
}
/** Adds phone and email keys, search text, per-field fuzzy targets and data-quality flags to every contact. */
export function indexLibrary(lib) {
    for (const c of lib.contacts) {
        c.phoneKeys = [...new Set(c.fields.phones.map(e => phoneKey(e.value)).filter(Boolean))];
        c.emailKeys = [...new Set(c.fields.emails.map(e => emailKey(e.value)).filter(Boolean))];
        c.search = searchText([c.displayName, c.fields.org, c.fields.title, c.fields.nickname, c.fields.note,
            ...c.fields.phones.map(e => e.value), ...c.fields.emails.map(e => e.value), ...c.fields.addresses.map(e => e.components.join(' ')), ...c.phoneKeys].join(' '));
        // Fuzzy matching runs within one short field at a time. Across a joined record, notes and
        // addresses would let scattered letters match almost every contact.
        c.fuzzyFields = [c.displayName, c.fields.org, c.fields.title, c.fields.nickname, ...c.fields.phones.map(e => e.value),
            ...c.fields.emails.map(e => e.value), ...c.phoneKeys.map(k => k.replace(/^(international|local):/, ''))].filter(Boolean).map(searchText);
        c.quality = [];
        if (!c.fields.fn)
            c.quality.push('Missing full name');
        if (!c.fields.phones.length && !c.fields.emails.length)
            c.quality.push('No phone or email');
        if (c.fields.phones.some(e => !phoneKey(e.value)))
            c.quality.push('Phone needs review');
        if (c.fields.emails.some(e => !emailKey(e.value)))
            c.quality.push('Email needs review');
        if (!c.editable && lib.format === 'VCF')
            c.quality.push('Read-only source card');
    }
}
/**
 * Groups contacts that share a normalised phone or email key. A group is evidence of a
 * shared detail, never an identity decision: a household or a switchboard shares numbers
 * too, so nothing is merged.
 * @param {object[]} contacts
 * @returns {{id: string, kind: string, key: string, members: string[]}[]}
 * @throws {Error} MATCH_LIMIT
 */
export function matchGroups(contacts) {
    const groups = new Map();
    for (const c of contacts)
        for (const [kind, keys] of [['phone', c.phoneKeys], ['email', c.emailKeys]])
            for (const key of keys) {
                const id = `${kind}:${key}`;
                let group = groups.get(id);
                if (!group) {
                    invariant(groups.size < LIMITS.groupKeys, 'The workspace has too many distinct contact keys. Open fewer libraries.', 'MATCH_LIMIT');
                    group = { id, kind, key, members: [] };
                    groups.set(id, group);
                }
                group.members.push(c.id);
            }
    const result = [...groups.values()].filter(g => g.members.length > 1);
    invariant(result.length <= LIMITS.groups, 'The workspace has too many shared-detail groups. Review fewer open libraries.', 'MATCH_LIMIT');
    return result;
}
/** Contacts that belong to any shared-detail group, found without building every group, since it runs on each query. */
function reviewMembers(contacts) {
    const first = new Map(), review = new Set();
    for (const contact of contacts)
        for (const [kind, keys] of [['phone', contact.phoneKeys], ['email', contact.emailKeys]])
            for (const key of keys) {
                const group = `${kind}:${key}`;
                if (first.has(group)) {
                    review.add(first.get(group));
                    review.add(contact.id);
                }
                else {
                    invariant(first.size < LIMITS.groupKeys, 'The workspace has too many distinct contact keys. Open fewer libraries.', 'MATCH_LIMIT');
                    first.set(group, contact.id);
                }
            }
    return review;
}
export function summaryOf(lib) {
    const groups = matchGroups(lib.contacts), review = new Set(groups.flatMap(g => g.members));
    return { id: lib.id, name: lib.name, format: lib.format, revision: lib.revision, bytes: lib.bytes, count: lib.contacts.length,
        writable: lib.writable, convertible: lib.format === 'CSV' ? lib.convertible : lib.writable, issueCount: lib.issueCount,
        diagnostics: lib.diagnostics, reviewCount: review.size, sharedGroups: groups.length,
        qualityCount: lib.contacts.filter(c => c.quality.length).length,
        coverage: { name: lib.contacts.filter(c => c.fields.fn).length, phone: lib.contacts.filter(c => c.fields.phones.length).length,
            email: lib.contacts.filter(c => c.fields.emails.length).length, organisation: lib.contacts.filter(c => c.fields.org).length },
        headers: lib.headers, mapping: lib.mapping, delimiter: lib.delimiter };
}
function inOrder(target, letters) {
    let offset = 0;
    for (const char of letters) {
        offset = target.indexOf(char, offset);
        if (offset < 0)
            return false;
        offset++;
    }
    return true;
}
/**
 * A contact matches when every typed word appears literally in its search text, when three
 * or more typed digits appear in one of its phone keys, or when the typed letters appear in
 * order within one short field (see indexLibrary).
 */
function matchesQuery(contact, query) {
    if (!query)
        return true;
    const q = searchText(query).trim(), tokens = q.split(/\s+/).filter(Boolean);
    const literal = tokens.every(t => {
        if (contact.search.includes(t))
            return true;
        const digits = asciiDigits(t).replace(/[+().-]/g, '');
        return /^\d{3,}$/.test(digits) && contact.phoneKeys.some(k => k.replace(/^(international|local):/, '').includes(digits));
    });
    if (literal)
        return true;
    const letters = q.replace(/\s/g, '');
    return contact.fuzzyFields.some(field => inOrder(field, letters));
}
/**
 * Filters, sorts and windows contacts across the given libraries. My Card sorts first,
 * then names in base-letter order. `alpha` gives the first index of each initial for the
 * alphabet gutter.
 * @returns {{total: number, offset: number, alpha: object[], items: object[]}}
 */
export function queryContacts(libraries, options = {}) {
    const { query = '', filter = 'all', favourites = [], myCard = '', offset = 0, limit = 80 } = options;
    invariant(['all', 'favourites', 'review', 'quality'].includes(filter), 'Unknown contact filter.');
    invariant(typeof query === 'string' && query.length <= LIMITS.queryChars, 'Search is limited to 256 characters.', 'QUERY_LIMIT');
    invariant(Number.isInteger(offset) && offset >= 0 && Number.isInteger(limit) && limit >= 0 && limit <= 100, 'Invalid result window.');
    const allContacts = libraries.flatMap(l => l.contacts), contacts = options.sourceId ? allContacts.filter(c => c.sourceId === options.sourceId) : allContacts, review = reviewMembers(allContacts), fav = new Set(favourites);
    let found = contacts.filter(c => matchesQuery(c, query) &&
        (filter !== 'favourites' || fav.has(c.bookmark)) && (filter !== 'review' || review.has(c.id)) && (filter !== 'quality' || c.quality.length));
    found.sort((a, b) => (b.bookmark === myCard) - (a.bookmark === myCard) || a.displayName.localeCompare(b.displayName, 'en', { sensitivity: 'base' }) || a.id.localeCompare(b.id));
    const alpha = [];
    let seen = new Set();
    found.forEach((c, index) => {
        const letter = searchText(c.displayName)[0]?.toUpperCase(), key = /^[A-Z]$/.test(letter || '') ? letter : '#';
        if (!seen.has(key)) {
            seen.add(key);
            alpha.push({ letter: key, index });
        }
    });
    const rows = found.map(c => ({ id: c.id, sourceId: c.sourceId, bookmark: c.bookmark,
        name: c.displayName, org: c.fields.org, secondary: c.fields.org || c.fields.emails[0]?.value || c.fields.phones[0]?.value || 'No phone or email',
        review: review.has(c.id), quality: c.quality.length, myCard: c.bookmark === myCard, favourite: fav.has(c.bookmark) }));
    if (options._cache === true)
        return { total: found.length, alpha, rows };
    return { total: found.length, offset, alpha, items: rows.slice(offset, offset + limit) };
}
export function getContact(libraries, id) {
    for (const l of libraries) {
        const c = l.contacts.find(c => c.id === id);
        if (c)
            return { library: l, contact: c };
    }
    invariant(false, 'The selected contact is no longer present.', 'MISSING_CONTACT');
}
/** One contact with its library summary and the records that share its details; at most 50 peers are returned, `peerCount` is exact. */
export function detailOf(libraries, id) {
    const { library, contact } = getContact(libraries, id);
    const all = libraries.flatMap(l => l.contacts), targets = new Map();
    for (const [kind, keys] of [['phone', contact.phoneKeys], ['email', contact.emailKeys]])
        for (const key of keys)
            targets.set(`${kind}:${key}`, { id: `${kind}:${key}`, kind, key, members: [] });
    for (const candidate of all)
        for (const [kind, keys] of [['phone', candidate.phoneKeys], ['email', candidate.emailKeys]])
            for (const key of keys)
                targets.get(`${kind}:${key}`)?.members.push(candidate.id);
    const groups = [...targets.values()].filter(group => group.members.length > 1);
    const peerIds = new Set(groups.flatMap(g => g.members).filter(member => member !== id));
    const peers = all.filter(c => peerIds.has(c.id));
    return { contact: { ...contact, search: undefined, fuzzyFields: undefined }, library: summaryOf(library), matchGroups: groups,
        peers: peers.slice(0, 50).map(c => ({ id: c.id, name: c.displayName, sourceId: c.sourceId, fields: c.fields, bookmark: c.bookmark })), peerCount: peers.length };
}
function sourceReference(lib, c) {
    return { filename: lib.name, revision: lib.revision, record: c.ordinal + 1, lines: [c.lineStart, c.lineEnd], recordSha256: c.hash };
}
/**
 * Plans an edit, deletion, addition or CSV import against one library and returns the
 * complete new file, its revision, the counts and a receipt. Nothing is written here.
 * The plan is refused when the library changed since the draft opened, when the edited card
 * changed, or when the result would not parse as a writable library.
 * @param {object} lib
 * @param {object} request `kind`, `baseRevision` and the fields for that kind.
 * @param {object[]} [sourceLibraries] Open libraries that imports may draw rows from.
 * @returns {object}
 * @throws {Error} CONFLICT, READ_ONLY, MISSING_CONTACT, IMPORT_FORMAT or INVALID_PLAN.
 */
export function planChange(lib, request, sourceLibraries = []) {
    invariant(request && request.baseRevision === lib.revision, 'This draft is based on an older library revision.', 'CONFLICT');
    invariant(lib.writable, 'This library is read-only. Create an editable copy first.', 'READ_ONLY');
    const { kind, id, changes, fields, uid } = request;
    let content = lib.text, changed = [], targetOrdinal = null, origins = [];
    if (kind === 'edit' || kind === 'delete') {
        const c = lib.contacts.find(c => c.id === id);
        invariant(c, 'The contact no longer exists.', 'MISSING_CONTACT');
        invariant(request.recordHash === c.hash, 'The contact changed after the editor opened.', 'CONFLICT');
        const replacement = kind === 'delete' ? '' : patchCard(lib, c, changes);
        content = content.slice(0, c.start) + replacement + content.slice(c.end);
        targetOrdinal = c.ordinal;
        origins = [sourceReference(lib, c)];
        changed = kind === 'delete' ? ['record removed'] : Object.keys(changes).filter(k => k === 'structuredName' || JSON.stringify(changes[k]) !== JSON.stringify(c.fields[k]));
    }
    else if (kind === 'add') {
        const card = newVCard(fields, uid);
        content += (content && !/[\r\n]$/.test(content) ? lib.newline : '') + card;
        changed = ['new record'];
        targetOrdinal = lib.contacts.length;
    }
    else if (kind === 'import') {
        invariant(Array.isArray(request.selected) && request.selected.length > 0 && request.selected.length <= LIMITS.contacts, 'Choose contacts to import.');
        const seen = new Set();
        let addition = '';
        for (const ref of request.selected) {
            invariant(!seen.has(ref.id), 'A contact was selected twice.');
            seen.add(ref.id);
            const { library, contact } = getContact(sourceLibraries, ref.id);
            invariant(library.id !== lib.id, 'Choose a different source library.');
            invariant(library.revision === ref.revision, 'An import source changed.', 'CONFLICT');
            invariant(library.format === 'CSV', 'Selective import accepts CSV rows only. Keep VCF sources separate or make an exact library copy.', 'IMPORT_FORMAT');
            invariant(library.convertible, 'Fix malformed CSV before importing it.', 'READ_ONLY');
            const origin = sourceReference(library, contact);
            origins.push(origin);
            addition += newVCard(contact.fields, `${uid}:${contact.hash}:${contact.ordinal}`, origin);
        }
        content += (content && !/[\r\n]$/.test(content) ? lib.newline : '') + addition;
        changed = [`${request.selected.length} imported records`];
        targetOrdinal = lib.contacts.length;
    }
    else
        invariant(false, 'Unknown change type.');
    const after = parseLibrary(content, lib.name, lib.id);
    invariant(after.writable, 'The proposed change produced a read-only library.', 'INVALID_PLAN');
    return { schemaVersion: 1, sourceId: lib.id, filename: lib.name, baseRevision: lib.revision, revision: after.revision, content,
        beforeCount: lib.contacts.length, afterCount: after.contacts.length, kind, changed, origins, targetOrdinal,
        targetId: after.contacts[Math.min(targetOrdinal, after.contacts.length - 1)]?.id || null,
        bookmarkChange: ['edit', 'delete'].includes(kind) ? { from: lib.contacts[targetOrdinal].bookmark, to: kind === 'edit' ? after.contacts[targetOrdinal].bookmark : null } : null,
        receipt: { schemaVersion: 1, operation: kind, filename: lib.name, beforeSha256: lib.revision, afterSha256: after.revision,
            beforeCount: lib.contacts.length, afterCount: after.contacts.length, changed, origins } };
}
/**
 * Plans an editable VCF copy: an exact copy of a writable VCF, or a conversion of a CSV in
 * which every card records its source row.
 * @returns {{filename: string, content: string, revision: string, baseRevision: null}}
 */
export function convertLibrary(lib, filename, uidPrefix = 'nexus') {
    safeFilename(filename, 'vcf');
    invariant(lib.format !== 'CSV' || lib.convertible, 'Resolve malformed CSV or map missing names before conversion.', 'READ_ONLY');
    if (lib.format === 'VCF') {
        invariant(lib.writable, 'Repair the read-only VCF in a separate tool before creating an editable copy.', 'READ_ONLY');
        return { filename, content: lib.text, revision: lib.revision, baseRevision: null };
    }
    // Conversion is deliberately a new file. The original is never replaced.
    const content = lib.contacts.map(c => newVCard(c.fields, `${uidPrefix}:${c.hash}:${c.ordinal}`, sourceReference(lib, c))).join('');
    return { filename, content, revision: sha256(content), baseRevision: null };
}
/**
 * Proposes copying details from one record into another: empty fields are filled and
 * missing values appended. Conflicting values are reported, never overwritten, and both
 * records remain.
 */
export function combineDetails(primary, secondary) {
    const changes = {}, conflicts = [];
    for (const key of ['org', 'title', 'note', 'bday', 'nickname']) {
        const a = primary.fields[key], b = secondary.fields[key];
        if (!a && b)
            changes[key] = b;
        else if (a && b && a !== b)
            conflicts.push({ field: key, kept: a, other: b });
    }
    for (const key of ['phones', 'emails', 'addresses', 'urls']) {
        const values = primary.fields[key].map(e => ({ ...e }));
        for (const e of secondary.fields[key])
            if (!values.some(v => v.value === e.value && v.label === e.label && JSON.stringify(v.components) === JSON.stringify(e.components))) {
                const copy = { ...e };
                delete copy.pid;
                values.push(copy);
            }
        if (values.length !== primary.fields[key].length)
            changes[key] = values;
    }
    return { changes, conflicts, retainsBothRecords: true };
}
/** Complete evidence export: the source text, its interpretation and every parsed record. tools/relational.mjs reparses it to prove it matches its source. */
export function exportEvidence(lib) {
    return JSON.stringify({ schemaVersion: 1, source: { id: lib.id, name: lib.name, sha256: lib.revision, bytes: lib.bytes, text: lib.text, interpretation: lib.format === 'CSV' ? { delimiter: lib.delimiter, mapping: lib.mapping } : null },
        diagnostics: lib.diagnostics, issueCount: lib.issueCount, contacts: lib.contacts.map(c => ({ id: c.id, origin: sourceReference(lib, c), fields: c.fields,
            phoneKeys: c.phoneKeys, emailKeys: c.emailKeys, quality: c.quality, raw: c.raw })), sharedDetails: matchGroups(lib.contacts) }, null, 2);
}
export function exportTable(lib) {
    const headers = ['source', 'record', 'source_sha256', 'record_sha256', 'name', 'organisation', 'phone', 'email'];
    return [headers, ...lib.contacts.map(c => [lib.name, c.ordinal + 1, lib.revision, c.hash, c.displayName, c.fields.org,
            c.fields.phones.map(e => e.value).join(' | '), c.fields.emails.map(e => e.value).join(' | ')])]
        .map(row => row.map(x => csvCell(x)).join(',')).join('\r\n') + '\r\n';
}
/**
 * The engine behind the worker. It holds the opened libraries and caches the last full query
 * result under a key that includes an epoch changed by every open, close or clear, so scrolling
 * reads windows from memory. The 64 MiB and 100,000-contact ceilings apply across all open
 * libraries together.
 */
export class ContactEngine {
    constructor() {
        this.libraries = new Map();
        this.epoch = 0;
        this.queryCache = null;
    }
    open({ text, name, id = name, options = {} }) {
        const candidate = parseLibrary(text, name, id, options), others = [...this.libraries.values()].filter(l => l.id !== id);
        invariant(others.reduce((n, l) => n + l.bytes, 0) + candidate.bytes <= LIMITS.sessionBytes, 'Open libraries exceed 64 MiB. Close a library before continuing.', 'SESSION_LIMIT');
        invariant(others.reduce((n, l) => n + l.contacts.length, 0) + candidate.contacts.length <= LIMITS.sessionContacts, 'Open libraries exceed 100,000 contacts. Close a library first.', 'SESSION_LIMIT');
        const summary = summaryOf(candidate);
        this.libraries.set(id, candidate);
        this.epoch++;
        this.queryCache = null;
        return summary;
    }
    handle(type, payload = {}) {
        if (type === 'open')
            return this.open(payload);
        if (type === 'clear') {
            this.libraries.clear();
            this.epoch++;
            this.queryCache = null;
            return true;
        }
        if (type === 'close') {
            this.libraries.delete(payload.id);
            this.epoch++;
            this.queryCache = null;
            return true;
        }
        const all = [...this.libraries.values()];
        if (type === 'summaries')
            return all.map(summaryOf);
        if (type === 'query') {
            const { offset = 0, limit = 80, focusId = null, ...base } = payload;
            invariant(Number.isInteger(offset) && offset >= 0 && Number.isInteger(limit) && limit >= 0 && limit <= 100, 'Invalid result window.');
            const key = JSON.stringify([this.epoch, base]);
            if (!this.queryCache || this.queryCache.key !== key)
                this.queryCache = { key, ...queryContacts(all, { ...base, _cache: true }) };
            const cache = this.queryCache;
            return { total: cache.total, offset, alpha: cache.alpha, focusIndex: focusId ? cache.rows.findIndex(c => c.id === focusId) : -1, items: cache.rows.slice(offset, offset + limit) };
        }
        if (type === 'detail')
            return detailOf(all, payload.id);
        if (type === 'combine') {
            return combineDetails(getContact(all, payload.primary).contact, getContact(all, payload.secondary).contact);
        }
        const lib = this.libraries.get(payload.sourceId);
        invariant(lib, 'Open this library first.', 'MISSING_LIBRARY');
        if (type === 'plan') {
            const plan = planChange(lib, payload, all);
            const others = all.filter(l => l.id !== lib.id);
            invariant(others.reduce((n, l) => n + l.bytes, 0) + utf8.encode(plan.content).length <= LIMITS.sessionBytes, 'The proposed source exceeds the open-workspace byte limit. Close other libraries first.', 'SESSION_LIMIT');
            invariant(others.reduce((n, l) => n + l.contacts.length, 0) + plan.afterCount <= LIMITS.sessionContacts, 'The proposed source exceeds the open-workspace contact limit. Close other libraries first.', 'SESSION_LIMIT');
            return plan;
        }
        if (type === 'convert') {
            const plan = convertLibrary(lib, payload.filename, payload.uid);
            invariant(all.reduce((n, l) => n + l.bytes, 0) + utf8.encode(plan.content).length <= LIMITS.sessionBytes, 'The new copy exceeds the open-workspace byte limit. Close other libraries first.', 'SESSION_LIMIT');
            invariant(all.reduce((n, l) => n + l.contacts.length, 0) + lib.contacts.length <= LIMITS.sessionContacts, 'The new copy exceeds the open-workspace contact limit. Close other libraries first.', 'SESSION_LIMIT');
            return plan;
        }
        if (type === 'export') {
            if (payload.format === 'evidence')
                return exportEvidence(lib);
            if (payload.format === 'table')
                return exportTable(lib);
            if (payload.format === 'original')
                return lib.text;
            if (payload.format === 'card') {
                const c = lib.contacts.find(c => c.id === payload.id);
                invariant(c, 'Contact missing.');
                return lib.format === 'VCF' ? c.raw : newVCard(c.fields, payload.uid, sourceReference(lib, c));
            }
            invariant(false, 'Unknown export format.');
        }
        invariant(false, 'Unknown engine operation.');
    }
}
