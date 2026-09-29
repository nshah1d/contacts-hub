import { readInput } from './io.mjs';
import { isDeepStrictEqual } from 'node:util';
import { parseLibrary, exportEvidence, matchGroups } from '../public/js/core/engine.js';
import { invariant, sha256 } from '../public/js/core/primitives.js';
/** Flattens a parsed library into the rows that tools/sqlite.py loads. */
export function relational(lib) {
    const groups = matchGroups(lib.contacts);
    return { schemaVersion: 1,
        source: { id: lib.id, name: lib.name, format: lib.format, sha256: lib.revision, bytes: lib.bytes, text: lib.text, interpretation: lib.format === 'CSV' ? { mapping: lib.mapping, delimiter: lib.delimiter } : null },
        contacts: lib.contacts.map(c => ({ id: c.id, source_id: lib.id, ordinal: c.ordinal + 1, name: c.displayName, organisation: c.fields.org, title: c.fields.title, note: c.fields.note,
            source_line_start: c.lineStart, source_line_end: c.lineEnd, record_sha256: c.hash, raw: c.raw })),
        values: lib.contacts.flatMap(c => ['phones', 'emails', 'addresses', 'urls'].flatMap(kind => c.fields[kind].map((v, i) => ({ contact_id: c.id, kind, ordinal: i + 1, label: v.label, value: v.value, components: v.components || null })))),
        properties: lib.contacts.flatMap(c => c.properties.map(p => ({ contact_id: c.id, ordinal: p.index + 1, name: p.name, group: p.group, value: p.value, raw: p.raw, source_line: p.line }))),
        groups, findings: lib.diagnostics, issueCount: lib.issueCount };
}
try {
    const { bytes } = await readInput(process.argv[2], 128 * 1024 * 1024);
    const input = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes));
    invariant(input?.schemaVersion === 1 && typeof input.source?.text === 'string' && sha256(input.source.text) === input.source.sha256, 'Evidence source checksum is invalid.');
    invariant(typeof input.source.id === 'string' && input.source.id.length <= 540, 'Invalid source identifier.');
    // Rows are produced only when the evidence is identical to a fresh parse of the source it embeds.
    const lib = parseLibrary(input.source.text, input.source.name, input.source.id, input.source.interpretation || {}), expected = JSON.parse(exportEvidence(lib));
    invariant(isDeepStrictEqual(input, expected), 'Evidence differs from a fresh parse of its original source. No database was produced.');
    process.stdout.write(JSON.stringify(relational(lib)));
}
catch (error) {
    console.error(error.message);
    process.exitCode = 1;
}
