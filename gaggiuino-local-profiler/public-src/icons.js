// #417: shared stroke-SVG icon constants (currentColor, stroke-width ~1.8,
// same .rail-icon treatment as #415/#416) for decorative glyphs reused
// across multiple views. Single-use icons stay local to their view.

export const TARGET_ICON_SVG = '<svg class="rail-icon sm" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r="0.5"/></svg>';

export const SLIDERS_ICON_SVG = '<svg class="rail-icon sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5v6M5 15v4M12 5v2M12 11v8M19 5v11M19 20v0"/><circle cx="5" cy="13" r="2"/><circle cx="12" cy="9" r="2"/><circle cx="19" cy="18" r="2"/></svg>';

export const FLAVOR_WHEEL_ICON_SVG = '<svg class="rail-icon sm" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 3.5v17M3.5 12h17M5.8 5.8l12.4 12.4M18.2 5.8 5.8 18.2"/></svg>';

export const COFFEE_ICON_SVG = '<svg class="rail-icon sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M17 8h1a3 3 0 0 1 0 6h-1M4 8h13v7a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4V8z"/><path d="M8 2v2M12 2v2"/></svg>';

export const WATER_DROP_ICON_SVG = '<svg class="rail-icon sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z"/></svg>';

export const ICE_CUBE_ICON_SVG = '<svg class="rail-icon sm" viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="2"/><path d="M4 9h16M4 15h16M9 4v16M15 4v16"/></svg>';

export const LINK_ICON_SVG = '<svg class="rail-icon sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M9.5 14.5 14.5 9.5"/><path d="M11 6.5 12.5 5a3.5 3.5 0 0 1 5 5L16 11.5"/><path d="M13 17.5 11.5 19a3.5 3.5 0 0 1-5-5L8 12.5"/></svg>';

export const WRENCH_ICON_SVG = '<svg class="rail-icon sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M14.7 6.3a4 4 0 0 1-5.4 5.4L4 17l3 3 5.3-5.3a4 4 0 0 1 5.4-5.4l-2.5 2.5-2-2z"/></svg>';

export const CLOCK_ICON_SVG = '<svg class="rail-icon sm" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3.5 2"/></svg>';

export const BELL_ICON_SVG = '<svg class="rail-icon sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9a6 6 0 0 1 12 0c0 3.5 1 5 2 6H4c1-1 2-2.5 2-6z"/><path d="M10 19a2 2 0 0 0 4 0"/></svg>';

// #419 follow-up: same reuse-a-shared-icon pattern for the remaining
// i18n-embedded decorative glyphs found outside the original #417 sweep
// (bean_age_at_shot, lib_scan_barcode, lib_url_import, lib_import_settings_btn,
// settings_machine_experimental_badge).

export const BEAN_ICON_SVG = '<svg class="rail-icon sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 12c0-4 3-7.5 7-7.5S19 8 19 12s-3.5 7-7.5 7A6.5 6.5 0 0 1 6 12z"/><path d="M8.5 15c2-1 3-3 3-6"/></svg>';

export const BARCODE_ICON_SVG = '<svg class="rail-icon sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5v14M8 5v14M11 5v14M13 5v14M17 5v14M20 5v14"/></svg>';

export const GEAR_ICON_SVG = '<svg class="rail-icon sm" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M12 4v2.5M12 17.5V20M4 12h2.5M17.5 12H20M6.3 6.3l1.8 1.8M15.9 15.9l1.8 1.8M17.7 6.3l-1.8 1.8M8.1 15.9l-1.8 1.8"/></svg>';

export const WARNING_ICON_SVG = '<svg class="rail-icon sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4 3 20h18z"/><path d="M12 10v4"/><path d="M12 17v.01"/></svg>';

// Exhaustive sweep follow-up (coordinator mandate, #417): sort-by-rating
// button, chart time-tab, theme toggle, channeling warning and the shot
// verdict/grind-advice icon fields.

export const STAR_ICON_SVG = '<svg class="rail-icon sm" viewBox="0 0 24 24" aria-hidden="true"><path d="m12 2 3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01z"/></svg>';

export const LIGHTNING_ICON_SVG = '<svg class="rail-icon sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M13 2 4 14h6l-1 8 9-12h-6z"/></svg>';

export const SCALE_ICON_SVG = '<svg class="rail-icon sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v18M4 7h16"/><path d="M2 7l3 6a3 3 0 0 0 6 0L8 7"/><path d="M16 7l3 6a3 3 0 0 0 6 0l-3-6"/></svg>';

export const BAR_CHART_ICON_SVG = '<svg class="rail-icon sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 20V10M12 20V4M19 20v-7"/></svg>';

export const MOON_ICON_SVG = '<svg class="rail-icon sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z"/></svg>';

export const SUN_ICON_SVG = '<svg class="rail-icon sm" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2.5M12 19.5V22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M2 12h2.5M19.5 12H22M4.9 19.1l1.8-1.8M17.3 6.7l1.8-1.8"/></svg>';
