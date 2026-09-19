// Type shim for the not-yet-migrated flavor-match.js (TypeScript migration
// package A4, #1113). Only the symbols consumed by components/ are declared;
// delete this file once the module is converted.
import type { FlavorNode } from './flavor-data.js';

export function normalizeFlavor(s: unknown): string;
export function matchFlavors(flavors: unknown): { matched: Set<string>; unmatched: string[] };
export function markLit(node: FlavorNode, matched: Set<string>): boolean;
export function parentIdOf(nodeId: string): string | null;
export function nodeById(nodeId: string): FlavorNode | null;
export function pathToNode(nodeId: string): string[];
export function findAutoZoomTarget(categories: FlavorNode[]): string | null;
export function colorForNode(id: string): string;
