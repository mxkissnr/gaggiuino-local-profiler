// Marks a field that failed validation, at the field (#1962, docs/DESIGN.md
// "Errors"). Clears as soon as the user types.
export function markFieldInvalid(input: HTMLElement | null): void {
  if (!input) return;
  input.setAttribute('aria-invalid', 'true');
  input.style.outline = '2px solid var(--err)';
  input.focus();
  const clear = (): void => {
    input.removeAttribute('aria-invalid');
    input.style.outline = '';
    input.removeEventListener('input', clear);
  };
  input.addEventListener('input', clear);
}
