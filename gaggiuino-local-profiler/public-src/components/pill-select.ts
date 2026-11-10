// Shows a <select> of up to 5 short options as visible pills (#1962,
// docs/DESIGN.md "Choosing"). The hidden select stays the source of truth.

// vitest's node environment has no DOM, and importing this module must not throw there.
const proto = typeof HTMLSelectElement === 'undefined' ? undefined : HTMLSelectElement.prototype;
const descriptor = (prop: 'value' | 'disabled'): PropertyDescriptor | undefined =>
  proto ? Object.getOwnPropertyDescriptor(proto, prop) : undefined;

export function bindPillSelect(select: HTMLSelectElement | null): void {
  if (!select || select.dataset.pillsBound) return;
  select.dataset.pillsBound = '1';
  select.style.display = 'none';

  const group = document.createElement('div');
  group.className = 'theme-toggle-group';
  group.setAttribute('role', 'group');
  const label = select.getAttribute('aria-label');
  if (label) group.setAttribute('aria-label', label);

  const clearable = Array.from(select.options).some(o => o.value === '');
  const buttons = Array.from(select.options).filter(o => o.value !== '').map(option => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'theme-btn';
    btn.dataset.val = option.value;
    btn.textContent = option.textContent;
    // The translation pass reaches the pill the same way it reaches the option.
    const key = option.getAttribute('data-i18n');
    if (key) btn.setAttribute('data-i18n', key);
    btn.addEventListener('click', () => {
      const next = clearable && select.value === option.value ? '' : option.value;
      select.value = next;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    return btn;
  });

  const paint = (): void => {
    for (const btn of buttons) {
      const on = btn.dataset.val === select.value;
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-pressed', String(on));
      btn.disabled = select.disabled;
    }
  };

  // The form code writes the select directly (`select.value = x`,
  // `select.disabled = true`); mirroring both accessors repaints the pills
  // without every form-open function having to remember to.
  const valueProp = descriptor('value');
  const valueGet = valueProp?.get;
  const valueSet = valueProp?.set;
  if (valueGet && valueSet) {
    Object.defineProperty(select, 'value', {
      configurable: true,
      get: (): string => valueGet.call(select) as string,
      set: (v: string) => { valueSet.call(select, v); paint(); },
    });
  }
  const disabledProp = descriptor('disabled');
  const disabledGet = disabledProp?.get;
  const disabledSet = disabledProp?.set;
  if (disabledGet && disabledSet) {
    Object.defineProperty(select, 'disabled', {
      configurable: true,
      get: (): boolean => disabledGet.call(select) as boolean,
      set: (v: boolean) => { disabledSet.call(select, v); paint(); },
    });
  }
  for (const btn of buttons) group.appendChild(btn);
  select.insertAdjacentElement('afterend', group);
  paint();
}

export function bindPillSelects(root: ParentNode = document): void {
  root.querySelectorAll<HTMLSelectElement>('select[data-pills]').forEach(bindPillSelect);
}
