import { LIMITS, invariant, checkedText, sha256, unescapeVCard, splitEscaped, escapeVCard, foldLine, utf8 } from './primitives.js';
/** Splits text into physical lines, keeping each line's offsets and its own line ending so edits can splice the original bytes. */
export function physicalLines(text) {
    const lines = [];
    const rx = /([^\r\n]*)(\r\n|\r|\n|$)/g;
    let m;
    while ((m = rx.exec(text)) && m[0].length)
        lines.push({ text: m[1], newline: m[2], start: m.index, end: rx.lastIndex, line: lines.length + 1 });
    return lines;
}
function splitParameters(text, separator) {
    const result = [];
    let value = '', quoted = false;
    for (const c of text) {
        if (c === '"')
            quoted = !quoted;
        if (c === separator && !quoted) {
            result.push(value);
            value = '';
        }
        else
            value += c;
    }
    result.push(value);
    return result;
}
/**
 * Parses one unfolded content line into group, name, parameters and value, per RFC 6350
 * section 3.3: https://www.rfc-editor.org/rfc/rfc6350#section-3.3
 * The value stays encoded, so the original text survives until a field is edited.
 * @param {string} logical
 * @returns {?object} null when the line is not a property.
 */
export function parseProperty(logical) {
    let quoted = false, colon = -1;
    for (let i = 0; i < logical.length; i++) {
        if (logical[i] === '"')
            quoted = !quoted;
        if (logical[i] === ':' && !quoted) {
            colon = i;
            break;
        }
    }
    if (colon < 0)
        return null;
    const header = logical.slice(0, colon), tokens = splitParameters(header, ';'), qualified = tokens.shift();
    const dot = qualified.indexOf('.');
    const group = dot < 0 ? '' : qualified.slice(0, dot), name = (dot < 0 ? qualified : qualified.slice(dot + 1)).toUpperCase();
    if (!/^[A-Z0-9-]+$/.test(name) || (group && !/^[a-z0-9-]+$/i.test(group)))
        return null;
    const params = Object.create(null);
    for (const token of tokens) {
        const eq = token.indexOf('=');
        const k = (eq < 0 ? 'TYPE' : token.slice(0, eq)).toUpperCase();
        const v = (eq < 0 ? token : token.slice(eq + 1)).replace(/^"|"$/g, '');
        params[k] = params[k] === undefined ? v : params[k] + ',' + v;
    }
    return { name, group, header, params, encoded: logical.slice(colon + 1) };
}
/**
 * Decodes quoted-printable values (RFC 2045 section 6.7), a vCard 2.1 encoding that still
 * appears in exports: https://www.rfc-editor.org/rfc/rfc2045#section-6.7
 * A value that cannot be decoded keeps its encoded text and makes the card read-only.
 */
function decodedProperty(prop, onIssue) {
    let value = prop.encoded;
    if (/QUOTED-PRINTABLE/i.test(prop.params.ENCODING || '')) {
        try {
            invariant(!/=(?![0-9a-f]{2})/i.test(value), 'Malformed quoted-printable data.');
            const out = [];
            for (let i = 0; i < value.length; i++) {
                if (value[i] === '=') {
                    out.push(parseInt(value.slice(i + 1, i + 3), 16));
                    i += 2;
                }
                else {
                    const cp = String.fromCodePoint(value.codePointAt(i));
                    for (const b of utf8.encode(cp))
                        out.push(b);
                    if (cp.length === 2)
                        i++;
                }
            }
            const charset = (prop.params.CHARSET || 'utf-8').toLowerCase();
            invariant(['utf-8', 'utf8', 'iso-8859-1', 'windows-1252', 'us-ascii'].includes(charset), 'Unsupported quoted-printable character set.');
            value = new TextDecoder(charset, { fatal: true }).decode(new Uint8Array(out));
        }
        catch {
            onIssue('ENCODING', 'Quoted-printable content could not be decoded; original data is retained.');
            return prop.encoded;
        }
    }
    return value;
}
export function emptyFields() {
    return { fn: '', given: '', family: '', additional: '', prefix: '', suffix: '', org: '', title: '', note: '', bday: '', nickname: '',
        phones: [], emails: [], addresses: [], urls: [], photos: [], extras: [] };
}
/**
 * Parses a VCF library without losing anything. Every card keeps its raw text, offsets,
 * line numbers and hash, and every property keeps its original line. A card is editable
 * only when it is closed, declares exactly one VERSION of 3.0 or 4.0 (RFC 2426 or
 * RFC 6350) and has no property the parser could not read. Any other card stays readable
 * and blocks in-place writes to the whole library.
 * @param {string} text
 * @param {string} [name]
 * @param {string} [id]
 * @returns {object} The library: contacts, diagnostics, revision, newline and `writable`.
 * @throws {Error} SOURCE_LIMIT, CARD_LIMIT, PROPERTY_LIMIT or CONTACT_LIMIT.
 */
export function parseVCard(text, name = 'contacts.vcf', id = name) {
    checkedText(text);
    const lines = physicalLines(text), contacts = [], diagnostics = [];
    let issueCount = 0, errorCount = 0, active = null;
    const addIssue = (code, message, line, severity = 'error') => {
        issueCount++;
        if (severity === 'error')
            errorCount++;
        if (diagnostics.length < LIMITS.diagnostics)
            diagnostics.push({ code, message, line, severity });
    };
    function finish(endIndex, closed) {
        const range = lines.slice(active.index, endIndex + 1), start = active.start, end = lines[endIndex].end, raw = text.slice(start, end);
        invariant(utf8.encode(raw).length <= LIMITS.cardBytes, 'A contact exceeds the 1 MiB limit.', 'CARD_LIMIT');
        const c = { id: `${id}:${contacts.length}`, sourceId: id, ordinal: contacts.length, start, end, lineStart: range[0].line, lineEnd: range.at(-1).line,
            raw, hash: sha256(raw), fields: emptyFields(), properties: [], issues: [], version: '', editable: closed };
        const problem = (code, message, line = c.lineStart) => {
            c.issues.push({ code, message, line });
            c.editable = false;
            addIssue(code, message, line);
        };
        if (!closed)
            problem('UNCLOSED_CARD', 'A vCard has no END:VCARD line.');
        for (let j = 1; j < range.length; j++) {
            const pstart = range[j].start;
            let pend = range[j].end, logical = range[j].text;
            if (/^END:VCARD$/i.test(logical))
                continue;
            if (logical === '')
                continue;
            const firstLine = range[j].line;
            while (j + 1 < range.length) {
                const next = range[j + 1].text;
                // A quoted-printable soft line break ends in '=' and continues without a leading space.
                const qp = /;ENCODING=QUOTED-PRINTABLE(?:;|:)/i.test(logical) && logical.endsWith('=');
                if (qp && !/^(?:BEGIN|END):VCARD$/i.test(next)) {
                    logical = logical.slice(0, -1) + next.replace(/^[ \t]/, '');
                    pend = range[++j].end;
                }
                else if (/^[ \t]/.test(next)) {
                    logical += next.slice(1);
                    pend = range[++j].end;
                }
                else
                    break;
            }
            invariant(c.properties.length < LIMITS.properties, 'A card exceeds the 2,048-property limit.', 'PROPERTY_LIMIT');
            const prop = parseProperty(logical);
            if (!prop) {
                problem('MALFORMED_PROPERTY', 'A property cannot be interpreted; original data is retained.', firstLine);
                continue;
            }
            const p = { ...prop, index: c.properties.length, start: pstart, end: pend, line: firstLine, raw: text.slice(pstart, pend) };
            p.value = decodedProperty(p, (code, message) => problem(code, message, firstLine));
            c.properties.push(p);
        }
        const first = (key) => c.properties.find(p => p.name === key), value = key => first(key) ? unescapeVCard(first(key).value) : '';
        c.version = value('VERSION');
        if (!['3.0', '4.0'].includes(c.version))
            problem('READ_ONLY_VERSION', `Version ${c.version || 'unknown'} is retained for reading. Repair or convert a separate copy before editing.`);
        if (c.properties.filter(p => p.name === 'VERSION').length !== 1)
            problem('VERSION_CARDINALITY', 'A card must declare exactly one version.');
        // Apple exports label a property with an X-ABLabel in the same group; _$!<Label>!$_ marks a built-in label.
        const labels = new Map(c.properties.filter(p => p.name === 'X-ABLABEL' && p.group).map(p => [p.group.toLowerCase(), unescapeVCard(p.value).replace(/_\$!<|>!\$_/g, '')]));
        const label = p => labels.get(p.group.toLowerCase()) || p.params.TYPE?.split(',').filter(t => t.toUpperCase() !== 'PREF').join(', ') || 'Other';
        for (const key of ['fn', 'org', 'title', 'note', 'bday', 'nickname'])
            c.fields[key] = value(key.toUpperCase());
        const structured = first('N');
        if (structured)
            [c.fields.family, c.fields.given, c.fields.additional, c.fields.prefix, c.fields.suffix] =
                [...splitEscaped(structured.value).map(unescapeVCard), '', '', '', '', ''].slice(0, 5);
        const org = first('ORG');
        if (org)
            c.fields.org = splitEscaped(org.value).map(unescapeVCard).filter(unit => unit.trim()).join(' · ');
        for (const p of c.properties) {
            const entry = { pid: p.index, label: label(p), value: unescapeVCard(p.value) };
            if (p.name === 'TEL')
                c.fields.phones.push(entry);
            else if (p.name === 'EMAIL')
                c.fields.emails.push(entry);
            else if (p.name === 'URL')
                c.fields.urls.push(entry);
            else if (p.name === 'ADR')
                c.fields.addresses.push({ ...entry, components: [...splitEscaped(p.value).map(unescapeVCard), '', '', '', '', '', '', ''].slice(0, 7) });
            else if (p.name === 'PHOTO')
                c.fields.photos.push({ ...entry, params: p.params });
            else if (!['BEGIN', 'END', 'VERSION', 'FN', 'N', 'ORG', 'TITLE', 'NOTE', 'BDAY', 'NICKNAME', 'X-ABLABEL', 'UID'].includes(p.name))
                c.fields.extras.push({ label: p.name, value: entry.value, pid: p.index });
        }
        c.uid = value('UID');
        c.displayName = c.fields.fn || [c.fields.given, c.fields.family].filter(Boolean).join(' ') || c.fields.org || c.fields.emails[0]?.value || 'Unnamed contact';
        if (!c.fields.fn)
            addIssue('MISSING_FN', 'No formatted name; a fallback is shown.', c.lineStart, 'warning');
        contacts.push(c);
        invariant(contacts.length <= LIMITS.contacts, 'The source exceeds the 50,000-contact limit.', 'CONTACT_LIMIT');
        active = null;
    }
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i], v = i === 0 ? line.text.replace(/^\uFEFF/, '') : line.text;
        if (/^BEGIN:VCARD$/i.test(v)) {
            if (active) {
                addIssue('NESTED_CARD', 'A new card begins before the preceding card ends.', line.line);
                finish(i - 1, false);
            }
            active = { index: i, start: line.start + (i === 0 && line.text.startsWith('\uFEFF') ? 1 : 0) };
        }
        else if (/^END:VCARD$/i.test(v)) {
            if (active)
                finish(i, true);
            else
                addIssue('ORPHAN_END', 'END:VCARD occurs outside a card.', line.line);
        }
        else if (!active && v.trim())
            addIssue('OUTSIDE_CARD', 'Text outside a vCard is retained; in-place writes are blocked.', line.line);
    }
    if (active)
        finish(lines.length - 1, false);
    const counts = new Map();
    for (const c of contacts)
        if (c.uid)
            counts.set(c.uid, (counts.get(c.uid) || 0) + 1);
    // A bookmark must survive reparsing and edits elsewhere in the file. It uses the UID when
    // that UID is unique in the file, otherwise the card's hash and its occurrence number.
    // Favourites and My Card store only this hash.
    const occurrences = new Map();
    for (const c of contacts) {
        const n = occurrences.get(c.hash) || 0;
        occurrences.set(c.hash, n + 1);
        c.bookmark = sha256(`${id}:${c.uid && counts.get(c.uid) === 1 ? 'uid:' + c.uid : 'raw:' + c.hash + ':' + n}`);
    }
    return { id, name, format: 'VCF', text, revision: sha256(text), bytes: utf8.encode(text).length, contacts, diagnostics, issueCount, errorCount,
        writable: errorCount === 0 && contacts.every(c => c.editable), newline: text.includes('\r\n') ? '\r\n' : text.includes('\r') ? '\r' : '\n' };
}
const scalarMap = { fn: 'FN', org: 'ORG', title: 'TITLE', note: 'NOTE', bday: 'BDAY', nickname: 'NICKNAME' };
const arrayMap = { phones: 'TEL', emails: 'EMAIL', addresses: 'ADR', urls: 'URL' };
function encodeURIValue(value) {
    invariant(typeof value === 'string' && value.length <= LIMITS.fieldChars && !/[\r\n\x00-\x1f\x7f]/.test(value), 'A URI value cannot contain control characters.');
    return value;
}
/**
 * Serialises a new vCard 3.0 card for an added contact, a CSV conversion or an import.
 * Existing cards are never rebuilt this way; they are patched by patchCard().
 * Each phone, email, address and URL gets its own group and X-ABLabel so a free-text
 * label travels with its value. X-NEXUS-SOURCE and X-NEXUS-CSV-ROW record where an
 * imported card came from.
 * @param {object} fields
 * @param {string} uid
 * @param {?object} [provenance]
 * @returns {string} The folded card with CRLF line endings.
 */
export function newVCard(fields, uid, provenance = null) {
    invariant(fields && typeof fields === 'object', 'Contact fields are required.');
    invariant(typeof fields.fn === 'string' && fields.fn.trim(), 'A full name is required.');
    const lines = ['BEGIN:VCARD', 'VERSION:3.0', `UID:${escapeVCard(uid)}`, `FN:${escapeVCard(fields.fn)}`];
    lines.push('N:' + ['family', 'given', 'additional', 'prefix', 'suffix'].map(k => escapeVCard(fields[k] || '')).join(';'));
    for (const [key, prop] of Object.entries(scalarMap))
        if (key !== 'fn' && fields[key])
            lines.push(`${prop}:${escapeVCard(fields[key])}`);
    let n = 0;
    for (const [key, prop] of Object.entries(arrayMap))
        for (const entry of fields[key] || []) {
            invariant(typeof entry.value === 'string', 'A contact value must be text.');
            if (!entry.value.trim() && key !== 'addresses')
                continue;
            const group = `nexus${++n}`;
            lines.push(`${group}.${prop}:${key === 'addresses' ? entry.components.map(escapeVCard).join(';') : prop === 'URL' ? encodeURIValue(entry.value) : escapeVCard(entry.value)}`);
            lines.push(`${group}.X-ABLabel:${escapeVCard(entry.label || 'Other')}`);
        }
    if (provenance)
        lines.push('X-NEXUS-SOURCE:' + escapeVCard(JSON.stringify(provenance)));
    if (fields.csvEvidence)
        lines.push('X-NEXUS-CSV-ROW:' + escapeVCard(JSON.stringify(fields.csvEvidence)));
    lines.push('END:VCARD');
    return lines.map(x => foldLine(x)).join('');
}
/**
 * Applies explicit edits to one card and returns its new text. Only changed properties are
 * rewritten; every other byte of the card, unknown and vendor properties included, is
 * kept. New properties go before END:VCARD, in the library's own line ending.
 * @param {object} library Must be writable.
 * @param {object} contact Must be editable.
 * @param {object} changes Edited scalar fields, `structuredName` as five components, or
 *     complete arrays for phones, emails, addresses and urls. An entry with a `pid` updates
 *     that property, an entry without one is added, and a source property left out is removed.
 * @returns {string}
 * @throws {Error} READ_ONLY, STALE_PROPERTY or DUPLICATE_EDIT.
 */
export function patchCard(library, contact, changes) {
    invariant(library.writable && contact.editable, 'This source is read-only because its interpretation is incomplete.', 'READ_ONLY');
    invariant(changes && typeof changes === 'object' && !Array.isArray(changes), 'Changes must be an object.');
    for (const key of Object.keys(changes))
        invariant(Object.hasOwn(scalarMap, key) || Object.hasOwn(arrayMap, key) || key === 'structuredName', 'Unknown editable field.');
    const replacements = [], insertions = [], nl = library.newline || '\r\n', replaced = new Set();
    let groupIndex = 0;
    const groupSet = new Set(contact.properties.map(p => p.group.toLowerCase()));
    const group = () => {
        let g;
        do {
            g = `nexus${++groupIndex}`;
        } while (groupSet.has(g));
        groupSet.add(g);
        return g;
    };
    // A rewritten value is plain UTF-8, so a previous ENCODING or CHARSET parameter would now be wrong.
    const cleanHeader = p => splitParameters(p.header, ';').filter((s, i) => i === 0 || !/^(?:ENCODING|CHARSET)=/i.test(s)).join(';');
    const addReplacement = (p, text) => {
        invariant(!replaced.has(p.index), 'A source property received two incompatible edits.', 'DUPLICATE_EDIT');
        replaced.add(p.index);
        replacements.push({ start: p.start, end: p.end, text });
    };
    for (const [key, name] of Object.entries(scalarMap)) {
        if (!(key in changes) || changes[key] === contact.fields[key])
            continue;
        invariant(typeof changes[key] === 'string', 'Edited scalar fields must be text.');
        if (key === 'fn')
            invariant(changes[key].trim(), 'A full name is required.');
        const p = contact.properties.find(p => p.name === name), line = foldLine(`${p ? cleanHeader(p) : name}:${escapeVCard(changes[key])}`, nl);
        if (p)
            addReplacement(p, line);
        else
            insertions.push(line);
    }
    if ('structuredName' in changes) {
        const values = changes.structuredName;
        invariant(Array.isArray(values) && values.length === 5, 'A structured name has five components.');
        const original = ['family', 'given', 'additional', 'prefix', 'suffix'].map(k => contact.fields[k]);
        if (JSON.stringify(values) !== JSON.stringify(original)) {
            const p = contact.properties.find(p => p.name === 'N'), line = foldLine(`${p ? cleanHeader(p) : 'N'}:${values.map(escapeVCard).join(';')}`, nl);
            if (p)
                addReplacement(p, line);
            else
                insertions.push(line);
        }
    }
    for (const [key, name] of Object.entries(arrayMap)) {
        if (!(key in changes))
            continue;
        const entries = changes[key];
        invariant(Array.isArray(entries) && entries.length <= 100, 'Use at most 100 entries in an editable field.');
        const seen = new Set(), original = new Map(contact.fields[key].map(e => [e.pid, e]));
        for (const entry of entries) {
            invariant(entry && typeof entry.value === 'string' && typeof entry.label === 'string', 'A field value and label must be text.');
            if (key === 'addresses')
                invariant(Array.isArray(entry.components) && entry.components.length === 7, 'An address has seven components.');
            const old = entry.pid === undefined ? null : original.get(entry.pid);
            invariant(entry.pid === undefined || old, 'A field refers to an unknown source property.', 'STALE_PROPERTY');
            if (old) {
                invariant(!seen.has(entry.pid), 'A source property appears more than once.');
                seen.add(entry.pid);
            }
            const encoded = key === 'addresses' ? entry.components.map(escapeVCard).join(';') : name === 'URL' ? encodeURIValue(entry.value) : escapeVCard(entry.value);
            if (old && old.value === entry.value && old.label === entry.label && JSON.stringify(old.components) === JSON.stringify(entry.components))
                continue;
            let text;
            if (old) {
                const p = contact.properties[entry.pid];
                if (old.label !== entry.label && !p.group) {
                    const g = group();
                    text = foldLine(`${g}.${name}${name === 'TEL' && contact.version === '4.0' ? ';VALUE=text' : ''}:${encoded}`, nl);
                    insertions.push(foldLine(`${g}.X-ABLabel:${escapeVCard(entry.label || 'Other')}`, nl));
                }
                else {
                    let header = cleanHeader(p);
                    // vCard 4.0 recommends URI values for TEL; a free-form number is declared as text (RFC 6350 section 6.4.1).
                    if (name === 'TEL' && contact.version === '4.0')
                        header = header.replace(/;VALUE=[^;]+/ig, '') + ';VALUE=text';
                    text = foldLine(`${header}:${encoded}`, nl);
                    if (old.label !== entry.label) {
                        const label = contact.properties.find(candidate => candidate.name === 'X-ABLABEL' && candidate.group.toLowerCase() === p.group.toLowerCase());
                        if (label)
                            addReplacement(label, foldLine(`${cleanHeader(label)}:${escapeVCard(entry.label || 'Other')}`, nl));
                        else
                            insertions.push(foldLine(`${p.group}.X-ABLabel:${escapeVCard(entry.label || 'Other')}`, nl));
                    }
                }
            }
            else {
                const g = group();
                text = foldLine(`${g}.${name}${name === 'TEL' && contact.version === '4.0' ? ';VALUE=text' : ''}:${encoded}`, nl) + foldLine(`${g}.X-ABLabel:${escapeVCard(entry.label || 'Other')}`, nl);
            }
            if (old)
                addReplacement(contact.properties[entry.pid], text);
            else
                insertions.push(text);
        }
        for (const old of original.values())
            if (!seen.has(old.pid)) {
                addReplacement(contact.properties[old.pid], '');
                const property = contact.properties[old.pid];
                // Removing the last property of a group also removes that group's label.
                if (property.group) {
                    const peers = contact.properties.filter(candidate => candidate.index !== property.index && candidate.name !== 'X-ABLABEL' && candidate.group.toLowerCase() === property.group.toLowerCase());
                    const label = contact.properties.find(candidate => candidate.name === 'X-ABLABEL' && candidate.group.toLowerCase() === property.group.toLowerCase());
                    if (!peers.length && label)
                        addReplacement(label, '');
                }
            }
    }
    if (insertions.length) {
        const last = physicalLines(contact.raw).at(-1);
        invariant(/^END:VCARD$/i.test(last.text), 'Missing end marker.');
        replacements.push({ start: contact.start + last.start, end: contact.start + last.start, text: insertions.join('') });
    }
    // Splice from the end so earlier offsets stay valid.
    let raw = contact.raw;
    for (const r of replacements.sort((a, b) => b.start - a.start))
        raw = raw.slice(0, r.start - contact.start) + r.text + raw.slice(r.end - contact.start);
    return raw;
}
