// Bean profile history in the bean detail sheet (#1963, slice 3 of 4).
// Renders what public-src/shared/bean-profiles.ts derives: the profiles proven
// for this bean (pinned first, then the ones that clear the sample/rating bar)
// and, only for a bean without any of its own, suggestions pooled from similar
// beans. Nothing is rendered when the evidence is thin — no empty box.
//
// Pinning never touches the machine: a pin is a note on the bean, stored
// through the existing partial PUT bean route, so it cannot overwrite or
// reorder the profiles on the device. The row's toggle is the "preselect" the
// issue asks for on a suggestion: one tap stores it for this bean.
import { t, tHtml } from '../../i18n.js';
import * as libraryApi from '../../api/library.js';
import { S, concreteActiveMachineId } from '../../state/index.js';
import { showToast } from '../../components/toast.js';
import { esc, html, joinHtml } from '../../utils.js';
import type { Html } from '../../utils.js';
import { pinnedProfilesOf, provenProfilesForBean, suggestProfilesForBean, togglePinnedProfile } from '../../shared/bean-profiles.js';
import type { ProfileBean, ProfileContext, ProfileRow, ProfileShot } from '../../shared/bean-profiles.js';
import { _beanList } from './bean-shared.js';
import type { BeanListRow } from './bean-shared.js';
import * as libraryView from '../library.js';

// Circular with library.ts (it re-exports the bean card): the namespace is
// dereferenced inside functions only, never copied at module load.

// A thumbtack in the shot-log icon's stroke style: the sheet's content rows
// carry the app's small rail icons, not a second icon language.
const ICON_PIN = `<svg class="rail-icon sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4h6"/><path d="M10 4v6l-3 4h10l-3-4V4"/><path d="M12 14v6"/></svg>` as Html;

// Bean ids with an in-flight pin request — a slow save must not be doubled by
// a second tap before the first one's re-render lands (same guard as the
// archive toggle in bean-sheet.ts).
const _pendingPinToggles = new Set<number>();

// S.machines is typed as the bare MachineRecord (id + index signature), so the
// name is narrowed here rather than cast at every use.
function _machineName(id: number): string {
  const name = S.machines.find(m => m.id === id)?.name;
  return typeof name === 'string' && name !== '' ? name : `#${id}`;
}

// The selected machine's own profile names, for flagging rows that are gone.
// Only a concrete machine has a list to compare against, and a stale or empty
// list says nothing — both keep everything unflagged.
function _availableNames(machineId: number | null): ReadonlySet<string> | null {
  if (machineId == null || S.machineProfilesStale || !S.machineProfiles.length) return null;
  return new Set(S.machineProfiles.map(p => p.name.trim().toLowerCase()));
}

function _profileContext(): ProfileContext {
  const machineId = concreteActiveMachineId();
  return {
    shots: S.shots as unknown as ProfileShot[],
    beans: _beanList() as unknown as ProfileBean[],
    machineId,
    availableNames: _availableNames(machineId),
  };
}

function _supportText(row: ProfileRow): Html {
  if (row.avgRating != null) return esc(t('bean_profile_support', row.avgRating.toFixed(1), row.ratedShots));
  return row.pinned ? esc(t('bean_profile_pinned_no_shots')) : esc('');
}

function _rowSub(row: ProfileRow, showMachine: boolean, fromSimilar: boolean): Html {
  const parts: Html[] = [_supportText(row)];
  if (row.missing) parts.push(esc(t('bean_profile_missing')));
  if (fromSimilar && row.beanCount > 0) parts.push(esc(t('bean_profile_from_beans', row.beanCount)));
  if (fromSimilar && row.pinnedBy > 0) parts.push(esc(t('bean_profile_pinned_by', row.pinnedBy)));
  if (showMachine) parts.push(esc(_machineName(row.machineId)));
  const present = parts.filter(p => p !== '');
  return html`<div class="lib-profile-sub">${joinHtml(present.map((p, i) => i ? html` · ${p}` : p))}</div>`;
}

function _rowHtml(beanId: number, row: ProfileRow, showMachine: boolean, fromSimilar: boolean): Html {
  const label = t(row.pinned ? 'bean_profile_unpin' : 'bean_profile_pin', row.name);
  return html`<div class="lib-profile-row">
      <div class="lib-profile-text">
        <div class="lib-profile-name">${esc(row.name)}</div>
        ${_rowSub(row, showMachine, fromSimilar)}
      </div>
      <button type="button" class="lib-sheet-iconbtn lib-profile-pin" data-action="toggle-bean-profile-pin" data-id="${esc(beanId)}" data-machine-id="${esc(row.machineId)}" data-profile="${esc(row.name)}" aria-pressed="${esc(row.pinned ? 'true' : 'false')}" aria-label="${esc(label)}">${ICON_PIN}</button>
    </div>`;
}

/**
 * The "Proven profiles" section of the bean card: the bean's own rows when it
 * has any, otherwise up to three suggestions from similar beans, otherwise
 * nothing at all.
 */
export function renderBeanProfiles(b: BeanListRow): Html {
  const ctx = _profileContext();
  const bean = b as unknown as ProfileBean;
  const proven = provenProfilesForBean(bean, ctx);
  const fromSimilar = proven.length === 0;
  const rows = fromSimilar ? suggestProfilesForBean(bean, ctx) : proven;
  if (!rows.length) return esc('');
  const titleKey = fromSimilar ? 'bean_profiles_suggested_title' : 'bean_profiles_title';
  // A row without its machine is ambiguous only when "all machines" pools them.
  const showMachine = ctx.machineId == null && S.machines.length > 1;
  return html`<div class="lib-sheet-profiles">
      <div class="lib-sheet-aromas-title lib-sheet-profiles-title">${tHtml(titleKey)}</div>
      ${joinHtml(rows.map(row => _rowHtml(b.id, row, showMachine, fromSimilar)))}
    </div>`;
}

/**
 * Pins or unpins one profile for a bean. Only the bean's own `pinnedProfiles`
 * list is written — the machine's profile list is never part of the payload.
 */
export async function toggleBeanProfilePin(beanId: number, machineId: number, name: string): Promise<void> {
  if (!Number.isInteger(machineId) || machineId <= 0) return;
  const profileName = name.trim();
  if (!profileName) return;
  if (_pendingPinToggles.has(beanId)) return;
  const bean = _beanList().find(b => b.id === beanId);
  if (!bean) return;
  _pendingPinToggles.add(beanId);
  try {
    const next = togglePinnedProfile(pinnedProfilesOf(bean), machineId, profileName);
    const saved = await libraryApi.saveBean(beanId, { pinnedProfiles: next });
    const idx = _beanList().findIndex(b => b.id === beanId);
    if (idx !== -1) _beanList()[idx] = saved as unknown as BeanListRow;
  } catch {
    // saveBean throws on a non-ok response; the bean keeps its old pins.
    showToast(t('gm_toast_save_error'));
  } finally {
    _pendingPinToggles.delete(beanId);
    libraryView.renderBeanList();
  }
}
