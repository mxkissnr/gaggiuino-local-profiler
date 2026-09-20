// Type shim for the not-yet-migrated glp-qr.js (TypeScript migration package
// A5, #1115). Only the symbols consumed by views/library.ts are declared;
// delete this file once the module is converted.
export function generateBeanQR(bean: Record<string, unknown>): string;

export function parseGlpQrParams(
  raw: unknown,
): { name: string; roaster: string; roastDate: string; notes: string } | null;
