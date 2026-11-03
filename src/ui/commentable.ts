/**
 * Right-click to comment, as in Word (§11.8 step 3.1, decided 2026-11-02).
 *
 * Anything a comment can be about carries its identity in three attributes —
 * `{...about(target)}` — and the report's content area uses the
 * `commentable` action. A right-click on such an item, or on empty space for
 * the tab as a whole, asks for the menu; items already commented on get a
 * light highlight, kept up to date as panels load and change.
 */
import type { Target } from '../notes/document.ts';

/** The attributes that make an element commentable. */
export function about(t: Target): Record<string, string> {
  return { 'data-ck': t.key, 'data-cl': t.label, 'data-cv': t.value };
}

export interface MenuRequest {
  readonly x: number;
  readonly y: number;
  /** null: the empty space of the tab — a comment on the tab as a whole. */
  readonly target: Target | null;
}

interface Params {
  readonly commented: ReadonlySet<string>;
  readonly onMenu: (m: MenuRequest) => void;
}

function targetOf(el: Element | null): Target | null {
  const item = el?.closest('[data-ck]');
  if (!item) return null;
  return { key: item.getAttribute('data-ck')!, label: item.getAttribute('data-cl') ?? '', value: item.getAttribute('data-cv') ?? '' };
}

export function commentable(node: HTMLElement, params: Params) {
  let current = params;
  const mark = () => {
    for (const el of node.querySelectorAll('[data-ck]')) {
      el.classList.toggle('has-comment', current.commented.has(el.getAttribute('data-ck')!));
    }
  };
  const onContext = (e: MouseEvent) => {
    // Typing in a box keeps the ordinary menu: copy, paste, spelling.
    if ((e.target as Element).closest('input, textarea, select')) return;
    e.preventDefault();
    current.onMenu({ x: e.clientX, y: e.clientY, target: targetOf(e.target as Element) });
  };
  // Panels load after the tab opens (news, insider dealings): highlight what arrives.
  const observer = new MutationObserver(mark);
  observer.observe(node, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-ck'] });
  node.addEventListener('contextmenu', onContext);
  mark();
  return {
    update(next: Params) { current = next; mark(); },
    destroy() { observer.disconnect(); node.removeEventListener('contextmenu', onContext); },
  };
}

/**
 * Scrolls to the item a comment is about and flashes it. Waits a few seconds
 * for a panel still loading; false if the item is no longer on screen.
 */
export function reveal(container: HTMLElement, key: string, wait = 3000): Promise<boolean> {
  const find = () => [...container.querySelectorAll('[data-ck]')].find((el) => el.getAttribute('data-ck') === key) ?? null;
  return new Promise((resolve) => {
    const show = (el: Element) => {
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      el.classList.add('flash');
      setTimeout(() => el.classList.remove('flash'), 2200);
      resolve(true);
    };
    const now = find();
    if (now) { show(now); return; }
    const observer = new MutationObserver(() => {
      const el = find();
      if (el) { observer.disconnect(); clearTimeout(timer); show(el); }
    });
    observer.observe(container, { childList: true, subtree: true });
    const timer = setTimeout(() => { observer.disconnect(); resolve(false); }, wait);
  });
}
