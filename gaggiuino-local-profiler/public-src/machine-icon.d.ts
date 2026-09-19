// Type shim for the not-yet-migrated machine-icon.js (TypeScript migration
// package A4, #1113). Only the symbols consumed by components/ are declared;
// delete this file once the module is converted.
export type MachineIconKind = 'gaggiuino' | 'gaggimate';

export type MachineIconMode =
  | 'off'
  | 'heating'
  | 'hot'
  | 'brewing'
  | 'steaming'
  | 'flushing'
  | 'descaling';

export interface MachineIconState {
  mode: MachineIconMode;
  heatFraction: number;
}

export const MACHINE_ICON_LIVE_CLASS: string;
export const MACHINE_ICON_MODES: Readonly<Record<MachineIconMode, readonly string[]>>;

export function machineIconSvg(theme: unknown, kind?: unknown): string;
export function machineIconMiniSvg(theme: unknown, kind?: unknown): string;
export function machineIconAnimatedSvg(theme: unknown, kind?: unknown): string;
export function setMachineIconMode(rootEl: Element, mode: MachineIconMode, heatFraction?: number): void;
export function resolveMachineIconState(msg: unknown, preheat: unknown): MachineIconState;
