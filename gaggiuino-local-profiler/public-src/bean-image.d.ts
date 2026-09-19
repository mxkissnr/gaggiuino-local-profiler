// Type shim for the not-yet-migrated bean-image.js (TypeScript migration
// package A4, #1113). Only the symbol consumed by components/ is declared;
// delete this file once the module is converted.
export function loadBeanImageBlobUrl(beanId: unknown): Promise<string | null>;
