/**
 * Builds a DOM element. Text always enters as text nodes or textContent and never as
 * markup, which is what keeps contact content from being interpreted as HTML.
 * @param {string} tag
 * @param {Object<string, *>} [attrs] `class`, `text`, `value`, `checked`, `disabled`,
 *     `on<event>` listeners, or any other attribute.
 * @param {...*} children Nodes or values rendered as text.
 * @returns {HTMLElement}
 */
export function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
        if (value === null || value === undefined)
            continue;
        if (key === 'class')
            node.className = value;
        else if (key === 'text')
            node.textContent = value;
        else if (key.startsWith('on') && typeof value === 'function')
            node.addEventListener(key.slice(2), value);
        else if (key === 'value')
            node.value = value;
        else if (key === 'checked')
            node.checked = !!value;
        else if (key === 'disabled')
            node.disabled = !!value;
        else
            node.setAttribute(key, String(value));
    }
    for (const child of children.flat(Infinity)) {
        if (child !== null && child !== undefined)
            node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return node;
}
export function button(text, action, attrs = {}) {
    return el('button', { type: 'button', ...attrs, onclick: action }, text);
}
export function initials(name) {
    return name.trim().split(/\s+/).filter(Boolean).slice(0, 2).map(s => [...s][0]).join('').toUpperCase() || '?';
}
export function sizeLabel(bytes) {
    return bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${(bytes / 1024).toFixed(1)} KiB` : `${(bytes / 1048576).toFixed(1)} MiB`;
}
export function download(text, name, type = 'text/plain;charset=utf-8') {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = el('a', { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export async function copyText(text) {
    if (!navigator.clipboard?.writeText)
        throw new Error('Clipboard access is unavailable on this connection. Use the download action instead.');
    await navigator.clipboard.writeText(text);
}
export function field(label, value = '', type = 'text') {
    const input = el(type === 'textarea' ? 'textarea' : 'input', { ...(type === 'textarea' ? {} : { type }), value, maxlength: 131072 });
    return { input, node: el('label', { class: 'field' }, el('span', {}, label), input) };
}
const paths = { search: 'M21 21l-4.5-4.5M19 10.5a8.5 8.5 0 1 1-17 0 8.5 8.5 0 0 1 17 0',
    plus: 'M12 5v14M5 12h14', book: 'M4 3h14a2 2 0 0 1 2 2v16H6a2 2 0 0 1-2-2V3Zm0 14h16M8 7h8M8 11h5',
    people: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M22 21v-2a4 4 0 0 0-3-3.87M15 3.13a4 4 0 0 1 0 7.75M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0',
    star: 'm12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9L12 3Z',
    link: 'M10 13a5 5 0 0 0 7 .2l3-3a5 5 0 0 0-7-7l-2 2M14 11a5 5 0 0 0-7-.2l-3 3a5 5 0 0 0 7 7l2-2',
    check: 'm5 12 4 4L19 6', sliders: 'M4 5h16M4 12h16M4 19h16M8 3v4M16 10v4M10 17v4',
    arrow: 'm14 6-6 6 6 6', source: 'M8 3H4v18h16V7l-4-4H8Zm6 0v6h6M8 13h8M8 17h6',
    phone: 'M6 3 3 5c-1 7 9 17 16 16l2-3-5-4-3 2-5-5 2-3-4-5Z', mail: 'M3 5h18v14H3V5Zm0 0 9 8 9-8',
    sun: 'M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1 1M18 18l1 1M5 19l1-1M18 6l1-1M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0',
    refresh: 'M20 7v5h-5M4 17v-5h5M6 6a8 8 0 0 1 14 6M4 12a8 8 0 0 0 14 6',
    upload: 'M12 16V3m-5 5 5-5 5 5M4 15v6h16v-6', download: 'M12 3v13m-5-5 5 5 5-5M4 17v4h16v-4',
    close: 'M6 6l12 12M6 18 18 6', edit: 'm15 4 5 5M4 20l5-1L21 7l-5-5L4 14v6Z',
    alert: 'm12 3 10 18H2L12 3Zm0 6v5m0 3v1', folder: 'M3 5h7l2 2h9v14H3V5Z', copy: 'M8 8h13v13H8V8ZM16 8V3H3v13h5' };
export function icon(name) {
    const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('width', '20');
    s.setAttribute('height', '20');
    s.setAttribute('fill', 'none');
    s.setAttribute('stroke', 'currentColor');
    s.setAttribute('stroke-width', '1.6');
    s.setAttribute('stroke-linecap', 'round');
    s.setAttribute('stroke-linejoin', 'round');
    s.setAttribute('aria-hidden', 'true');
    const p = document.createElementNS(s.namespaceURI, 'path');
    p.setAttribute('d', paths[name] || paths.book);
    s.append(p);
    return s;
}
export function iconButton(name, label, action, attrs = {}) {
    return button('', action, { 'aria-label': label, title: label, class: 'icon-button', ...attrs }).appendChild(icon(name)).parentNode;
}
