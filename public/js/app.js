import { EngineClient } from './client.js';
import { FileAdapter, PHPAdapter, commitPlan, checkReceiptCapacity } from './adapters.js';
import { LIMITS, safeFilename, safeURL, phoneKey, sha256, invariant } from './core/primitives.js';
import { el, button, icon, iconButton, initials, sizeLabel, download, copyText, field } from './ui/dom.js';
import { contactEditor } from './ui/editor.js';
import { ContactList, tone } from './ui/virtual-list.js';
import { embeddedPhoto } from './ui/photo.js';
import { aboutSection } from './ui/about.js';
import { MY_NAME } from '../config.js';
const $ = id => document.getElementById(id), engine = new EngineClient();
// The epoch counters let a slow response recognise that the workspace, library or contact it
// was fetched for has since changed, and discard itself. `uncertain` holds libraries whose
// last save could not be verified; they stay read-only until reloaded.
const state = { adapter: null, catalogue: [], open: new Map(), sourceId: null, filter: 'all', scope: 'library', detail: null, epoch: 0, detailEpoch: 0, openEpoch: 0,
    busy: false, uncertain: new Set(), receipts: [], favourites: [], myCard: '', remember: true };
let noticeTimer, dialogOrigin, searchTimer, portraitURL;
function notify(message, error = false) {
    clearTimeout(noticeTimer);
    $('notice').hidden = false;
    $('notice').classList.toggle('error', error);
    $('notice').textContent = message;
    noticeTimer = setTimeout(() => {
        $('notice').hidden = true;
    }, error ? 14000 : 6000);
}
function failure(error) {
    notify(error?.message || String(error), true);
}
function safeAction(fn) {
    return (...args) => Promise.resolve().then(() => fn(...args)).catch(failure);
}
function preferences() {
    try {
        const p = JSON.parse(localStorage.getItem('nexus.preferences.v2') || '{}');
        state.favourites = Array.isArray(p.favourites) ? p.favourites.filter(s => /^[a-f0-9]{64}$/.test(s)).slice(0, 10000) : [];
        state.myCard = /^[a-f0-9]{64}$/.test(p.myCard || '') ? p.myCard : '';
        state.remember = p.remember !== false;
        if (['dark', 'light'].includes(p.theme))
            document.documentElement.dataset.theme = p.theme;
    }
    catch {
        state.remember = false;
    }
}
function storePreferences() {
    if (!state.remember)
        return;
    try {
        localStorage.setItem('nexus.preferences.v2', JSON.stringify({ favourites: state.favourites, myCard: state.myCard,
            remember: true, theme: document.documentElement.dataset.theme }));
    }
    catch {
        notify('Browser preferences could not be stored. Contact data is unaffected.', true);
    }
}
function changePane(pane) {
    document.body.dataset.pane = pane;
}
function closeDialog() {
    if (state.busy)
        return;
    $('modal').close();
    dialogOrigin?.focus?.();
}
function dialog(title, kicker, body, actions = []) {
    dialogOrigin = $('modal').open ? dialogOrigin : document.activeElement;
    $('modal-title').textContent = title;
    $('modal-kicker').textContent = kicker;
    $('modal-body').replaceChildren(body);
    $('modal-footer').replaceChildren(...actions);
    $('modal').classList.remove('wide');
    if (!$('modal').open)
        $('modal').showModal();
    $('modal-body').scrollTop = 0;
}
function uid() {
    // randomUUID needs a secure context; the fallback keeps a plain-HTTP private host working.
    return 'urn:uuid:' + (globalThis.crypto?.randomUUID?.() || sha256(`${Date.now()}:${Math.random()}:${performance.now()}`).slice(0, 32));
}
function sourceOptions() {
    return { sourceId: state.scope === 'opened' ? undefined : state.sourceId, query: $('search').value, filter: state.filter,
        favourites: state.favourites, myCard: state.myCard };
}
const list = new ContactList({ engine, params: sourceOptions, onSelect: safeAction(showContact), onError: failure, onResult: result => {
        if (!result.total && state.open.size)
            detailEmpty($('search').value ? 'No contacts match this search.' : 'No contacts in this view.');
        $('result-count').textContent = `${result.total.toLocaleString('en-GB')} ${result.total === 1 ? 'contact' : 'contacts'}${$('search').value ? ' found' : ''}`;
        $('empty-list').hidden = !!result.total;
        $('empty-list').replaceChildren(el('h3', {}, state.open.size ? 'No contacts here yet' : 'No library open'), el('p', {}, state.open.size ? ($('search').value ? 'Try a shorter name, email address or phone number.' : 'Change the view, open another library or add a contact.') : 'Connect the private directory or open local files.'));
    } });
function renderShell() {
    const total = [...state.open.values()].reduce((n, l) => n + l.count, 0), scoped = state.sourceId ? state.open.get(state.sourceId) : null;
    const views = [['all', 'people', 'All contacts', state.scope === 'opened' ? total : scoped?.count || 0], ['favourites', 'star', 'Favourites', ''], ['review', 'link', 'Shared details', ''], ['quality', 'alert', 'Needs attention', '']];
    $('smart-views').replaceChildren(...views.map(([key, symbol, label, count]) => button('', safeAction(async () => {
        state.filter = key;
        renderShell();
        await list.refresh();
        changePane('list');
    }), { class: `smart-item${state.filter === key ? ' active' : ''}`, 'aria-current': state.filter === key ? 'page' : null }).appendChild(el('span', {})).parentNode));
    [...$('smart-views').children].forEach((node, i) => {
        const [key, symbol, label, count] = views[i];
        node.replaceChildren(icon(symbol), el('span', {}, label), el('span', { class: 'count' }, count));
    });
    $('library-list').replaceChildren(...state.catalogue.map(file => {
        const opened = state.open.get(file.name);
        const node = button('', safeAction(() => openLibrary(file.name)), {
            class: `library${file.name === state.sourceId && state.scope === 'library' ? ' active' : ''}${file.name.toLowerCase().endsWith('.csv') ? ' csv' : ''}`, 'aria-label': `Open ${file.name}`
        });
        node.append(el('span', { class: 'file-symbol' }, file.name.split('.').at(-1).toUpperCase()), el('span', { class: 'lib-label' }, el('strong', {}, file.name.replace(/\.(vcf|csv)$/i, '')), el('small', {}, opened ? `${opened.format === 'CSV' ? 'Original CSV' : 'vCard library'} · ${sizeLabel(file.bytes)}` : `Open to read · ${sizeLabel(file.bytes)}`)), el('span', { class: 'lib-count' }, opened ? opened.count : '○'));
        return node;
    }));
    if (!state.catalogue.length)
        $('library-list').append(el('p', { class: 'hint padded' }, 'Your libraries appear here.'));
    $('list-heading').textContent = views.find(v => v[0] === state.filter)[2];
    $('list-context').textContent = state.scope === 'opened' ? 'OPEN LIBRARIES' : (state.sourceId || 'ADDRESS BOOK').replace(/\.(vcf|csv)$/i, '');
    $('source-status').textContent = state.scope === 'opened' ? `${state.open.size} open libraries searched` : scoped?.format === 'CSV' ? 'CSV · read-only original' : scoped?.writable ? 'VCF · original fields retained' : 'Sources stay separate';
    $('source-button').disabled = !scoped;
    $('add-contact').disabled = !scoped?.writable || state.busy || state.uncertain.has(scoped?.id) || state.scope === 'opened';
    const mode = state.adapter?.kind;
    $('connection-label').textContent = mode === 'server' ? 'VFS · SERVER' : mode === 'local' ? 'VFS · LOCAL' : 'VFS';
    $('connection-label').title = mode === 'server' ? 'Private directory connected' : mode === 'local' ? 'Local files, this session only' : 'No library connected';
    $('workspace-note').replaceChildren(el('p', {}, mode === 'server' ? 'Authenticated reads and verified writes.' : mode === 'local' ? 'Files stay on this device. Download edited libraries to keep changes.' : 'Open the private directory or local files.'));
}
function detailEmpty(text = 'Select a contact to see their details.') {
    state.detailEpoch++;
    if (portraitURL) {
        URL.revokeObjectURL(portraitURL);
        portraitURL = null;
    }
    state.detail = null;
    $('detail-pane').replaceChildren(el('div', { class: 'detail-empty' }, el('div', { class: 'empty-icon', 'aria-hidden': 'true' }, '\u{1F464}'), el('h2', {}, 'Select a Contact'), el('p', {}, text)));
}
async function setWorkspace(adapter, { first = true } = {}) {
    invariant(!state.busy, 'Wait for the current save outcome before changing workspace.');
    const catalogue = await adapter.catalogue();
    state.epoch++;
    state.detailEpoch++;
    state.adapter?.clear();
    state.adapter = adapter;
    state.catalogue = catalogue;
    state.open.clear();
    state.uncertain.clear();
    state.receipts = [];
    state.sourceId = null;
    state.scope = 'library';
    state.filter = 'all';
    $('search').value = '';
    await engine.request('clear');
    detailEmpty();
    renderShell();
    await list.refresh({ selectFirst: false });
    if (first && catalogue.length) {
        try {
            await openLibrary(catalogue[0].name);
        }
        catch (error) {
            changePane('libraries');
            failure(error);
        }
    }
    else
        changePane('libraries');
    if (adapter.lastCatalogueInfo?.ignored)
        notify(`${adapter.lastCatalogueInfo.ignored} VCF/CSV entries were skipped because their filenames or file types are unsupported. Review the server directory.`, true);
}
async function openLibrary(name, { reload = false, options = {} } = {}) {
    invariant(!state.busy, 'A save is being verified. Keep this workspace open.');
    const epoch = state.epoch, stamp = ++state.openEpoch, adapter = state.adapter, preserved = reload && state.detail?.library.id === name ? state.detail.contact.id : null;
    if (!adapter)
        return;
    try {
        if (!state.open.has(name) || reload) {
            $('result-count').textContent = 'Reading source';
            const data = await adapter.read(name);
            if (epoch !== state.epoch)
                return;
            const summary = await engine.request('open', { text: data.text, name, id: name, options });
            if (epoch !== state.epoch)
                return;
            state.open.set(name, summary);
            state.uncertain.delete(name);
            if (MY_NAME && !state.myCard) {
                const r = await engine.request('query', { sourceId: name, query: MY_NAME, limit: 100 });
                const exact = r.items.filter(c => c.name.toLocaleLowerCase() === MY_NAME.toLocaleLowerCase());
                if (r.total <= 100 && exact.length === 1) {
                    state.myCard = exact[0].bookmark;
                    storePreferences();
                }
            }
        }
        if (epoch !== state.epoch || stamp !== state.openEpoch)
            return;
        state.sourceId = name;
        state.scope = 'library';
        state.filter = 'all';
        $('search').value = '';
        renderShell();
        changePane('list');
        await list.refresh({ selectedId: preserved });
        if (!state.open.get(name).count)
            detailEmpty('This library is empty. Add a contact to begin.');
    }
    catch (error) {
        if (epoch === state.epoch && stamp === state.openEpoch) {
            renderShell();
            await list.load(true);
        }
        throw error;
    }
}
async function refreshCatalogue() {
    if (!state.adapter)
        return openSourceDialog();
    const epoch = state.epoch;
    const items = await state.adapter.catalogue();
    if (epoch !== state.epoch)
        return;
    state.catalogue = items;
    renderShell();
    notify(`${items.length} ${items.length === 1 ? 'library' : 'libraries'} found. Open sources keep their current snapshot until reloaded.${state.adapter.lastCatalogueInfo?.ignored ? ' Some unsupported directory entries were skipped. Review the server directory.' : ''}`);
}
function canLeave() {
    if (state.adapter?.changed && !confirm('Session changes have not been written back to your original files. Download them first, or continue to discard this workspace.'))
        return false;
    if (state.receipts.length && !confirm('Change receipts have not been downloaded. Continue and clear this session record?'))
        return false;
    return true;
}
async function connectServer(password = undefined) {
    const adapter = new PHPAdapter();
    try {
        await adapter.login(password);
        await setWorkspace(adapter);
    }
    catch (e) {
        adapter.clear();
        throw e;
    }
}
function connectDialog() {
    const password = field('Library password', '', 'password'), error = el('div', { class: 'form-error', role: 'alert' });
    password.input.autocomplete = 'current-password';
    const body = el('div', {}, el('p', {}, 'Connect to the private PHP directory. Hosted installations may use the web-server login and require no second password.'), password.node, error);
    dialog('Private library', 'SERVER DIRECTORY', body, [button('Cancel', closeDialog, { class: 'secondary' }), button('Connect', async () => {
            try {
                if (!canLeave())
                    return;
                error.textContent = '';
                await connectServer(password.input.value);
                closeDialog();
            }
            catch (e) {
                error.textContent = e.message;
            }
        }, { class: 'primary' })]);
    password.input.focus();
}
function openSourceDialog() {
    const choice = (symbol, title, text, fn) => button('', safeAction(fn), { class: 'choice' }).appendChild(el('span', {}, icon(symbol), el('strong', {}, title), el('small', {}, text))).parentNode;
    dialog('Open contact sources', 'OPEN A SOURCE', el('div', {}, el('p', {}, 'VCF libraries remain editable. CSV files stay as originals until you explicitly create a vCard copy.'), el('div', { class: 'choice-grid' }, choice('folder', 'Private directory', 'Open the server contact folder with persistent, verified writes.', () => connectDialog()), choice('upload', 'Local files', 'Choose VCF or CSV files. Nothing is uploaded.', () => {
        $('file-input').click();
    }), choice('book', 'A local folder', 'Find VCF and CSV files in a selected folder.', () => {
        $('folder-input').click();
    }))), []);
}
function externalValue(value, kind) {
    if (kind === 'phone') {
        const key = phoneKey(value);
        if (!key)
            return null;
        return 'tel:' + key.replace(/^international:/, '+').replace(/^local:/, '');
    }
    if (kind === 'email' && /^[^\s@<>]+@[^\s@<>]+$/.test(value))
        return 'mailto:' + encodeURIComponent(value);
    if (kind === 'whatsapp') {
        const key = phoneKey(value);
        return key.startsWith('international:') ? 'https://wa.me/' + key.slice('international:'.length).split(';')[0] : null;
    }
    if (kind === 'url')
        return safeURL(value);
    return null;
}
function valueRow(label, value, kind = null) {
    const href = kind ? externalValue(value, kind) : null;
    const content = href ? el('a', { href, ...(kind === 'url' ? { target: '_blank', rel: 'noopener noreferrer' } : {}) }, value) : value;
    return el('div', { class: 'info-row' }, el('div', { class: 'info-label' }, label), el('div', { class: 'info-value' }, content), iconButton('copy', `Copy ${label}`, safeAction(async () => {
        await copyText(value);
        notify('Copied.');
    }), { class: 'icon-button copy-value' }));
}
async function showContact(id, navigate = false) {
    const stamp = ++state.detailEpoch, epoch = state.epoch;
    const detail = await engine.request('detail', { id });
    if (stamp !== state.detailEpoch || epoch !== state.epoch)
        return;
    state.detail = detail;
    renderDetail(detail);
    if (navigate) {
        changePane('detail');
        if (matchMedia('(max-width:780px)').matches)
            $('detail-pane').querySelector('h2')?.focus();
    }
}
function renderDetail(detail) {
    if (portraitURL) {
        URL.revokeObjectURL(portraitURL);
        portraitURL = null;
    }
    const { contact: c, library, peers } = detail, fields = c.fields;
    const toolbar = el('div', { class: 'detail-toolbar' }, el('div', { class: 'inline-actions' }, iconButton('arrow', 'Back to contacts', () => {
        changePane('list');
        $('contact-list').focus();
    }, { class: 'icon-button mobile-only' }), el('span', { class: 'detail-breadcrumb' }, library.name)), el('div', { class: 'toolbar-right' }, iconButton('star', state.favourites.includes(c.bookmark) ? 'Remove favourite' : 'Add favourite', safeAction(async () => {
        state.favourites = state.favourites.includes(c.bookmark) ? state.favourites.filter(x => x !== c.bookmark) : [...state.favourites, c.bookmark];
        storePreferences();
        renderDetail(detail);
        await list.load(true);
    })), button('Edit', () => editContact(detail), { class: 'edit-button', disabled: !library.writable || state.uncertain.has(library.id) })));
    const hero = el('div', { class: 'contact-hero' }, el('div', { class: 'avatar hero-avatar', 'data-tone': tone(c.displayName) }, initials(c.displayName)), el('h2', { tabindex: '-1' }, c.displayName));
    const role = [fields.title, fields.org].filter(Boolean).join(' · ');
    if (role)
        hero.append(el('p', { class: 'role-line' }, role));
    if (c.bookmark === state.myCard)
        hero.append(el('span', { class: 'my-card' }, 'MY CARD'));
    const quick = el('div', { class: 'quick-actions' });
    for (const [symbol, label, value, kind] of [['phone', 'Call', fields.phones[0]?.value, 'phone'], ['people', 'WhatsApp', fields.phones[0]?.value, 'whatsapp'], ['mail', 'Email', fields.emails[0]?.value, 'email']]) {
        const href = value && externalValue(value, kind);
        if (href)
            quick.append(el('a', { href, class: 'quick-action' }, icon(symbol), el('span', {}, label)));
    }
    quick.append(button('', safeAction(() => shareContact(c, library)), { class: 'quick-action' }).appendChild(el('span', {}, icon('upload'), el('span', { class: 'quick-label' }, 'Share'))).parentNode, button('', () => sourceDialog(detail), { class: 'quick-action' }).appendChild(el('span', {}, icon('source'), el('span', { class: 'quick-label' }, 'Source'))).parentNode);
    hero.append(quick);
    const sheet = el('div', { class: 'contact-sheet' }, hero);
    if (peers.length)
        sheet.append(button('', () => reviewDialog(detail), { class: 'review-banner' }).appendChild(el('span', { class: 'inline-actions full-width' }, icon('link'), el('span', {}, el('strong', {}, `Shared details with ${detail.peerCount} ${detail.peerCount === 1 ? 'other record' : 'other records'}`), el('small', {}, 'Compare the sources. Keep each person distinct.')), el('span', { class: 'arrow' }, '›'))).parentNode);
    if (c.quality.length || !library.writable)
        sheet.append(el('div', { class: 'source-warning' }, [...c.quality, library.format === 'CSV' ? 'CSV original. Create a vCard copy to edit.' : !library.writable ? 'Source issues block in-place writes. See source details.' : ''].filter(Boolean).join(' · ')));
    const methods = [];
    for (const e of fields.phones)
        methods.push(valueRow(e.label || 'Phone', e.value, 'phone'));
    for (const e of fields.emails)
        methods.push(valueRow(e.label || 'Email', e.value, 'email'));
    if (methods.length)
        sheet.append(el('h3', { class: 'section-label' }, 'Contact details'), el('div', { class: 'info-group' }, methods));
    if (fields.addresses.length)
        sheet.append(el('h3', { class: 'section-label' }, 'Addresses'), el('div', { class: 'info-group' }, fields.addresses.map(e => valueRow(e.label || 'Address', e.components.filter(Boolean).join('\n')))));
    const other = [];
    for (const e of fields.urls)
        other.push(valueRow(e.label || 'Website', e.value, 'url'));
    if (fields.bday)
        other.push(valueRow('Birthday', fields.bday));
    if (fields.nickname)
        other.push(valueRow('Nickname', fields.nickname));
    if (other.length)
        sheet.append(el('h3', { class: 'section-label' }, 'Other details'), el('div', { class: 'info-group' }, other));
    if (fields.note)
        sheet.append(el('h3', { class: 'section-label' }, 'Notes'), el('div', { class: 'info-group' }, el('div', { class: 'info-row' }, el('div', { class: 'info-value' }, fields.note))));
    if (fields.photos.length)
        sheet.append(el('p', { class: 'hint margin-top' }, `${fields.photos.length} source ${fields.photos.length === 1 ? 'photo is' : 'photos are'} retained. Remote images are never loaded automatically.`));
    sheet.append(el('div', { class: 'record-footer' }, el('span', {}, `RECORD ${c.ordinal + 1} · ${library.format} ${c.version || ''}`), button(c.bookmark === state.myCard ? 'Unpin My Card' : 'Make My Card', safeAction(async () => {
        state.myCard = c.bookmark === state.myCard ? '' : c.bookmark;
        storePreferences();
        renderDetail(detail);
        await list.load(true);
    }))), el('div', { class: 'row-tools margin-top' }, button('Copy details', safeAction(async () => {
        const lines = [`Name: ${c.displayName}`];
        if (fields.org) lines.push(`Organisation: ${fields.org}`);
        if (fields.title) lines.push(`Role: ${fields.title}`);
        for (const entry of fields.phones) lines.push(`Phone (${entry.label || 'Other'}): ${entry.value}`);
        for (const entry of fields.emails) lines.push(`Email (${entry.label || 'Other'}): ${entry.value}`);
        for (const entry of fields.addresses) lines.push(`Address (${entry.label || 'Other'}): ${entry.components.filter(Boolean).join(', ')}`);
        if (fields.note) lines.push(`Notes: ${fields.note}`);
        await copyText(lines.join('\n'));
        notify('Contact details copied.');
    }), { class: 'text-button' }), button('Copy vCard', safeAction(async () => {
        const text = await engine.request('export', { sourceId: library.id, format: 'card', id: c.id, uid: uid() });
        await copyText(text);
        notify('vCard copied.');
    }), { class: 'text-button' }), button('Delete contact', () => deleteContact(detail), { class: 'text-button', disabled: !library.writable || state.uncertain.has(library.id) })));
    $('detail-pane').replaceChildren(toolbar, sheet);
    for (const photo of fields.photos) {
        try {
            const parsed = embeddedPhoto(photo);
            if (!parsed)
                continue;
            const url = URL.createObjectURL(new Blob([parsed.bytes], { type: parsed.mime }));
            portraitURL = url;
            const image = new Image();
            image.alt = '';
            image.src = url;
            image.decode().then(() => {
                if (hero.isConnected && portraitURL === url && image.naturalWidth <= LIMITS.imageDimension && image.naturalHeight <= LIMITS.imageDimension)
                    hero.querySelector('.hero-avatar').replaceChildren(image);
            }).catch(() => {
                if (portraitURL === url) {
                    URL.revokeObjectURL(url);
                    portraitURL = null;
                }
            });
            break;
        }
        catch {
        }
    }
}
async function shareContact(c, library) {
    const raw = await engine.request('export', { sourceId: library.id, format: 'card', id: c.id, uid: uid() });
    const filename = 'contact.vcf', file = new File([raw], filename, { type: 'text/vcard' });
    if (navigator.canShare?.({ files: [file] })) {
        try {
            await navigator.share({ files: [file], title: c.displayName });
        }
        catch (e) {
            if (e.name !== 'AbortError')
                throw e;
        }
    }
    else
        download(raw, filename, 'text/vcard;charset=utf-8');
}
function editContact(detail = null) {
    const summary = detail?.library || state.open.get(state.sourceId);
    if (!summary?.writable)
        return notify('Choose an editable VCF library.', true);
    if (state.uncertain.has(summary.id))
        return notify('Reload this library before editing again.', true);
    const editor = contactEditor(detail?.contact.fields, !detail), title = detail ? 'Edit contact' : 'New contact';
    const show = () => {
        dialog(title, summary.name, editor.body, [button('Cancel', closeDialog, { class: 'secondary' }), button('Review changes', async () => {
                try {
                    editor.error.textContent = '';
                    const draft = editor.read();
                    if (detail && !Object.keys(draft.changes).length) {
                        notify('No fields have changed.');
                        return;
                    }
                    const plan = await engine.request('plan', { sourceId: summary.id, baseRevision: summary.revision, kind: detail ? 'edit' : 'add', id: detail?.contact.id,
                        recordHash: detail?.contact.hash, changes: draft.changes, fields: draft.fields, uid: uid() });
                    previewPlan(plan, { back: show, changes: detail ? draft.changes : draft.fields, before: detail?.contact.fields });
                }
                catch (e) {
                    editor.error.textContent = e.message;
                }
            }, { class: 'primary' })]);
        editor.focus();
    };
    show();
}
function previewPlan(plan, { back = null, changes = null, before = null, title = 'Review this change' } = {}) {
    const error = el('div', { class: 'form-error', role: 'alert' }), body = el('div', {}, el('p', {}, state.adapter.kind === 'server' ?
        'The PHP service will check the current revision, keep a backup and write this change. Contacts Hub then reads the saved file back before updating the address book.' :
        'This changes the current session only. Your original files are untouched. Download the edited library afterwards to keep it.'), el('div', { class: 'change-list' }, el('div', {}, `Library: ${plan.filename}`), el('div', {}, `Contacts: ${plan.beforeCount ?? 0} → ${plan.afterCount ?? 'new library'}`), el('div', {}, `Change: ${plan.changed?.join(', ') || 'Create an editable copy'}`)));
    if (changes) {
        const items = el('div');
        for (const [key, value] of Object.entries(changes)) {
            if (value === '' || Array.isArray(value) && !value.length) {
                if (!before?.[key])
                    continue;
            }
            const stringify = v => typeof v === 'string' ? v : JSON.stringify(v, null, 2);
            const details = el('details', {}, el('summary', { class: 'linklike' }, key));
            if (before && before[key] !== undefined)
                details.append(el('p', { class: 'hint' }, 'Before'), el('pre', { class: 'raw-source' }, stringify(before[key])));
            details.append(el('p', { class: 'hint' }, 'After'), el('pre', { class: 'raw-source' }, stringify(value)));
            items.append(details);
        }
        body.append(items);
    }
    body.append(error);
    const save = button(state.adapter.kind === 'server' ? 'Save to server' : 'Apply to session', async () => {
        if (state.busy)
            return;
        state.busy = true;
        save.disabled = true;
        $('modal-close').disabled = true;
        renderShell();
        error.textContent = '';
        for (const b of $('modal-footer').querySelectorAll('button'))
            b.disabled = true;
        try {
            checkReceiptCapacity(state.receipts, plan.receipt);
            const result = await commitPlan(state.adapter, engine, plan);
            state.open.set(result.summary.id, result.summary);
            state.uncertain.delete(result.summary.id);
            // An edit changes the card's hash, so favourites and My Card follow it to its new bookmark.
            if (plan.bookmarkChange) {
                const { from, to } = plan.bookmarkChange;
                state.favourites = state.favourites.map(k => k === from ? to : k).filter(Boolean);
                if (state.myCard === from)
                    state.myCard = to || '';
                storePreferences();
            }
            state.receipts.push(result.receipt);
            let catalogueWarning = false;
            try {
                state.catalogue = await state.adapter.catalogue();
            }
            catch {
                catalogueWarning = true;
                state.catalogue = state.catalogue.filter(f => f.name !== result.summary.name);
                state.catalogue.push({ name: result.summary.name, bytes: result.summary.bytes, modified: null });
            }
            state.sourceId = result.summary.id;
            state.scope = 'library';
            state.filter = 'all';
            state.busy = false;
            $('modal-close').disabled = false;
            closeDialog();
            renderShell();
            await list.refresh({ selectedId: plan.targetId });
            if (plan.targetId && result.summary.count)
                await showContact(plan.targetId, false);
            else if (!result.summary.count)
                detailEmpty('This library is empty.');
            notify(catalogueWarning ? 'The change was verified, but the catalogue refresh failed. The saved record is shown.' : state.adapter.kind === 'server' ? (result.receipt.responseRecovered ? 'The response was lost; read-back verified the saved change.' : 'Saved and verified against the server file.') : 'Applied to this session. Download the library to keep the change.');
        }
        catch (e) {
            error.textContent = e.message;
            if (['UNVERIFIED_SAVE', 'CONFLICT'].includes(e.code))
                state.uncertain.add(plan.sourceId || plan.filename);
            if (e.code === 'UNVERIFIED_SAVE' || e.code === 'CONFLICT')
                save.disabled = true;
        }
        finally {
            state.busy = false;
            $('modal-close').disabled = false;
            for (const b of $('modal-footer').querySelectorAll('button'))
                b.disabled = false;
            if (state.uncertain.has(plan.sourceId || plan.filename))
                save.disabled = true;
            renderShell();
        }
    }, { class: plan.kind === 'delete' ? 'danger' : 'primary' });
    dialog(title, plan.filename, body, [...(back ? [button('Back to draft', back, { class: 'secondary' })] : [button('Cancel', closeDialog, { class: 'secondary' })]),
        button('Download proposed VCF', () => download(plan.content, plan.filename, 'text/vcard;charset=utf-8'), { class: 'secondary' }), save]);
}
function deleteContact(detail) {
    const { contact: c, library } = detail;
    if (!library.writable)
        return;
    const body = el('div', {}, el('p', {}, `Remove ${c.displayName} from ${library.name}? Other records are retained, including any records that share the same details.`));
    dialog('Delete this contact?', library.name, body, [button('Cancel', closeDialog, { class: 'secondary' }), button('Review deletion', safeAction(async () => {
            const plan = await engine.request('plan', { sourceId: library.id, baseRevision: library.revision, kind: 'delete', id: c.id, recordHash: c.hash });
            previewPlan(plan, { title: 'Confirm deletion' });
        }), { class: 'danger' })]);
}
function sourceDialog(detail = null) {
    const library = detail?.library || state.open.get(state.sourceId);
    if (!library)
        return;
    const body = el('div', {}, el('p', {}, 'The source file is authoritative. Shared details are review signals and never proof of identity.'));
    const meta = el('dl', { class: 'source-meta' }, el('dt', {}, 'Filename'), el('dd', {}, library.name), el('dt', {}, 'Format'), el('dd', {}, library.format), el('dt', {}, 'Records'), el('dd', {}, library.count), el('dt', {}, 'Bytes'), el('dd', {}, sizeLabel(library.bytes)), el('dt', {}, 'Mode'), el('dd', {}, library.writable ? 'Editable VCF' : 'Read-only original'), el('dt', {}, 'Revision'), el('dd', {}, 'Verified'));
    body.append(meta);
    const downloads = el('div', { class: 'row-tools' });
    for (const [format, label, extension, type] of [['original', 'Original source', library.name.split('.').at(-1), 'text/plain'], ['evidence', 'Evidence JSON', 'json', 'application/json'], ['table', 'Inspection CSV', 'csv', 'text/csv']])
        downloads.append(button(label, safeAction(async () => {
            const text = await engine.request('export', { sourceId: library.id, format });
            download(text, format === 'original' ? library.name : `${library.name}.${format}.${extension}`, type);
        }), { class: 'secondary' }));
    body.append(downloads);
    if (detail) {
        const c = detail.contact;
        body.append(el('h3', {}, 'This record'), el('p', {}, `Lines ${c.lineStart}–${c.lineEnd} · record ${c.ordinal + 1}`), el('pre', { class: 'raw-source' }, c.raw));
        if (c.fields.extras.length)
            body.append(el('p', { class: 'hint' }, `${c.fields.extras.length} additional properties remain in this record. They survive ordinary edits.`));
    }
    if (library.issueCount) {
        body.append(el('h3', {}, `${library.issueCount} source findings`));
        for (const issue of library.diagnostics)
            body.append(el('div', { class: 'source-warning' }, `Line ${issue.line}: ${issue.message}`));
        if (library.issueCount > library.diagnostics.length)
            body.append(el('p', { class: 'hint' }, `Showing the first ${library.diagnostics.length} findings. The total includes all findings.`));
    }
    else
        body.append(el('p', { class: 'hint margin-top' }, 'No parser findings in this source. This checks the supported input contract, not ownership, accuracy or complete vCard conformance.'));
    const tools = el('div', { class: 'row-tools margin-top' }, button('Reload source', safeAction(async () => {
        await openLibrary(library.id, { reload: true });
        closeDialog();
    }), { class: 'secondary' }));
    if (library.format === 'CSV')
        tools.append(button('CSV column mapping', () => mappingDialog(library), { class: 'secondary' }));
    if (library.convertible)
        tools.append(button(library.format === 'CSV' ? 'Create editable copy' : 'Duplicate library', () => conversionDialog(library), { class: 'secondary' }));
    if (library.writable)
        tools.append(button('Import from an open CSV', () => importDialog(library), { class: 'secondary' }));
    tools.append(button('Close this library', safeAction(async () => {
        await engine.request('close', { id: library.id });
        state.open.delete(library.id);
        state.sourceId = [...state.open.keys()][0] || null;
        state.detailEpoch++;
        detailEmpty();
        renderShell();
        await list.refresh();
        closeDialog();
    }), { class: 'text-button' }));
    body.append(tools);
    dialog('Source details', detail?.contact.displayName || 'LIBRARY', body, [button('Done', closeDialog, { class: 'secondary' })]);
}
function conversionDialog(library) {
    const filename = field('New filename', library.name.replace(/\.(vcf|csv)$/i, '-editable.vcf')), error = el('div', { class: 'form-error', role: 'alert' });
    const body = el('div', {}, el('p', {}, library.format === 'CSV' ? 'Create a new vCard library from every mapped row. Original CSV headers and row values travel with the converted records. The original CSV remains unchanged.' : 'Create an exact copy in a new file. Existing properties and line endings remain intact.'), filename.node, error);
    dialog('An editable copy', library.name, body, [button('Cancel', closeDialog, { class: 'secondary' }), button('Review conversion', async () => {
            try {
                safeFilename(filename.input.value, 'vcf');
                invariant(!state.catalogue.some(f => f.name.toLowerCase() === filename.input.value.toLowerCase()), 'That filename already exists. Choose another.');
                const plan = await engine.request('convert', { sourceId: library.id, filename: filename.input.value, uid: uid() });
                plan.sourceId = plan.filename;
                plan.beforeCount = 0;
                plan.afterCount = library.count;
                plan.changed = [library.format === 'CSV' ? 'Explicit CSV conversion' : 'Exact library copy'];
                plan.kind = 'create';
                plan.receipt = { operation: 'create', filename: plan.filename, beforeSha256: null, afterSha256: plan.revision, origin: { name: library.name, sha256: library.revision } };
                previewPlan(plan, { back: () => conversionDialog(library) });
            }
            catch (e) {
                error.textContent = e.message;
            }
        }, { class: 'primary' })]);
}
function mappingDialog(library) {
    const mapping = { ...library.mapping }, selects = {}, delimiter = field('Delimiter');
    const delim = el('select', { 'aria-label': 'Delimiter' }, ...[['Comma', ','], ['Semicolon', ';'], ['Tab', '\t']].map(([label, value]) => el('option', { value }, label)));
    delim.value = library.delimiter;
    delimiter.node.replaceChildren(el('span', {}, 'Delimiter'), delim);
    const body = el('div', {}, el('p', {}, 'Choose columns by position. This changes interpretation in the current session, never the CSV file. Apply a delimiter change first, then map the resulting columns.'), delimiter.node);
    for (const [key, label] of [['fn', 'Full name'], ['given', 'Given name'], ['family', 'Family name'], ['org', 'Organisation'], ['title', 'Job title'], ['note', 'Notes'], ['phone', 'Primary phone'], ['email', 'Primary email']]) {
        const select = el('select', { 'aria-label': label }, el('option', { value: '-1' }, 'Not mapped'), ...library.headers.map((h, i) => el('option', { value: i }, `${i + 1}. ${h || '(blank header)'}`)));
        select.value = String(mapping[key] ?? -1);
        selects[key] = select;
        body.append(el('label', { class: 'field' }, el('span', {}, label), select));
    }
    const error = el('div', { class: 'form-error', role: 'alert' });
    body.append(error);
    dialog('CSV column mapping', library.name, body, [button('Cancel', closeDialog, { class: 'secondary' }), button('Apply mapping', async () => {
            try {
                const chosen = { ...mapping };
                for (const [k, n] of Object.entries(selects)) {
                    if (Number(n.value) < 0)
                        delete chosen[k];
                    else
                        chosen[k] = Number(n.value);
                }
                await openLibrary(library.id, { reload: true, options: { delimiter: delim.value, ...(delim.value === library.delimiter ? { mapping: chosen } : {}) } });
                closeDialog();
                notify('CSV interpretation updated. The original file is unchanged.');
            }
            catch (e) {
                error.textContent = e.message;
            }
        }, { class: 'primary' })]);
}
async function importDialog(target) {
    try {
        const sources = [...state.open.values()].filter(l => l.format === 'CSV' && l.convertible && l.id !== target.id);
        if (!sources.length) {
            notify('Open a CSV with mapped names before importing. Each selected row is retained, including shared details.', true);
            return;
        }
        const select = el('select', { 'aria-label': 'Import source' }, ...sources.map(l => el('option', { value: l.id }, l.name))), items = el('div'), error = el('div', { class: 'form-error', role: 'alert' }), checks = new Map();
        let page = 0, total = 0;
        const chosenCount = el('p', { class: 'hint' });
        const updateCount = () => chosenCount.textContent = `${checks.size} explicitly selected rows. Shared names or numbers never remove a selected row.`;
        updateCount();
        async function renderRows() {
            const response = await engine.request('query', { sourceId: select.value, offset: page * 50, limit: 50 });
            total = response.total;
            items.replaceChildren(...response.items.map(c => {
                const checkbox = el('input', { type: 'checkbox', checked: checks.has(c.id), 'aria-label': `Import ${c.name}`, onchange: () => {
                        if (checkbox.checked)
                            checks.set(c.id, { id: c.id, revision: state.open.get(select.value).revision });
                        else
                            checks.delete(c.id);
                        updateCount();
                    } });
                return el('label', { class: 'import-row' }, checkbox, el('span', {}, c.name, el('small', {}, c.secondary + (c.review ? ' · shared details' : ''))));
            }));
            prev.disabled = page === 0;
            next.disabled = (page + 1) * 50 >= total;
            pageText.textContent = `${page * 50 + 1}–${Math.min((page + 1) * 50, total)} of ${total}`;
        }
        const prev = button('Previous', safeAction(async () => {
            page--;
            await renderRows();
        }), { class: 'secondary' }), next = button('Next', safeAction(async () => {
            page++;
            await renderRows();
        }), { class: 'secondary' }), pageText = el('span', { class: 'hint' });
        select.addEventListener('change', safeAction(async () => {
            checks.clear();
            page = 0;
            updateCount();
            await renderRows();
        }));
        const body = el('div', {}, el('p', {}, `Choose rows to append to ${target.name}. Nothing is preselected. Existing contacts remain separate. Original CSV rows are retained as evidence in each imported card.`), el('label', { class: 'field' }, el('span', {}, 'CSV source'), select), chosenCount, items, el('div', { class: 'row-tools' }, prev, pageText, next), error);
        dialog('Import selected contacts', target.name, body, [button('Cancel', closeDialog, { class: 'secondary' }), button('Review import', async () => {
                try {
                    const plan = await engine.request('plan', { kind: 'import', sourceId: target.id, baseRevision: target.revision, selected: [...checks.values()], uid: uid() });
                    previewPlan(plan, { title: 'Review selected import' });
                }
                catch (e) {
                    error.textContent = e.message;
                }
            }, { class: 'primary' })]);
        await renderRows();
    }
    catch (e) {
        failure(e);
    }
}
function reviewDialog(detail) {
    const body = el('div', {}, el('p', {}, 'A shared phone or email can belong to a household, a switchboard or an outdated export. Contacts Hub keeps both records. Compare their values before copying missing details.'), el('h3', {}, detail.contact.displayName), ...detail.matchGroups.map(g => el('span', { class: 'shared-key' }, `${g.kind}: ${g.key.replace(/^(international|local):/, '')}`)));
    for (const peer of detail.peers) {
        const box = el('div', { class: 'compare-record' }, el('h3', {}, peer.name), el('small', {}, peer.sourceId));
        const meta = el('dl', { class: 'source-meta' });
        for (const [label, value] of [['Company', peer.fields.org], ['Role', peer.fields.title], ['Phones', peer.fields.phones.map(e => e.value).join('\n')], ['Emails', peer.fields.emails.map(e => e.value).join('\n')]])
            if (value)
                meta.append(el('dt', {}, label), el('dd', {}, value));
        box.append(meta);
        box.append(el('div', { class: 'row-tools' }, button('View record', safeAction(async () => {
            closeDialog();
            await showContact(peer.id, true);
        }), { class: 'secondary' }), button('Review missing details', safeAction(async () => {
            const combined = await engine.request('combine', { primary: detail.contact.id, secondary: peer.id });
            const inner = el('div', {}, el('p', {}, `Fill empty fields and add exact values from ${peer.name}. Both source records remain. Conflicting fields stay as they are on ${detail.contact.displayName}.`));
            for (const conflict of combined.conflicts)
                inner.append(el('div', { class: 'conflict' }, `${conflict.field}: keeping “${conflict.kept}”. Other record: “${conflict.other}”.`));
            if (!Object.keys(combined.changes).length)
                inner.append(el('p', {}, 'There are no missing details to copy.'));
            dialog('Copy missing details', detail.contact.displayName, inner, [button('Back', () => reviewDialog(detail), { class: 'secondary' }), button('Review change', safeAction(async () => {
                    const plan = await engine.request('plan', { kind: 'edit', sourceId: detail.library.id, baseRevision: detail.library.revision, id: detail.contact.id, recordHash: detail.contact.hash, changes: combined.changes });
                    const other = await engine.request('detail', { id: peer.id });
                    plan.receipt.copiedFrom = { filename: other.library.name, sourceSha256: other.library.revision, recordSha256: other.contact.hash, lines: [other.contact.lineStart, other.contact.lineEnd] };
                    previewPlan(plan, { changes: combined.changes, before: detail.contact.fields, back: () => reviewDialog(detail) });
                }), { class: 'primary', disabled: !Object.keys(combined.changes).length })]);
        }), { class: 'secondary', disabled: !detail.library.writable || state.uncertain.has(detail.library.id) })));
        body.append(box);
    }
    if (detail.peerCount > detail.peers.length)
        body.append(el('p', { class: 'hint' }, `Showing ${detail.peers.length} of ${detail.peerCount} other records. Narrow the open sources for a smaller review.`));
    dialog('Shared details', `${detail.peerCount} OTHER RECORDS`, body, [button('Done', closeDialog, { class: 'secondary' })]);
}
function settingsDialog() {
    const body = el('div', {}, el('p', {}, 'Contact content stays out of browser storage. Optional preferences contain the theme and hashed bookmarks for favourites and My Card.'));
    const remember = el('input', { type: 'checkbox', checked: state.remember, 'aria-label': 'Remember preferences', onchange: () => {
            state.remember = remember.checked;
            if (!state.remember) {
                try {
                    localStorage.removeItem('nexus.preferences.v2');
                }
                catch {
                }
            }
            else
                storePreferences();
        } });
    body.append(el('label', { class: 'settings-row' }, el('span', {}, 'Remember preferences', el('small', {}, 'Hashed bookmarks and theme only. No token or contact text.')), remember), el('div', { class: 'settings-row' }, el('span', {}, 'Search scope', el('small', {}, 'Unopened files are never included in a search.')), button(state.scope === 'opened' ? 'Current library' : 'All open libraries', safeAction(async () => {
        state.scope = state.scope === 'opened' ? 'library' : 'opened';
        state.filter = 'all';
        renderShell();
        await list.refresh();
        closeDialog();
    }), { class: 'secondary', disabled: !state.open.size })), el('div', { class: 'settings-row' }, el('span', {}, 'Change receipts', el('small', {}, `${state.receipts.length} verified session operations. Export before leaving.`)), button('Download', () => download(JSON.stringify({ schemaVersion: 1, receipts: state.receipts }, null, 2), 'nexus-change-receipts.json', 'application/json'), { class: 'secondary', disabled: !state.receipts.length })), el('div', { class: 'settings-row' }, el('span', {}, 'Clear change receipts', el('small', {}, 'Download receipts first. This clears only the session audit, not contacts.')), button('Clear receipts', () => {
        if (confirm('Clear these session change receipts? Download them first to keep the audit.')) {
            state.receipts = [];
            settingsDialog();
        }
    }, { class: 'secondary', disabled: !state.receipts.length })), el('div', { class: 'settings-row' }, el('span', {}, 'New library', el('small', {}, 'Create an empty VCF in the current workspace.')), button('Create', () => newLibraryDialog(), { class: 'secondary', disabled: !state.adapter })), el('div', { class: 'settings-row' }, el('span', {}, 'Close workspace', el('small', {}, 'Release sources, worker data and the connection token.')), button('Close', safeAction(async () => {
        if (!canLeave())
            return;
        state.epoch++;
        state.detailEpoch++;
        await state.adapter?.logout?.();
        state.adapter?.clear();
        state.adapter = null;
        state.catalogue = [];
        state.open.clear();
        state.sourceId = null;
        state.receipts = [];
        state.uncertain.clear();
        engine.reset();
        closeDialog();
        detailEmpty('The workspace is closed. Open a source to begin again.');
        renderShell();
        await list.refresh({ selectFirst: false });
        changePane('libraries');
    }), { class: 'secondary' })));
    body.append(el('p', { class: 'hint margin-top' }, 'Contact limits: 50,000 per source, 100,000 across open sources. Files: 20 MiB each, 64 MiB open total. Supported vCard 3.0 and 4.0 fields; earlier versions remain read-only.'), aboutSection());
    dialog('Your workspace', 'SETTINGS', body, [button('Done', closeDialog, { class: 'secondary' })]);
}
function newLibraryDialog() {
    const filename = field('Filename', 'contacts.vcf'), error = el('div', { class: 'form-error', role: 'alert' });
    dialog('A new library', 'VCARD', el('div', {}, el('p', {}, 'Start an empty address book. Existing filenames cannot be replaced.'), filename.node, error), [button('Cancel', closeDialog, { class: 'secondary' }), button('Review creation', () => {
            try {
                safeFilename(filename.input.value, 'vcf');
                invariant(!state.catalogue.some(f => f.name.toLowerCase() === filename.input.value.toLowerCase()), 'This filename already exists.');
                const name = filename.input.value;
                previewPlan({ sourceId: name, filename: name, baseRevision: null, revision: sha256(''), content: '', beforeCount: 0, afterCount: 0, changed: ['New empty library'], kind: 'create', receipt: { operation: 'create', filename: name, beforeSha256: null, afterSha256: sha256('') } });
            }
            catch (e) {
                error.textContent = e.message;
            }
        }, { class: 'primary' })]);
}
async function selectedFiles(event) {
    try {
        if (!canLeave())
            return;
        const files = [...event.target.files].filter(f => /\.(vcf|csv)$/i.test(f.name));
        invariant(files.length, 'No VCF or CSV files were selected.');
        const adapter = new FileAdapter(files);
        await setWorkspace(adapter);
        closeDialog();
    }
    catch (e) {
        failure(e);
    }
    finally {
        event.target.value = '';
    }
}
preferences();
$('theme-button').append(icon('sun'));
$('theme-button').addEventListener('click', () => {
    document.documentElement.dataset.theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    storePreferences();
});
$('settings-button').append(icon('sliders'));
$('settings-button').addEventListener('click', settingsDialog);
$('search-icon').append(icon('search'));
$('add-contact').addEventListener('click', () => editContact());
$('library-back').append(icon('arrow'));
$('library-back').addEventListener('click', () => changePane('libraries'));
// Keep keyboard focus inside the modal, including browsers that hand Tab to chrome.
$('modal').addEventListener('keydown', event => {
    if (event.key !== 'Tab')
        return;
    const nodes = [...$('modal').querySelectorAll('button:not([disabled]),a[href],input:not([disabled]),textarea:not([disabled]),select:not([disabled]),summary,[tabindex="0"]')].filter(n => n.getClientRects().length);
    if (!nodes.length) {
        event.preventDefault();
        return;
    }
    const first = nodes[0], last = nodes.at(-1), active = document.activeElement;
    if ((event.shiftKey && active === first) || (!event.shiftKey && active === last) || !$('modal').contains(active)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
    }
});
$('modal-close').append(icon('close'));
$('modal-close').addEventListener('click', closeDialog);
$('modal').addEventListener('cancel', e => {
    e.preventDefault();
    closeDialog();
});
$('source-button').addEventListener('click', () => sourceDialog());
$('open-button').prepend(icon('plus'));
$('open-button').addEventListener('click', openSourceDialog);
$('library-actions').append(iconButton('refresh', 'Refresh library catalogue', safeAction(refreshCatalogue)), iconButton('plus', 'Open a source', openSourceDialog));
$('file-input').addEventListener('change', selectedFiles);
$('folder-input').addEventListener('change', selectedFiles);
$('welcome-connect').addEventListener('click', connectDialog);
$('search').addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => list.refresh().catch(failure), 120);
});
document.addEventListener('keydown', event => {
    if (event.key === '/' && !$('modal').open && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)) {
        event.preventDefault();
        changePane('list');
        $('search').focus();
    }
    if (event.key === 'Escape' && !$('modal').open && $('search').value) {
        $('search').value = '';
        list.refresh().catch(failure);
    }
});
window.addEventListener('beforeunload', event => {
    if (state.busy || state.adapter?.changed || state.receipts.length) {
        event.preventDefault();
        event.returnValue = '';
    }
});
window.addEventListener('pagehide', event => {
    if (!event.persisted) {
        state.adapter?.clear();
        engine.destroy();
        list.destroy();
        if (portraitURL)
            URL.revokeObjectURL(portraitURL);
    }
});
renderShell();
list.refresh({ selectFirst: false }).catch(failure);
// Connect to the server silently. Without a server session the empty workspace stays open for local files.
const adapter = new PHPAdapter();
adapter.login().then(() => setWorkspace(adapter)).catch(() => {
    adapter.clear();
});
