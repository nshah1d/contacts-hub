import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { sha256, phoneKey, emailKey, foldLine, escapeVCard, unescapeVCard, safeFilename, decodeBytes, safeURL, csvCell, utf8 } from '../public/js/core/primitives.js';
import { parseVCard, newVCard, patchCard, emptyFields } from '../public/js/core/vcard.js';
import { tokenizeCSV, parseContactCSV } from '../public/js/core/csv.js';
import { parseLibrary, ContactEngine, matchGroups, queryContacts, detailOf, planChange, combineDetails, convertLibrary, exportEvidence, exportTable } from '../public/js/core/engine.js';
const card = (lines = [], name = 'Amira Khan') => ['BEGIN:VCARD', 'VERSION:3.0', `FN:${name}`, ...lines, 'END:VCARD', ''].join('\r\n');
const example = () => parseLibrary(card(['UID:one', 'N:Khan;Amira;;;', 'ORG:Northstar;Design', 'TEL;TYPE=CELL:+44 7700 900123', 'EMAIL;TYPE=WORK:amira@example.com', 'BDAY:1990-06-15', 'PHOTO;ENCODING=b;TYPE=PNG:aGVsbG8=', 'X-PRIVATE:keep\\, exact', 'item9.URL:https://example.com/a:b', 'item9.X-ABLabel:Portfolio']), 'Personal.vcf');
for (const input of ['', 'abc', 'hello\r\n', 'مرحبا 世界', 'a'.repeat(1000), '\uFEFFBEGIN:VCARD'])
    test(`SHA-256 exact bytes: ${input.length} characters`, () => assert.equal(sha256(input), crypto.createHash('sha256').update(input).digest('hex')));
test('SHA-256 generated binary vectors', () => {
    for (let n = 0; n < 257; n++) {
        const bytes = crypto.randomBytes(n * 3);
        assert.equal(sha256(bytes), crypto.createHash('sha256').update(bytes).digest('hex'));
    }
});
for (const [a, b] of [['+44 7700 900123', '0044-7700-900123'], ['+٤٤٧٧٠٠٩٠٠١٢٣', '+447700900123'], ['tel:+447700900123;ext=20', '+447700900123 x20']])
    test(`phone equivalent ${a}`, () => assert.equal(phoneKey(a), phoneKey(b)));
for (const [a, b] of [['07700900123', '+447700900123'], ['+447700900123 x20', '+447700900123 x21'], ['447700900123', '+447700900123']])
    test(`phone keeps distinction ${a}`, () => assert.notEqual(phoneKey(a), phoneKey(b)));
for (const raw of ['', '---', '+', 'call me', '555@evil.test', '123;phone-context=example.com', '+012345', '1234567890123456'])
    test(`invalid phone ${raw}`, () => assert.equal(phoneKey(raw), ''));
test('email comparison case-folds only for candidate matching', () => {
    assert.equal(emailKey('Amira@Example.COM'), 'amira@example.com');
    assert.equal(emailKey('x\n@y.example'), '');
});
test('UTF-8 decoder retains BOM', () => assert.equal(decodeBytes(utf8.encode('\uFEFFabc')), '\uFEFFabc'));
test('invalid UTF-8 is rejected', () => assert.throws(() => decodeBytes(new Uint8Array([0xc0, 0xaf])), /valid UTF-8/));
test('source NUL is rejected', () => assert.throws(() => parseLibrary(card(['NOTE:x\0y']), 'a.vcf')));
for (const value of ['../a.vcf', 'a\\b.vcf', 'a.php', '.vcf', 'bad\n.vcf', ' a.vcf', 'a:.vcf'])
    test(`unsafe filename ${JSON.stringify(value)}`, () => assert.throws(() => safeFilename(value)));
test('ordinary Unicode filename is accepted', () => assert.equal(safeFilename('أصدقاء 2026.VCF'), 'أصدقاء 2026.VCF'));
test('URL scheme guards', () => {
    for (const u of ['javascript:alert(1)', 'data:text/html,hi', 'file:///etc/passwd', 'https://user:secret@example.com'])
        assert.equal(safeURL(u), null);
    assert.equal(safeURL('https://example.com'), 'https://example.com/');
});
test('CSV formula guard includes leading controls', () => {
    assert.equal(csvCell('\t=1+1'), '"\'\t=1+1"');
    assert.equal(csvCell('normal'), '"normal"');
});
test('vCard text escaping roundtrip', () => {
    const value = 'a\\b, c;\n世界';
    assert.equal(unescapeVCard(escapeVCard(value)), value);
});
test('line folding respects 75 UTF-8 bytes and codepoints', () => {
    const value = 'NOTE:' + '界'.repeat(120);
    const folded = foldLine(value);
    for (const line of folded.trimEnd().split('\r\n'))
        assert.ok(utf8.encode(line).length <= 75);
    assert.equal(folded.replace(/\r\n /g, '').trimEnd(), value);
});
test('VCF supports space and tab continuations', () => {
    const lib = parseLibrary(card(['NOTE:one\r\n two\r\n\tthree']), 'a.vcf');
    assert.equal(lib.contacts[0].fields.note, 'onetwothree');
});
test('QP UTF-8 characters decode without destroying literal percent', () => {
    const lib = parseLibrary(card(['NOTE;ENCODING=QUOTED-PRINTABLE:100% =E4=B8=96=E7=95=8C']), 'a.vcf');
    assert.equal(lib.contacts[0].fields.note, '100% 世界');
});
test('QP soft line breaks', () => {
    const lib = parseLibrary(card(['FN;ENCODING=QUOTED-PRINTABLE:Am=\r\nira'], ''), 'a.vcf');
    assert.equal(lib.contacts[0].properties.find(p => p.params.ENCODING).value, 'Amira');
});
test('malformed QP remains visible and blocks writes', () => {
    const lib = parseLibrary(card(['NOTE;ENCODING=QUOTED-PRINTABLE:=ZZ']), 'a.vcf');
    assert.equal(lib.contacts[0].fields.note, '=ZZ');
    assert.equal(lib.writable, false);
});
test('custom groups and quoted parameter colons are parsed', () => {
    const c = parseLibrary(card(['alpha.TEL;TYPE="work:desk":+447700900123', 'alpha.X-ABLabel:Switchboard']), 'a.vcf').contacts[0];
    assert.equal(c.fields.phones[0].label, 'Switchboard');
});
test('escaped address delimiters retain seven components', () => {
    const c = parseLibrary(card(['ADR;TYPE=HOME:;;Suite 2\\; west;City;Region;001;Country']), 'a.vcf').contacts[0];
    assert.equal(c.fields.addresses[0].components[2], 'Suite 2; west');
});
test('vCard 4 is readable and editable', () => {
    const l = parseLibrary(card(['TEL;VALUE=uri:tel:+447700900123']).replace('VERSION:3.0', 'VERSION:4.0'), 'a.vcf');
    assert.equal(l.writable, true);
    assert.equal(l.contacts[0].phoneKeys[0], 'international:447700900123');
});
test('vCard 2.1 is retained read-only', () => {
    const l = parseLibrary(card().replace('VERSION:3.0', 'VERSION:2.1'), 'a.vcf');
    assert.equal(l.contacts.length, 1);
    assert.equal(l.writable, false);
});
test('missing END is diagnosed rather than silently accepted', () => {
    const l = parseLibrary(card().replace('END:VCARD', ''), 'a.vcf');
    assert.equal(l.writable, false);
    assert.equal(l.contacts.length, 1);
});
test('text outside cards is retained and blocks writes', () => {
    const l = parseLibrary('stray\n' + card(), 'a.vcf');
    assert.equal(l.writable, false);
    assert.ok(l.text.startsWith('stray'));
});
test('nested BEGIN does not swallow either card', () => {
    const l = parseLibrary(card().replace('END:VCARD', '') + card([], 'Ben'), 'a.vcf');
    assert.equal(l.contacts.length, 2);
    assert.equal(l.writable, false);
});
test('unknown properties remain source evidence', () => assert.ok(example().contacts[0].properties.some(p => p.name === 'X-PRIVATE')));
test('unchanged patch is byte-for-byte exact', () => {
    const l = example(), c = l.contacts[0];
    assert.equal(patchCard(l, c, { fn: c.fields.fn, phones: c.fields.phones }), c.raw);
});
test('one field edit preserves every unrelated property and next card', () => {
    const l = parseLibrary(example().text + card(['UID:two'], 'Ben'), 'a.vcf');
    const c = l.contacts[0];
    const p = planChange(l, { kind: 'edit', id: c.id, recordHash: c.hash, baseRevision: l.revision, changes: { title: 'New title' } });
    for (const prop of c.properties)
        assert.ok(p.content.includes(prop.raw));
    assert.ok(p.content.endsWith(l.contacts[1].raw));
});
test('edited name cannot inject a new vCard', () => {
    const l = example(), c = l.contacts[0];
    const p = planChange(l, { kind: 'edit', id: c.id, recordHash: c.hash, baseRevision: l.revision, changes: { fn: 'New\nEND:VCARD\nBEGIN:VCARD' } });
    assert.equal(parseLibrary(p.content, l.name).contacts.length, 1);
});
test('phone edits retain untouched phone properties and labels', () => {
    const l = parseLibrary(card(['item1.TEL;TYPE=CELL:+447700900123', 'item1.X-ABLabel:Personal', 'item2.TEL;TYPE=WORK:+447700900124', 'item2.X-ABLabel:Desk']), 'a.vcf'), c = l.contacts[0];
    const entries = c.fields.phones.map(e => ({ ...e }));
    entries[0].value = '+447700900125';
    const raw = patchCard(l, c, { phones: entries });
    assert.ok(raw.includes('item2.TEL;TYPE=WORK:+447700900124\r\n'));
    assert.ok(raw.includes('item1.X-ABLabel:Personal'));
});
test('changing a grouped label updates its source label without orphaning the group', () => {
    const l = parseLibrary(card(['item1.TEL;TYPE=CELL:+447700900123', 'item1.X-ABLabel:Personal']), 'a.vcf'), c = l.contacts[0];
    const entries = c.fields.phones.map(e => ({ ...e, label: 'Direct' }));
    const raw = patchCard(l, c, { phones: entries });
    assert.match(raw, /item1\.TEL;TYPE=CELL:\+447700900123/);
    assert.match(raw, /item1\.X-ABLabel:Direct/);
    assert.doesNotMatch(raw, /Personal/);
});
test('changing an ungrouped TYPE label creates one explicit labelled group', () => {
    const l = parseLibrary(card(['TEL;TYPE=WORK:+447700900123']), 'a.vcf'), c = l.contacts[0];
    const entries = c.fields.phones.map(e => ({ ...e, label: 'Direct' }));
    const raw = patchCard(l, c, { phones: entries });
    assert.match(raw, /nexus1\.TEL:\+447700900123/);
    assert.match(raw, /nexus1\.X-ABLabel:Direct/);
    assert.doesNotMatch(raw, /TYPE=WORK/);
});
test('removing the only grouped value removes its label but preserves unrelated groups', () => {
    const l = parseLibrary(card(['item1.TEL:+447700900123', 'item1.X-ABLabel:Personal', 'item2.URL:https://example.com', 'item2.X-ABLabel:Site']), 'a.vcf'), c = l.contacts[0];
    const raw = patchCard(l, c, { phones: [] });
    assert.doesNotMatch(raw, /item1\./);
    assert.match(raw, /item2\.URL:https:\/\/example\.com/);
    assert.match(raw, /item2\.X-ABLabel:Site/);
});
test('new properties preserve a CR-only source line ending', () => {
    const text = card([], 'Amira').replace(/\r\n/g, '\r'), l = parseLibrary(text, 'a.vcf'), c = l.contacts[0];
    const raw = patchCard(l, c, { title: 'Engineer' });
    assert.ok(raw.includes('\rTITLE:Engineer\rEND:VCARD\r'));
    assert.ok(!raw.includes('\n'));
});
test('phone labels with punctuation are encoded as values', () => {
    const l = example(), c = l.contacts[0];
    const raw = patchCard(l, c, { phones: [...c.fields.phones, { value: '123456', label: 'Home;\nEND:VCARD' }] });
    assert.equal(parseLibrary(raw, 'a.vcf').contacts.length, 1);
});
test('source property IDs cannot be invented', () => {
    const l = example();
    assert.throws(() => patchCard(l, l.contacts[0], { phones: [{ pid: 999, value: '1234', label: 'x' }] }));
});
test('source property IDs cannot be used twice', () => {
    const l = example(), p = l.contacts[0].fields.phones[0];
    assert.throws(() => patchCard(l, l.contacts[0], { phones: [p, p] }));
});
test('unsupported change keys cannot alter source metadata', () => {
    const l = example();
    assert.throws(() => patchCard(l, l.contacts[0], { __proto__: null, raw: 'malicious' }));
});
test('stale library revision fails before a change', () => {
    const l = example();
    assert.throws(() => planChange(l, { kind: 'delete', id: l.contacts[0].id, baseRevision: 'old' }), /older/);
});
test('stale record hash fails before a change', () => {
    const l = example();
    assert.throws(() => planChange(l, { kind: 'delete', id: l.contacts[0].id, baseRevision: l.revision, recordHash: 'old' }), /changed/);
});
test('deleting the final card produces an editable empty library', () => {
    const l = example(), c = l.contacts[0];
    const p = planChange(l, { kind: 'delete', id: c.id, baseRevision: l.revision, recordHash: c.hash });
    assert.equal(p.afterCount, 0);
    assert.equal(p.content, '');
});
test('duplicate number repeated inside one contact is not a match', () => {
    const l = parseLibrary(card(['TEL:+447700900123', 'TEL:00447700900123']), 'a.vcf');
    assert.equal(matchGroups(l.contacts).length, 0);
});
test('different people sharing a number are candidates, not merged', () => {
    const l = parseLibrary(card(['TEL:+447700900123']) + card(['TEL:00447700900123'], 'Ben'), 'a.vcf');
    assert.equal(matchGroups(l.contacts).length, 1);
    assert.equal(l.contacts.length, 2);
});
test('matching email works across open sources', () => {
    const a = example(), b = parseLibrary(card(['EMAIL:AMIRA@EXAMPLE.COM'], 'A. Khan'), 'other.vcf');
    assert.equal(matchGroups([...a.contacts, ...b.contacts]).length, 1);
});
test('review queries identify shared details without materialising unrelated groups', () => {
    const a = parseLibrary(card(['TEL:+447700900123']) + card(['TEL:+447700900124'], 'Other'), 'a.vcf');
    const b = parseLibrary(card(['TEL:00447700900123'], 'Peer'), 'b.vcf');
    assert.equal(queryContacts([a, b], { sourceId: 'a.vcf', filter: 'review' }).total, 1);
    const detail = detailOf([a, b], a.contacts[0].id);
    assert.equal(detail.matchGroups.length, 1);
    assert.equal(detail.peerCount, 1);
});
test('search handles multiple literal tokens and never interprets patterns', () => {
    const l = example();
    assert.equal(queryContacts([l], { query: 'amira northstar' }).total, 1);
    assert.equal(queryContacts([l], { query: '[.*]' }).total, 0);
});
test('empty organisation units leave no dangling separator', () => {
    const l = parseLibrary(card(['ORG:Mirage Rent A Car;']) + card(['ORG:Acme;;Sales'], 'Ben Ode'), 'a.vcf');
    assert.equal(l.contacts[0].fields.org, 'Mirage Rent A Car');
    assert.equal(l.contacts[1].fields.org, 'Acme · Sales');
    assert.ok(l.text.includes('ORG:Mirage Rent A Car;'));
});
test('in-order letters match within one field only', () => {
    const l = parseLibrary(card(['ORG:Provis', 'NOTE:long notes about many different subjects and places'], 'Aadil Muhammad') + card(['ORG:Northstar'], 'Ben Ode'), 'a.vcf');
    assert.equal(queryContacts([l], { query: 'adlmhd' }).total, 1);
    assert.equal(queryContacts([l], { query: 'prvs' }).total, 1);
    assert.equal(queryContacts([l], { query: 'aadil provis' }).total, 1);
    assert.equal(queryContacts([l], { query: 'bnprv' }).total, 0);
    assert.equal(queryContacts([l], { query: 'mnysbj' }).total, 0);
});
test('phone digits still match formatted numbers', () => {
    const l = parseLibrary(card(['TEL:+44 7700 900123']), 'a.vcf');
    assert.equal(queryContacts([l], { query: '7700900' }).total, 1);
    assert.equal(queryContacts([l], { query: '900123' }).total, 1);
});
test('accent-insensitive search leaves source text unchanged', () => {
    const l = parseLibrary(card([], 'José García'), 'a.vcf');
    assert.equal(queryContacts([l], { query: 'jose garcia' }).total, 1);
    assert.ok(l.text.includes('José'));
});
test('query windows stay bounded and alphabet targets cover all results', () => {
    let text = '';
    for (let i = 0; i < 200; i++)
        text += card([], `Name ${i.toString().padStart(3, '0')}`);
    const l = parseLibrary(text, 'a.vcf');
    const q = queryContacts([l], { offset: 180, limit: 10 });
    assert.equal(q.total, 200);
    assert.equal(q.items.length, 10);
    assert.equal(q.alpha[0].index, 0);
});
test('my-card pinning does not mutate the source or lose counts', () => {
    const l = parseLibrary(card([], 'Zulu') + card([], 'Amira'), 'a.vcf'), before = l.contacts.map(c => c.id);
    const q = queryContacts([l], { myCard: l.contacts[0].bookmark });
    assert.equal(q.items[0].name, 'Zulu');
    assert.equal(q.total, 2);
    assert.deepEqual(l.contacts.map(c => c.id), before);
});
test('CSV preserves quoted commas, double quotes and blank embedded lines', () => {
    const t = tokenizeCSV('Name,Notes\r\n"Khan, Amira","a\r\n\r\n""quote"""\r\n');
    assert.deepEqual(t.rows[1].cells, ['Khan, Amira', 'a\r\n\r\n"quote"']);
});
test('CSV unclosed quotes are reported', () => assert.ok(tokenizeCSV('Name,Notes\nAmira,"unfinished').diagnostics.some(d => d.code === 'UNCLOSED_QUOTE')));
test('CSV row width mismatch disables conversion', () => assert.equal(parseContactCSV('Name,Email\nAmira,a@example.com,extra', 'a.csv').convertible, false));
test('CSV full-name-only rows are retained', () => assert.equal(parseContactCSV('Name,Email\nAmira,a@example.com', 'a.csv').contacts.length, 1));
test('CSV rows without names remain visible', () => {
    const l = parseContactCSV('Email Address\na@example.com', 'a.csv');
    assert.equal(l.contacts.length, 1);
    assert.ok(l.diagnostics.some(d => d.code === 'MISSING_FN'));
});
test('Google numbered columns preserve labels and multi-values', () => {
    const c = parseContactCSV('Name,Phone 1 - Type,Phone 1 - Value,E-mail 1 - Type,E-mail 1 - Value\nAmira,Work,1234 ::: 5678,Home,a@example.com', 'a.csv').contacts[0];
    assert.equal(c.fields.phones.length, 2);
    assert.equal(c.fields.phones[0].label, 'Work');
    assert.equal(c.fields.emails[0].label, 'Home');
});
test('Outlook field aliases map structured names and phones', () => {
    const c = parseContactCSV('First Name,Last Name,Company,Business Phone,E-mail Address\nAmira,Khan,Northstar,12345,a@example.com', 'a.csv').contacts[0];
    assert.equal(c.fields.fn, 'Amira Khan');
    assert.equal(c.fields.phones[0].value, '12345');
});
test('explicit separator and index mapping', () => {
    const l = parseContactCSV('Person;Desk\nAmira;1234', 'a.csv', 'a.csv', { delimiter: ';', mapping: { fn: 0, phone: 1 } });
    assert.equal(l.contacts[0].fields.fn, 'Amira');
    assert.equal(l.contacts[0].fields.phones[0].value, '1234');
});
test('unknown CSV columns are retained in conversion evidence', () => {
    const l = parseLibrary('Name,Custom\nAmira,Secret reference', 'a.csv');
    const out = convertLibrary(l, 'copy.vcf');
    assert.ok(out.content.includes('X-NEXUS-CSV-ROW'));
    const parsed = parseLibrary(out.content, 'copy.vcf');
    assert.ok(parsed.contacts[0].fields.extras.some(e => e.label === 'X-NEXUS-CSV-ROW' && e.value.includes('Secret reference')));
});
test('CSV import never silently drops same-name contacts', () => {
    const target = parseLibrary(card(['EMAIL:a@example.com'], 'Amira'), 'target.vcf'), source = parseLibrary('Name,Email\nAmira,b@example.com\nAmira,a@example.com', 'source.csv');
    const p = planChange(target, { kind: 'import', baseRevision: target.revision, uid: 'test', selected: source.contacts.map(c => ({ id: c.id, revision: source.revision })) }, [source]);
    assert.equal(p.afterCount, 3);
});
test('failed import keeps engine state unchanged', () => {
    const e = new ContactEngine();
    e.open({ text: card(), name: 'a.vcf' });
    const l = e.libraries.get('a.vcf');
    assert.throws(() => e.handle('plan', { sourceId: 'a.vcf', kind: 'import', baseRevision: l.revision, selected: [{ id: 'missing', revision: 'x' }] }));
    assert.equal(e.libraries.get('a.vcf').revision, l.revision);
});
test('enrichment retains conflicts and both original records', () => {
    const a = example().contacts[0], b = parseLibrary(card(['ORG:Other', 'TEL:1234567'], 'Other'), 'b.vcf').contacts[0];
    const result = combineDetails(a, b);
    assert.equal(result.retainsBothRecords, true);
    assert.equal(result.conflicts[0].field, 'org');
    assert.equal(result.changes.phones.length, 2);
    assert.equal(a.fields.phones.length, 1);
});
test('evidence exports contain original spans and hashes', () => {
    const l = example(), out = JSON.parse(exportEvidence(l));
    assert.equal(out.source.sha256, sha256(l.text));
    assert.equal(out.contacts[0].raw, l.contacts[0].raw);
});
test('table export guards formula-shaped names', () => {
    const l = parseLibrary(card([], '=cmd'), 'a.vcf');
    assert.ok(exportTable(l).includes('"\'=cmd"'));
});
test('engine rejects unknown operations', () => assert.throws(() => new ContactEngine().handle('magic')));
test('generated edit roundtrips preserve opaque properties', () => {
    for (let i = 0; i < 250; i++) {
        const l = parseLibrary(card([`X-OPAQUE:value-${i}`, `NOTE:source-${i}`], `Person ${i}`), 'a.vcf'), c = l.contacts[0];
        const raw = patchCard(l, c, { fn: `Renamed ${i}`, note: `Line 1\nLine 2; ${i}, 世界` });
        const newLib = parseLibrary(raw, 'a.vcf');
        assert.equal(newLib.contacts.length, 1);
        assert.equal(newLib.contacts[0].fields.fn, `Renamed ${i}`);
        assert.ok(raw.includes(`X-OPAQUE:value-${i}\r\n`));
    }
});
test('new URL values retain URI separators rather than text-escaping them', () => {
    const f = emptyFields();
    f.fn = 'URI';
    f.urls = [{ label: 'Website', value: 'https://example.com/a;b?x=1,2' }];
    const card = newVCard(f, 'uri');
    assert.match(card, /URL:https:\/\/example.com\/a;b\?x=1,2/);
    assert.ok(!card.includes('a\\;b'));
});
test('URL edits reject line injection', () => {
    const f = emptyFields();
    f.fn = 'URI';
    f.urls = [{ label: 'Website', value: 'https://example.com/\r\nFN:Injected' }];
    assert.throws(() => newVCard(f, 'uri'), /control/);
});
test('selective import refuses VCF rather than dropping unmodelled fields', () => {
    const target = example(), source = parseLibrary(card(['X-CUSTOM:keep'], 'Other'), 'other.vcf');
    assert.throws(() => planChange(target, { kind: 'import', baseRevision: target.revision, selected: [{ id: source.contacts[0].id, revision: source.revision }] }, [source]), { code: 'IMPORT_FORMAT' });
});
