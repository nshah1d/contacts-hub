import { newVCard, emptyFields } from '../public/js/core/vcard.js';
import { csvCell } from '../public/js/core/primitives.js';
export function sampleCard(name, extra = {}) {
    return { ...emptyFields(), fn: name, given: name.split(' ')[0], family: name.split(' ').slice(1).join(' '), ...extra };
}
/** Synthetic libraries for tests: shared details, an opaque property, an Arabic and a Chinese name, and a CSV with extra columns. */
export function fixtureLibraries() {
    const people = [['Amira Khan', 'Product designer', 'Northline Studio'], ['André Laurent', 'Structural engineer', 'Atelier Common'], ['Ben Carter', 'Technical writer', 'Field Notes'], ['Celia Ramos', 'Research lead', 'Northline Studio'], ['Daniel Okafor', 'Software engineer', 'Common Ground'], ['Elena Petrova', 'Editor', 'Field Notes'], ['Farah Mansour', 'Architect', 'Atelier Common'], ['George Chen', 'Photographer', 'Independent'], ['Hana Mori', 'Interaction designer', 'Northline Studio'], ['Ibrahim Hassan', 'Producer', 'Common Ground'], ['Jamie Wallace', 'Data engineer', 'Independent'], ['Kavya Rao', 'Programme manager', 'Atelier Common'], ['Leila Haddad', 'Illustrator', 'Independent'], ['Luca Moretti', 'Operations', 'Field Notes'], ['Maya Brooks', 'Researcher', 'Common Ground'], ['Nabil Saleh', 'Developer', 'Northline Studio'], ['Nora Berg', 'Designer', 'Independent'], ['Oliver Reed', 'Engineer', 'Atelier Common'], ['Priya Shah', 'Writer', 'Field Notes'], ['Quinn Taylor', 'Archivist', 'Common Ground'], ['Ravi Menon', 'Analyst', 'Independent'], ['Sofia Costa', 'Editor', 'Field Notes'], ['Tariq Ali', 'Designer', 'Northline Studio'], ['Uma Patel', 'Engineer', 'Atelier Common'], ['Vera Novak', 'Researcher', 'Common Ground'], ['Will Morgan', 'Developer', 'Independent'], ['Yara Nasser', 'Producer', 'Northline Studio'], ['Zoë Fischer', 'Editor', 'Field Notes'], ['أحمد علي', 'Designer', 'Independent'], ['李明', 'Engineer', 'Common Ground']];
    const cards = people.map(([name, title, org], i) => {
        const e = sampleCard(name, { title, org, phones: [{ label: 'Mobile', value: `+44 7700 900${String(i + 100).padStart(3, '0')}` }],
            emails: [{ label: 'Work', value: `${name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z]+/g, '.').replace(/^\.|\.$/g, '') || 'contact' + i}@example.com` }],
            note: i === 0 ? 'Primary parser fixture with multiline text.' : i % 7 === 0 ? 'Sparse synthetic contact.' : '' });
        if (i === 0) {
            e.phones.push({ label: 'Studio', value: '+44 20 7946 0018' });
            e.emails.push({ label: 'Personal', value: 'amira.khan.home@example.com' });
            e.addresses.push({ label: 'Studio', value: '', components: ['', '', '18 Example Street', 'London', '', 'EC1A 1AA', 'United Kingdom'] });
            e.urls.push({ label: 'Portfolio', value: 'https://example.com/amira' });
        }
        if (i === 3 || i === 15)
            e.phones.push({ label: 'Studio', value: '+44 20 7946 0018' });
        if (i === 9)
            e.phones.push({ ...e.phones[0], label: 'Also listed' });
        if (i === 12) {
            e.phones = [];
            e.emails = [];
            e.note = 'This intentionally sparse record demonstrates data-quality review.';
        }
        return newVCard(e, `urn:nexus:synthetic:person:${i}`).replace('END:VCARD', i === 0 ? 'X-TEST-REFERENCE:NL-204\r\nEND:VCARD' : 'END:VCARD');
    });
    const teams = [newVCard(sampleCard('Amira Khan', { org: 'Northline Studio', title: 'Product designer', emails: [{ label: 'Work', value: 'amira.khan@example.com' }],
            phones: [{ label: 'Studio', value: '0044 20 7946 0018' }], note: 'Archived team listing. Direct email was confirmed in this synthetic source.' }), 'urn:nexus:synthetic:team:amira')];
    for (let i = 0; i < 14; i++)
        teams.push(newVCard(sampleCard(['Ada Ellis', 'Beth Lewis', 'Callum Gray', 'Dina Malik', 'Ethan Jones', 'Freya Stone', 'Grace Park', 'Henry Moss', 'Inez Silva', 'Jules Tran', 'Keiko Sato', 'Leo Ellis', 'Mina Hart', 'Noah King'][i], { org: 'Common Ground', title: 'Workshop member', emails: [{ label: 'Work', value: `workshop${i}@example.com` }] }), `urn:nexus:synthetic:workshop:${i}`));
    const csv = [['Name', 'Company', 'Phone', 'Email', 'Notes', 'Workshop badge'], ['Amira Khan', 'Northline Studio', '+44 7700 900100', 'amira.khan@example.com', 'A second source, deliberately retained.', 'NL-204'],
        ['Sara Evans', 'Field Notes', '+44 7700 900250', 'sara.evans@example.com', 'Prefers afternoon calls.', 'FN-017'], ['Yusuf Ahmed', 'Independent', '+44 7700 900251', 'yusuf.ahmed@example.com', 'Design systems workshop', 'IN-023'],
        ['Zoë Fischer', 'Field Notes', '+44 7700 900127', 'zoe.fischer@example.com', 'An explicit import should retain this selected row.', 'FN-031']];
    return [{ name: 'People.vcf', text: cards.join('') }, { name: 'Workshop.vcf', text: teams.join('') }, { name: 'Event sign-ups.csv', text: csv.map(row => row.map(x => csvCell(x, false)).join(',')).join('\r\n') + '\r\n' }];
}
export function largeLibrary(count = 10000) {
    const rows = [];
    for (let i = 0; i < count; i++)
        rows.push(newVCard(sampleCard(`Contact ${String(i).padStart(6, '0')}`, { org: `Team ${i % 200}`, emails: [{ label: 'Work', value: `person${i}@example.com` }], phones: [{ label: 'Mobile', value: `+447700${String(i).padStart(6, '0')}` }] }), `urn:nexus:benchmark:${i}`));
    return rows.join('');
}
