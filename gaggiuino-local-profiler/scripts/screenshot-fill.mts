// Pure helpers behind the README fill check in scripts/screenshots.mts
// (#2189). No imports on purpose: the unit test loads this module without
// booting the throwaway instance that the screenshot script starts.

/** Largest share of a README image's height that may be empty background below the content. */
export const MAX_EMPTY_FRACTION = 0.1;

/** Vertical extent of one visible content element, in viewport pixels. */
export interface VBox { top: number; bottom: number }

/** The part of the window a PNG shows, in viewport pixels. */
export interface Frame { top: number; height: number }

/** A screenshot clip rectangle, in viewport pixels. */
export interface Rect { x: number; y: number; width: number; height: number }

/**
 * Share of `frame`'s height that lies below the lowest content box. Boxes
 * without height and boxes wholly outside the frame do not count; content
 * running past the frame bottom fills it. No content at all yields 1.
 */
export function emptyBandFraction(boxes: readonly VBox[], frame: Frame): number {
    if (!(frame.height > 0)) return 1;
    const frameBottom = frame.top + frame.height;
    let contentBottom = frame.top;
    for (const b of boxes) {
        if (!(b.bottom > b.top) || b.bottom <= frame.top || b.top >= frameBottom) continue;
        contentBottom = Math.max(contentBottom, Math.min(b.bottom, frameBottom));
    }
    return (frameBottom - contentBottom) / frame.height;
}

/** Problem text naming the view when its empty band is over the limit; null when the image is filled. */
export function fillProblem(name: string, boxes: readonly VBox[], frame: Frame, maxEmpty = MAX_EMPTY_FRACTION): string | null {
    const empty = emptyBandFraction(boxes, frame);
    if (empty <= maxEmpty) return null;
    return `${name}: ${(empty * 100).toFixed(1)}% of the frame height is empty background below the content (limit ${Math.round(maxEmpty * 100)}%)`;
}

/**
 * Clip around `box` with the viewport's aspect ratio: the box's full height
 * and the matching width, centred on the box and kept inside the window.
 * Falls back to the whole window when such a clip would not fit.
 */
export function aspectClip(box: Rect, viewport: { width: number; height: number }): Rect {
    const height = Math.round(box.height);
    const width = Math.round(height * viewport.width / viewport.height);
    const y = Math.round(box.y);
    if (width > viewport.width || y < 0 || y + height > viewport.height) {
        return { x: 0, y: 0, width: viewport.width, height: viewport.height };
    }
    const x = Math.min(Math.max(0, Math.round(box.x + box.width / 2 - width / 2)), viewport.width - width);
    return { x, y, width, height };
}
