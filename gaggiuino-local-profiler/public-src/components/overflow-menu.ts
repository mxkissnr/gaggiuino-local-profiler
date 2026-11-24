// #2165: one behaviour for every overflow menu in the shared pattern
// (docs/DESIGN.md): details.lib-sheet-more > summary + .lib-sheet-menu-list
// > button.lib-sheet-menu-item. The native <details>/<summary> pair opens on
// a click, Enter and Space; this adds the rest once for the whole app: one
// menu open at a time, the list opens upward when it would end below the
// window, a pick or a press outside closes the menu, and Escape closes it
// and puts the focus back on its summary. The top bar's nav overflow is a
// details.topbar-nav-more with its own wiring and is not matched here.

const MENU = 'details.lib-sheet-more';
const UP = 'lib-sheet-menu-list--up';

function openMenus(): HTMLDetailsElement[] {
  return Array.from(document.querySelectorAll<HTMLDetailsElement>(`${MENU}[open]`));
}

function focusSummary(menu: HTMLDetailsElement): void {
  menu.querySelector<HTMLElement>('summary')?.focus();
}

// Opens the list upward when its bottom would sit below the window.
export function placeOverflowMenu(menu: HTMLDetailsElement, viewportHeight: number): void {
  const list = menu.querySelector<HTMLElement>('.lib-sheet-menu-list');
  if (!list) return;
  list.classList.remove(UP);
  if (list.getBoundingClientRect().bottom > viewportHeight) list.classList.add(UP);
}

function onToggle(e: Event): void {
  const menu = e.target as HTMLDetailsElement | null;
  if (!menu || !menu.matches(MENU) || !menu.open) return;
  for (const other of openMenus()) if (other !== menu) other.open = false;
  placeOverflowMenu(menu, window.innerHeight);
}

// A pick closes its menu before the entry's own handler runs; a keyboard
// pick keeps the focus on the menu's summary instead of losing it.
function onClick(e: Event): void {
  const item = (e.target as Element | null)?.closest('.lib-sheet-menu-item');
  const menu = item?.closest<HTMLDetailsElement>(MENU);
  if (!menu?.open) return;
  const hadFocus = menu.contains(document.activeElement);
  menu.open = false;
  if (hadFocus) focusSummary(menu);
}

function onPointerDown(e: Event): void {
  const target = e.target as Node | null;
  for (const menu of openMenus()) if (!target || !menu.contains(target)) menu.open = false;
}

function onKeyDown(e: KeyboardEvent): void {
  if (e.key !== 'Escape') return;
  const menu = openMenus().pop();
  if (!menu) return;
  e.preventDefault();
  e.stopPropagation();
  menu.open = false;
  focusSummary(menu);
}

// Capture phase on document: runs before the click delegation on
// document.body and before the sheets' own Escape handlers, so Escape
// closes the menu and not the sheet under it.
export function wireOverflowMenus(): void {
  document.addEventListener('toggle', onToggle, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('pointerdown', onPointerDown, true);
  document.addEventListener('keydown', onKeyDown, true);
}
