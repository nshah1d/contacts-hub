import { el, button, iconButton, field } from './dom.js';
import { emptyFields } from '../core/vcard.js';
/**
 * Builds the contact form. `read()` returns the complete fields and, separately, only the
 * changes, so an edit rewrites nothing the user did not touch. Existing entries keep their
 * `pid` so patchCard() updates them in place.
 * @param {object} [original]
 * @param {boolean} [isNew]
 * @returns {{body: HTMLElement, read: function(): {fields: object, changes: object}, error: HTMLElement, focus: function(): void}}
 */
export function contactEditor(original = emptyFields(), isNew = false) {
    const body = el('div', { class: 'contact-editor' }), inputs = {}, collections = {};
    body.append(el('p', { class: 'hint' }, isNew ? 'Create a contact in this library. A new UID is assigned on creation.' : 'Only changed fields are written. Existing photos, birthdays, custom properties and unedited name components stay in the source.'));
    const scalars = [['fn', 'Full name'], ['org', 'Organisation'], ['title', 'Job title']];
    for (const [key, label] of scalars) {
        const f = field(label, original[key]);
        inputs[key] = f.input;
        body.append(f.node);
    }
    const structured = el('details', {}, el('summary', { class: 'linklike' }, 'Name components'));
    structured.append(el('p', { class: 'hint' }, 'The display name and structured name are independent fields. Changing one does not guess the other.'));
    const nameGrid = el('div', { class: 'field-grid' }), names = {};
    for (const [key, label] of [['prefix', 'Prefix'], ['given', 'Given name'], ['additional', 'Middle name'], ['family', 'Family name'], ['suffix', 'Suffix']]) {
        const f = field(label, original[key]);
        names[key] = f.input;
        nameGrid.append(f.node);
    }
    structured.append(nameGrid);
    body.append(structured);
    for (const [key, title] of [['phones', 'Phone numbers'], ['emails', 'Email addresses'], ['urls', 'Websites']]) {
        body.append(el('h3', {}, title));
        const list = el('div');
        collections[key] = [];
        function add(entry = { label: 'Other', value: '' }) {
            const label = el('input', { value: entry.label, 'aria-label': `${title} label`, placeholder: 'Label', maxlength: 200 });
            const value = el('input', { value: entry.value, 'aria-label': title, placeholder: key === 'phones' ? '+44 7700 900000' : key === 'emails' ? 'name@example.com' : 'https://example.com', maxlength: 131072 });
            const data = { ...entry, labelInput: label, valueInput: value }, row = el('div', { class: 'multi-entry' }, label, value);
            row.append(iconButton('close', `Remove ${title.toLowerCase()} entry`, () => {
                collections[key] = collections[key].filter(e => e !== data);
                row.remove();
            }));
            collections[key].push(data);
            list.append(row);
        }
        for (const e of original[key] || [])
            add(e);
        body.append(list, button(`Add ${key === 'phones' ? 'phone' : key === 'emails' ? 'email' : 'website'}`, () => add(), { class: 'text-button' }));
    }
    body.append(el('h3', {}, 'Postal addresses'));
    const addressList = el('div');
    collections.addresses = [];
    function addAddress(entry = { label: 'Home', value: '', components: ['', '', '', '', '', '', ''] }) {
        const group = el('div', { class: 'address-entry' }), label = field('Address label', entry.label), parts = [];
        group.append(label.node);
        const grid = el('div', { class: 'field-grid' });
        ['PO box', 'Extended address', 'Street', 'City', 'Region', 'Postcode', 'Country'].forEach((name, i) => {
            const f = field(name, entry.components?.[i] || '');
            parts.push(f.input);
            grid.append(f.node);
        });
        const data = { ...entry, labelInput: label.input, partInputs: parts };
        collections.addresses.push(data);
        group.append(grid, button('Remove address', () => {
            collections.addresses = collections.addresses.filter(e => e !== data);
            group.remove();
        }, { class: 'text-button' }));
        addressList.append(group);
    }
    for (const e of original.addresses || [])
        addAddress(e);
    body.append(addressList, button('Add address', () => addAddress(), { class: 'text-button' }));
    const misc = el('div', { class: 'field-grid' });
    for (const [key, label] of [['bday', 'Birthday (as stored)'], ['nickname', 'Nickname']]) {
        const f = field(label, original[key]);
        inputs[key] = f.input;
        misc.append(f.node);
    }
    body.append(el('h3', {}, 'Other details'), misc);
    const note = field('Notes', original.note, 'textarea');
    inputs.note = note.input;
    body.append(note.node);
    const error = el('div', { class: 'form-error', role: 'alert' });
    body.append(error);
    function read() {
        const fields = { ...emptyFields() }, changes = {};
        for (const [key, input] of Object.entries(inputs)) {
            fields[key] = input.value;
            if (input.value !== original[key])
                changes[key] = input.value;
        }
        for (const [key, input] of Object.entries(names))
            fields[key] = input.value;
        const componentKeys = ['family', 'given', 'additional', 'prefix', 'suffix'];
        if (componentKeys.some(k => fields[k] !== original[k]))
            changes.structuredName = componentKeys.map(k => fields[k]);
        for (const key of ['phones', 'emails', 'urls']) {
            fields[key] = collections[key].map(e => ({ ...(e.pid === undefined ? {} : { pid: e.pid }), label: e.labelInput.value, value: e.valueInput.value }));
            if (JSON.stringify(fields[key]) !== JSON.stringify(original[key]))
                changes[key] = fields[key];
        }
        fields.addresses = collections.addresses.map(e => {
            const components = e.partInputs.map(n => n.value);
            return { ...(e.pid === undefined ? {} : { pid: e.pid }), label: e.labelInput.value,
                value: components.join(';'), components };
        });
        // The source may use escaped separators. Compare components, not the display join.
        const normal = entries => entries.map(e => ({ pid: e.pid, label: e.label, components: e.components }));
        if (JSON.stringify(normal(fields.addresses)) !== JSON.stringify(normal(original.addresses)))
            changes.addresses = fields.addresses;
        if (!fields.fn.trim())
            throw new Error('Please enter a full name.');
        return { fields, changes };
    }
    return { body, read, error, focus: () => inputs.fn.focus() };
}
