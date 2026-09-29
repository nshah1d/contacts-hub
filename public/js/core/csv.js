import { LIMITS, invariant, checkedText, sha256, utf8 } from './primitives.js';
import { emptyFields } from './vcard.js';
/**
 * Splits CSV per RFC 4180 (https://www.rfc-editor.org/rfc/rfc4180), with semicolon and tab
 * as explicit alternatives to the comma. Malformed quoting marks the row bad and reports
 * it rather than guessing. Every row keeps its offsets and line numbers.
 * @param {string} text
 * @param {','|';'|'\t'} [delimiter=',']
 * @returns {{rows: object[], diagnostics: object[], issueCount: number}}
 * @throws {Error} COLUMN_LIMIT, CONTACT_LIMIT or FIELD_LIMIT.
 */
export function tokenizeCSV(text, delimiter = ',') {
    checkedText(text);
    invariant([',', ';', '\t'].includes(delimiter), 'Choose comma, semicolon or tab as the separator.');
    const rows = [], diagnostics = [];
    let cells = [], cell = '', state = 'start', line = 1, rowLine = 1, start = 0, i = text.startsWith('\uFEFF') ? 1 : 0;
    let rowBad = false, issueCount = 0;
    const issue = (code, message) => {
        rowBad = true;
        issueCount++;
        if (diagnostics.length < LIMITS.diagnostics)
            diagnostics.push({ code, message, line, severity: 'error' });
    };
    const field = () => {
        cells.push(cell);
        invariant(cells.length <= LIMITS.columns, 'The CSV exceeds 256 columns.', 'COLUMN_LIMIT');
        cell = '';
        state = 'start';
    };
    const row = end => {
        field();
        if (cells.some(v => v !== ''))
            rows.push({ cells, start, end, lineStart: rowLine, lineEnd: line, bad: rowBad });
        invariant(rows.length <= LIMITS.contacts + 1, 'The CSV exceeds 50,000 contact rows.', 'CONTACT_LIMIT');
        cells = [];
        rowBad = false;
        start = end;
        rowLine = line + 1;
    };
    for (; i < text.length; i++) {
        const c = text[i];
        const newline = c === '\r' || c === '\n', step = c === '\r' && text[i + 1] === '\n' ? 2 : 1;
        if (state === 'quoted') {
            if (c === '"') {
                if (text[i + 1] === '"') {
                    cell += '"';
                    i++;
                }
                else
                    state = 'after';
            }
            else {
                cell += newline ? text.slice(i, i + step) : c;
                if (newline) {
                    i += step - 1;
                    line++;
                }
            }
        }
        else if (c === delimiter)
            field();
        else if (newline) {
            row(i + step);
            i += step - 1;
            line++;
        }
        else if (c === '"' && state === 'start') {
            state = 'quoted';
        }
        else if (c === '"') {
            issue('UNESCAPED_QUOTE', 'A quote occurs inside an unquoted field.');
            cell += c;
            state = 'bare';
        }
        else {
            if (state === 'after')
                issue('TRAILING_QUOTE_DATA', 'Data follows a closing quote before the separator.');
            cell += c;
            state = 'bare';
        }
        invariant(cell.length <= LIMITS.fieldChars, 'A CSV field exceeds 131,072 characters.', 'FIELD_LIMIT');
    }
    if (state === 'quoted')
        issue('UNCLOSED_QUOTE', 'A quoted field reaches the end of the file without closing.');
    if (cells.length || cell.length || state !== 'start')
        row(text.length);
    return { rows, diagnostics, issueCount };
}
// Header names from common contact exports, matched case-insensitively.
const CSV_ALIASES = {
    fn: ['Name', 'Full Name', 'Display Name', 'Formatted Name'], given: ['Given Name', 'First Name', 'First'], family: ['Family Name', 'Last Name', 'Last', 'Surname'],
    org: ['Organization 1 - Name', 'Organization Name', 'Organisation', 'Organization', 'Company'],
    title: ['Organization 1 - Title', 'Job Title', 'Title', 'Role'], note: ['Notes', 'Note', 'Comment'], bday: ['Birthday', 'Birth Date'], nickname: ['Nickname'],
    phone: ['Phone', 'Telephone', 'Mobile Phone'], email: ['Email', 'E-mail', 'Email Address'], street: ['Street', 'Home Street', 'Business Street'],
    city: ['City', 'Home City', 'Business City'], region: ['State', 'Home State', 'Business State'], postal: ['Postal Code', 'Home Postal Code', 'Business Postal Code'],
    country: ['Country', 'Home Country/Region', 'Business Country/Region']
};
export function inferMapping(headers) {
    const mapping = {};
    const lower = headers.map(h => h.trim().toLowerCase());
    for (const [key, aliases] of Object.entries(CSV_ALIASES)) {
        const found = aliases.map(a => lower.indexOf(a.toLowerCase())).find(i => i >= 0);
        if (found !== undefined)
            mapping[key] = found;
    }
    return mapping;
}
/**
 * Reads a CSV contact export as a read-only library. Numbered columns such as
 * `Phone 1 - Value` take their label from the matching `Phone 1 - Type`, `:::` separates
 * several values in one cell, and unmapped columns are kept as extra fields. Each record
 * carries its original headers and cells, so a later conversion can record where it came from.
 * @param {string} text
 * @param {string} [name]
 * @param {string} [id]
 * @param {{delimiter?: string, mapping?: Object<string, number>}} [options] An explicit
 *     mapping replaces the inferred one.
 * @returns {object} The library; `convertible` is true when every row parsed and has a name.
 */
export function parseContactCSV(text, name = 'contacts.csv', id = name, options = {}) {
    const tokenized = tokenizeCSV(text, options.delimiter || ',');
    const { rows, diagnostics } = tokenized;
    let issueCount = tokenized.issueCount, errorCount = tokenized.issueCount;
    const issue = (code, message, line, severity = 'warning') => {
        issueCount++;
        if (severity === 'error')
            errorCount++;
        if (diagnostics.length < LIMITS.diagnostics)
            diagnostics.push({ code, message, line, severity });
    };
    const header = rows[0], headers = header ? header.cells : [], mapping = options.mapping ? { ...options.mapping } : inferMapping(headers);
    for (const [key, index] of Object.entries(mapping))
        invariant(Object.hasOwn(CSV_ALIASES, key) && Number.isInteger(index) && index >= 0 && index < headers.length, 'The column mapping is invalid.', 'MAPPING');
    const lower = headers.map(x => x.trim().toLowerCase()), usedHeader = new Set();
    for (const h of lower) {
        if (usedHeader.has(h))
            issue('DUPLICATE_HEADER', 'Repeated column names need explicit index mapping.', header.lineStart);
        usedHeader.add(h);
    }
    if (!Object.keys(mapping).length && rows.length > 1)
        issue('MAPPING_REQUIRED', 'Choose which columns describe your contacts.', 1);
    const contacts = [], revision = sha256(text);
    let occurrence = new Map();
    for (let r = 1; r < rows.length; r++) {
        const row = rows[r];
        if (row.cells.length !== headers.length)
            issue('ROW_WIDTH', `Row has ${row.cells.length} fields; the header has ${headers.length}.`, row.lineStart, 'error');
        if (row.bad)
            continue;
        const fields = emptyFields(), get = k => mapping[k] === undefined ? '' : (row.cells[mapping[k]] || '');
        for (const key of ['fn', 'given', 'family', 'org', 'title', 'note', 'bday', 'nickname'])
            fields[key] = get(key);
        fields.fn = fields.fn || [fields.given, fields.family].filter(Boolean).join(' ');
        const consumed = new Set(Object.values(mapping));
        const push = (key, value, label) => {
            for (const v of value.split(':::').map(v => v.trim()).filter(Boolean))
                fields[key].push({ value: v, label });
        };
        if (mapping.phone !== undefined)
            push('phones', get('phone'), 'Other');
        if (mapping.email !== undefined)
            push('emails', get('email'), 'Other');
        headers.forEach((h, i) => {
            const labelKey = h.replace(/\bValue\b/i, 'Type'), labelIndex = lower.indexOf(labelKey.trim().toLowerCase()), value = row.cells[i] || '';
            const label = labelIndex !== i && labelIndex >= 0 ? (row.cells[labelIndex] || 'Other') : 'Other';
            if (labelIndex >= 0 && labelIndex !== i)
                consumed.add(labelIndex);
            if (consumed.has(i))
                return;
            if (/^(?:Phone \d+ - Value|Mobile Phone|Home Phone(?: \d+)?|Business Phone(?: \d+)?|Primary Phone|Pager|Other Phone)$/i.test(h.trim())) {
                push('phones', value, label === 'Other' ? h.replace(/ Phone.*$/i, '') : label);
                consumed.add(i);
            }
            else if (/^(?:E-?mail \d+ - Value|E-?mail(?: \d+)? Address)$/i.test(h.trim())) {
                push('emails', value, label);
                consumed.add(i);
            }
            else if (/^(?:Website \d+ - Value|Web Page|Website|URL)$/i.test(h.trim())) {
                push('urls', value, label);
                consumed.add(i);
            }
            else if (/^Address \d+ - Formatted$/i.test(h.trim()) && value) {
                fields.addresses.push({ value, label, components: ['', '', value, '', '', '', ''] });
                consumed.add(i);
            }
        });
        const components = ['', '', get('street'), get('city'), get('region'), get('postal'), get('country')];
        if (components.some(Boolean))
            fields.addresses.push({ value: components.filter(Boolean).join(', '), label: 'Other', components });
        headers.forEach((label, i) => {
            if (!consumed.has(i) && row.cells[i])
                fields.extras.push({ label, value: row.cells[i] });
        });
        fields.csvEvidence = { headers, cells: row.cells };
        const raw = text.slice(row.start, row.end), hash = sha256(raw), n = occurrence.get(hash) || 0;
        occurrence.set(hash, n + 1);
        const c = { id: `${id}:${contacts.length}`, sourceId: id, ordinal: contacts.length, start: row.start, end: row.end, lineStart: row.lineStart, lineEnd: row.lineEnd,
            fields, raw, hash, version: 'CSV', properties: [], issues: [], editable: false, bookmark: sha256(`${id}:raw:${hash}:${n}`), uid: '',
            displayName: fields.fn || fields.org || fields.emails[0]?.value || `Unnamed contact (row ${row.lineStart})` };
        if (!fields.fn)
            issue('MISSING_FN', 'No mapped full name; a fallback is shown.', row.lineStart);
        contacts.push(c);
    }
    return { id, name, format: 'CSV', text, revision, bytes: utf8.encode(text).length, contacts, diagnostics, issueCount, errorCount,
        writable: false, convertible: errorCount === 0 && contacts.every(c => c.fields.fn.trim()), headers, mapping, delimiter: options.delimiter || ',' };
}
