// Type shim for the not-yet-migrated bean-image.js (TypeScript migration
// package A4/A5, #1113/#1115). Only the symbols consumed by components/ and
// views/ are declared; delete this file once the module is converted.
export function loadBeanImageBlobUrl(beanId: unknown): Promise<string | null>;
export function loadShotImageBlobUrl(shotId: number): Promise<string | null>;
export function invalidateShotImage(shotId: number): void;
export function loadGrinderImageBlobUrl(grinderId: unknown): Promise<string | null>;
export function invalidateGrinderImage(grinderId: unknown): void;
export function invalidateBeanImage(beanId: unknown): void;
export function loadBasketImageBlobUrl(basketId: unknown): Promise<string | null>;
export function invalidateBasketImage(basketId: unknown): void;
export function loadPuckScreenImageBlobUrl(puckScreenId: unknown): Promise<string | null>;
export function invalidatePuckScreenImage(puckScreenId: unknown): void;
