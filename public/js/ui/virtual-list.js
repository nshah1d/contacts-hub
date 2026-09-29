import { el, initials, icon } from './dom.js';
/** Vertical slot per row: the 64px .contact-row in assets/app.css plus a 2px gap. The browser gate imports it. */
export const ROW_HEIGHT = 66;
/**
 * Renders only the rows around the scroll position, fetched from the worker 80 at a time.
 * A spacer sized to the full result keeps the scrollbar, keyboard navigation and alphabet
 * jumps addressing the complete result set. Responses for an older search are discarded.
 */
export class ContactList {
    constructor({ engine, params, onSelect, onResult, onError }) {
        Object.assign(this, { engine, params, onSelect, onResult, onError });
        this.list = document.querySelector('#contact-list');
        this.window = document.querySelector('#list-window');
        this.spacer = document.querySelector('#list-spacer');
        this.alphabet = document.querySelector('#alphabet');
        this.generation = 0;
        this.requestNumber = 0;
        this.total = 0;
        this.activeIndex = -1;
        this.selectedId = null;
        this.offset = -1;
        this.items = [];
        this.list.addEventListener('scroll', () => {
            if (this.frame)
                return;
            this.frame = requestAnimationFrame(() => {
                this.frame = null;
                this.load().catch(onError);
            });
        }, { passive: true });
        this.list.addEventListener('keydown', event => this.key(event));
    }
    async refresh({ selectFirst = true, selectedId = null } = {}) {
        this.focusId = selectedId;
        this.generation++;
        this.offset = -1;
        this.total = 0;
        this.activeIndex = -1;
        this.selectedId = null;
        this.list.scrollTop = 0;
        this.items = [];
        this.window.replaceChildren();
        this.list.removeAttribute('aria-activedescendant');
        const result = await this.load(true);
        if (selectedId && result?.focusIndex >= 0) {
            await this.go(result.focusIndex, true);
            return;
        }
        if (selectFirst && this.items.length) {
            this.activeIndex = 0;
            this.selectedId = this.items[0].id;
            this.draw();
            this.onSelect(this.items[0].id, false);
        }
    }
    async load(force = false) {
        const offset = Math.max(0, Math.floor(this.list.scrollTop / ROW_HEIGHT) - 6);
        if (!force && offset === this.offset)
            return;
        const generation = this.generation, request = ++this.requestNumber;
        this.offset = offset;
        const result = await this.engine.request('query', { ...this.params(), offset, limit: 80, focusId: this.focusId });
        if (generation !== this.generation || request !== this.requestNumber)
            return;
        this.total = result.total;
        this.items = result.items;
        this.resultOffset = result.offset;
        this.spacer.style.height = `${result.total * ROW_HEIGHT}px`;
        this.draw();
        this.alphabet.replaceChildren(...result.alpha.map(a => el('button', { type: 'button', 'aria-label': `Jump to ${a.letter}`, onclick: () => this.go(a.index, false) }, a.letter)));
        this.onResult(result);
        return result;
    }
    draw() {
        this.window.replaceChildren(...this.items.map((item, i) => {
            const index = this.resultOffset + i;
            const row = el('div', { class: 'contact-row', role: 'option', id: `contact-option-${index}`, 'aria-selected': item.id === this.selectedId,
                'aria-posinset': index + 1, 'aria-setsize': this.total, 'data-contact-id': item.id, onclick: () => {
                    this.activeIndex = index;
                    this.selectedId = item.id;
                    this.draw();
                    this.onSelect(item.id, true);
                } });
            row.style.top = `${index * ROW_HEIGHT}px`;
            const avatar = el('span', { class: 'avatar', 'data-tone': tone(item.name) }, initials(item.name));
            const mark = el('span', { class: 'row-mark' });
            if (item.myCard)
                mark.append(el('span', { 'aria-label': 'My Card' }, 'me'));
            else if (item.favourite)
                mark.append(icon('star'));
            else if (item.review)
                mark.append(icon('link'));
            row.append(avatar, el('span', { class: 'name-block' }, el('strong', {}, item.name), el('small', {}, item.secondary)), mark);
            return row;
        }));
        const visible = this.items.findIndex(e => e.id === this.selectedId);
        if (visible >= 0)
            this.list.setAttribute('aria-activedescendant', `contact-option-${this.resultOffset + visible}`);
        else
            this.list.removeAttribute('aria-activedescendant');
    }
    async go(index, select = true) {
        if (!this.total)
            return;
        index = Math.max(0, Math.min(index, this.total - 1));
        const y = index * ROW_HEIGHT;
        if (y < this.list.scrollTop || y + ROW_HEIGHT > this.list.scrollTop + this.list.clientHeight)
            this.list.scrollTop = y;
        await this.load(true);
        if (select) {
            const row = this.items[index - this.resultOffset];
            if (row) {
                this.activeIndex = index;
                this.selectedId = row.id;
                this.draw();
                this.onSelect(row.id, false);
            }
        }
        this.list.focus();
    }
    key(event) {
        let index = this.activeIndex;
        if (event.key === 'ArrowDown')
            index++;
        else if (event.key === 'ArrowUp')
            index = Math.max(0, index - 1);
        else if (event.key === 'Home')
            index = 0;
        else if (event.key === 'End')
            index = this.total - 1;
        else if (event.key === 'PageDown')
            index += Math.max(1, Math.floor(this.list.clientHeight / ROW_HEIGHT));
        else if (event.key === 'PageUp')
            index -= Math.max(1, Math.floor(this.list.clientHeight / ROW_HEIGHT));
        else if (event.key === 'Enter' && this.selectedId) {
            event.preventDefault();
            this.onSelect(this.selectedId, true);
            return;
        }
        else
            return;
        event.preventDefault();
        this.go(index).catch(this.onError);
    }
    destroy() {
        this.generation++;
        if (this.frame)
            cancelAnimationFrame(this.frame);
    }
}
export function tone(name) {
    return [...name].reduce((n, c) => n + c.codePointAt(0), 0) % 6;
}
