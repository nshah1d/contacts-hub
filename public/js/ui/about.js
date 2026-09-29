import { el } from './dom.js';
/** Credit and links shown in the About section of the settings dialog. */
export const ABOUT = Object.freeze({
    credit: 'Made by Nauman Shahid.',
    links: Object.freeze([
        Object.freeze({ label: 'nauman.cc', href: 'https://www.nauman.cc' }),
        Object.freeze({ label: 'GitHub', href: 'https://github.com/nshah1d' }),
        Object.freeze({ label: 'LinkedIn', href: 'https://www.linkedin.com/in/nshah1d/' }),
        Object.freeze({ label: 'Support on Ko-fi', href: 'https://ko-fi.com/nshah1d' })
    ])
});
/** The About section. Links open in a new tab without sending a referrer. */
export function aboutSection() {
    return el('section', { class: 'about', 'aria-labelledby': 'about-heading' },
        el('h3', { id: 'about-heading', class: 'eyebrow' }, 'About'),
        el('p', { class: 'about-credit' }, ABOUT.credit),
        el('div', { class: 'about-links' }, ABOUT.links.map((link, i) =>
            el('a', { href: link.href, target: '_blank', rel: 'noopener noreferrer', class: i === ABOUT.links.length - 1 ? 'about-link support' : 'about-link' }, link.label))));
}
