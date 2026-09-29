/**
 * Hard limits shared by the engine, the adapters and the tools. Every parser and query
 * checks against them, so an oversized or hostile file fails with a named error instead
 * of exhausting the tab. The PHP service refuses a configuration that exceeds the
 * source, library and contact ceilings (server/common.php, nexus_config).
 */
export const LIMITS = Object.freeze({ sourceBytes: 20 * 1024 * 1024, sessionBytes: 64 * 1024 * 1024,
    contacts: 50000, sessionContacts: 100000, libraries: 2000, properties: 2048,
    cardBytes: 1024 * 1024, fieldChars: 131072, columns: 256, diagnostics: 200,
    queryChars: 256, groupKeys: 250000, groups: 200000, imageBytes: 524288, imageDimension: 2048, receipts: 1000, receiptBytes: 8 * 1024 * 1024 });
export const utf8 = new TextEncoder();
/**
 * Throws when a condition fails. Callers branch on the stable `code`, never on the message.
 * @param {unknown} condition
 * @param {string} message Shown to the user.
 * @param {string} [code='INVALID_INPUT']
 * @throws {Error} With `code` set.
 */
export function invariant(condition, message, code = 'INVALID_INPUT') {
    if (!condition) {
        const error = new Error(message);
        error.code = code;
        throw error;
    }
}
/**
 * Accepts a plain library filename: 1 to 180 characters ending in .vcf or .csv, with no
 * path separator, control or reserved character, leading dot or surrounding space.
 * Matches nexus_valid_name() in server/common.php, so the browser and the server agree
 * on what a library name is.
 * @param {string} value
 * @param {'vcf'|'csv'} [extension] Required extension, when given.
 * @returns {string} The name, unchanged.
 * @throws {Error} BAD_FILENAME
 */
export function safeFilename(value, extension) {
    invariant(typeof value === 'string' && value.length > 0 && value.length <= 180 &&
        !/[\x00-\x1f\x7f/\\<>:"|?*]/.test(value) && !value.startsWith('.') &&
        value.trim() === value && /\.(vcf|csv)$/i.test(value), 'Use a plain .vcf or .csv filename.', 'BAD_FILENAME');
    if (extension)
        invariant(value.toLowerCase().endsWith(`.${extension}`), `A .${extension} filename is required.`, 'BAD_FILENAME');
    return value;
}
/**
 * Decodes strict UTF-8. Another encoding is refused rather than guessed, because a wrong
 * guess would be saved back as corrupted text. The byte-order mark stays in the text so
 * an unedited source is written back byte for byte.
 * @param {Uint8Array} bytes
 * @returns {string}
 * @throws {Error} SOURCE_LIMIT or ENCODING
 */
export function decodeBytes(bytes) {
    invariant(bytes.byteLength <= LIMITS.sourceBytes, 'The source exceeds the 20 MiB limit.', 'SOURCE_LIMIT');
    try {
        return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    }
    catch {
        invariant(false, 'This file is not valid UTF-8. Convert a copy explicitly before opening it.', 'ENCODING');
    }
}
/**
 * Validates text that did not pass through decodeBytes(). NUL and unpaired surrogates are
 * refused because they cannot be encoded back to the same UTF-8 bytes.
 * @param {string} text
 * @returns {string}
 * @throws {Error} SOURCE_LIMIT or ENCODING
 */
export function checkedText(text) {
    invariant(typeof text === 'string', 'Source content must be text.');
    invariant(text.length <= LIMITS.sourceBytes && utf8.encode(text).length <= LIMITS.sourceBytes, 'The source exceeds the 20 MiB limit.', 'SOURCE_LIMIT');
    invariant(!text.includes('\0') && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(text), 'The source contains NUL or unpaired Unicode characters.', 'ENCODING');
    return text;
}
// Round constants, FIPS 180-4 section 4.2.2.
const SHA_K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
]);
/**
 * SHA-256 as lower-case hex, per FIPS 180-4: https://csrc.nist.gov/pubs/fips/180-4/upd1/final
 * Implemented here because Web Crypto is only available in secure contexts and is
 * asynchronous, while the engine is synchronous and a private host may serve plain HTTP.
 * Library revisions computed here are compared with PHP's hash('sha256').
 * @param {string|Uint8Array} input A string is hashed as its UTF-8 bytes.
 * @returns {string}
 */
export function sha256(input) {
    const bytes = typeof input === 'string' ? utf8.encode(input) : input;
    const size = Math.ceil((bytes.length + 9) / 64) * 64;
    const padded = new Uint8Array(size);
    padded.set(bytes);
    padded[bytes.length] = 128;
    const dv = new DataView(padded.buffer);
    dv.setUint32(size - 8, Math.floor(bytes.length / 0x20000000));
    dv.setUint32(size - 4, bytes.length * 8 >>> 0);
    const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
    const w = new Uint32Array(64), rr = (x, n) => (x >>> n) | (x << (32 - n));
    for (let off = 0; off < size; off += 64) {
        for (let i = 0; i < 16; i++)
            w[i] = dv.getUint32(off + i * 4);
        for (let i = 16; i < 64; i++) {
            const x = w[i - 15], y = w[i - 2];
            w[i] = (w[i - 16] + (rr(x, 7) ^ rr(x, 18) ^ (x >>> 3)) + w[i - 7] + (rr(y, 17) ^ rr(y, 19) ^ (y >>> 10))) >>> 0;
        }
        let [a, b, c, d, e, f, g, z] = h;
        for (let i = 0; i < 64; i++) {
            const t1 = (z + (rr(e, 6) ^ rr(e, 11) ^ rr(e, 25)) + ((e & f) ^ (~e & g)) + SHA_K[i] + w[i]) >>> 0;
            const t2 = ((rr(a, 2) ^ rr(a, 13) ^ rr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
            z = g;
            g = f;
            f = e;
            e = (d + t1) >>> 0;
            d = c;
            c = b;
            b = a;
            a = (t1 + t2) >>> 0;
        }
        [a, b, c, d, e, f, g, z].forEach((v, i) => {
            h[i] = (h[i] + v) >>> 0;
        });
    }
    return [...h].map(x => x.toString(16).padStart(8, '0')).join('');
}
/** Maps Arabic-Indic, Persian and full-width digits to ASCII so numbers written in those scripts still match. */
export function asciiDigits(value) {
    return String(value).replace(/[\u0660-\u0669\u06f0-\u06f9\uff10-\uff19]/g, c => String(c.charCodeAt(0) - (c >= '\uff10' ? 0xff10 : c >= '\u06f0' ? 0x6f0 : 0x660)));
}
/**
 * Builds the comparison key for a phone number: `international:` or `local:`, the digits,
 * then `;ext=` and any extension. Spaces, brackets, dots, hyphens and a `tel:` prefix are
 * ignored. Local and international forms stay different keys, because adding a country
 * code to a local number would be a guess.
 * @param {string} raw
 * @returns {string} The key, or '' when the value is not 3 to 15 digits (the E.164 maximum,
 *     https://www.itu.int/rec/T-REC-E.164).
 */
export function phoneKey(raw) {
    let value = asciiDigits(raw).trim().replace(/^tel:/i, '');
    let extension = '';
    const match = value.match(/(?:;ext=|\s+(?:ext\.?|x)\s*|\s*x)(\d{1,8})$/i);
    if (match) {
        extension = match[1];
        value = value.slice(0, match.index);
    }
    value = value.replace(/[\s().-]/g, '');
    if (!/^(?:\+|00)?\d{3,15}$/.test(value))
        return '';
    const international = value.startsWith('+') || value.startsWith('00');
    const digits = value.startsWith('+') ? value.slice(1) : value.startsWith('00') ? value.slice(2) : value;
    if (digits.length < 3 || digits.length > 15 || (international && digits.startsWith('0')))
        return '';
    return `${international ? 'international' : 'local'}:${digits}${extension ? `;ext=${extension}` : ''}`;
}
/**
 * Comparison key for an email address, or '' when the value is not address-shaped.
 * The whole address is lower-cased. RFC 5321 section 2.4 lets the local part be
 * case-sensitive, but most providers treat it as case-insensitive, and the key only groups
 * records for review: https://www.rfc-editor.org/rfc/rfc5321#section-2.4
 * @param {string} value
 * @returns {string}
 */
export function emailKey(value) {
    const s = String(value).trim();
    return s.length <= 254 && /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(s) ? s.normalize('NFC').toLowerCase() : '';
}
/** Folds case and strips combining marks after NFKD decomposition, so `André` matches `andre`. */
export function searchText(value) {
    return String(value).normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
}
/**
 * Escapes a text value per RFC 6350 section 3.4: https://www.rfc-editor.org/rfc/rfc6350#section-3.4
 * Control characters other than line breaks are refused because they have no escaped form.
 * @param {string} value
 * @returns {string}
 * @throws {Error} FIELD_LIMIT or INVALID_INPUT
 */
export function escapeVCard(value) {
    invariant(typeof value === 'string' && value.length <= LIMITS.fieldChars, 'A field exceeds its size limit.', 'FIELD_LIMIT');
    invariant(!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value), 'A field contains control characters.');
    return value.replace(/\\/g, '\\\\').replace(/\r\n|\r|\n/g, '\\n').replace(/;/g, '\\;').replace(/,/g, '\\,');
}
export function unescapeVCard(value) {
    return value.replace(/\\([nN,;\\])/g, (_, c) => c === 'n' || c === 'N' ? '\n' : c);
}
/**
 * Splits a structured value (N, ADR, ORG) on separators that are not escaped, per RFC 6350
 * section 3.3. Escapes are kept, so each component is unescaped exactly once afterwards.
 * @param {string} value
 * @param {string} [separator=';']
 * @returns {string[]}
 */
export function splitEscaped(value, separator = ';') {
    const values = [];
    let token = '', slash = false;
    for (const c of value) {
        if (c === separator && !slash) {
            values.push(token);
            token = '';
        }
        else
            token += c;
        if (c === '\\')
            slash = !slash;
        else
            slash = false;
    }
    values.push(token);
    return values;
}
/**
 * Folds a content line at 75 octets, per RFC 6350 section 3.2, without splitting a UTF-8
 * character: https://www.rfc-editor.org/rfc/rfc6350#section-3.2
 * @param {string} line
 * @param {string} [newline='\r\n'] The library's own line ending.
 * @returns {string} The folded line, terminated.
 */
export function foldLine(line, newline = '\r\n') {
    const parts = [];
    let row = '', length = 0;
    for (const c of line) {
        const n = utf8.encode(c).length;
        if (length + n > 75) {
            parts.push(row);
            row = ' ';
            length = 1;
        }
        row += c;
        length += n;
    }
    parts.push(row);
    return parts.join(newline) + newline;
}
/** Returns a link only for http or https without embedded credentials, so a stored URL cannot open another scheme from the contact sheet. */
export function safeURL(value) {
    try {
        const url = new URL(String(value));
        return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
    }
    catch {
        return null;
    }
}
/**
 * Quotes one CSV cell. With the guard on, a value a spreadsheet would run as a formula
 * (leading =, +, - or @) is prefixed with an apostrophe:
 * https://owasp.org/www-community/attacks/CSV_Injection
 * @param {unknown} value
 * @param {boolean} [guard=true] Off only for fixtures that must reproduce a source exactly.
 * @returns {string}
 */
export function csvCell(value, guard = true) {
    let text = String(value ?? '');
    if (guard && /^[\s\u0000-\u001f]*[=+@-]/.test(text))
        text = "'" + text;
    return '"' + text.replace(/"/g, '""') + '"';
}
