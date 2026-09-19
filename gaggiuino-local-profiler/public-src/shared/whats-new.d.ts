// Type shim for the not-yet-migrated shared/whats-new.js (TypeScript
// migration package A4, #1113). Only the symbol consumed by components/ is
// declared; delete this file once the module is converted.
export interface WhatsNewEntry {
  version: string;
  date: string;
  highlights: string[];
}

export function getWhatsNewEntries(): WhatsNewEntry[];
