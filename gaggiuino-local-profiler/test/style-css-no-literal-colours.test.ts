// #1618: every colour in style.css has to come from a token in tokens.css.
// A literal that only looks right on the dark theme is how the light theme
// became unreadable in the first place, and it is invisible to typecheck,
// lint and every DOM test. This guard is the only place that notices.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import postcss from 'postcss';

const here = dirname(fileURLToPath(import.meta.url));
const CSS_PATH = join(here, '..', 'public-src', 'style.css');

// These are keywords, not palette entries: `transparent`/`currentColor` mean
// "whatever is behind this" and "the current text colour", and the rest are
// CSS-wide keywords. Everything else must be a var(--token) from tokens.css.
const ALLOWED = new Set([
  'transparent',
  'currentcolor',
  'inherit',
  'initial',
  'unset',
  'revert',
  'revert-layer',
  'none',
]);

// Hex and colour functions are matched structurally; named colours are
// matched as whole value tokens so `white-space: nowrap` cannot trip it.
const LITERAL_FUNCTION = /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/i;
const LITERAL_HEX = /#[0-9a-f]{3,8}\b/i;
const NAMED_COLOURS = new Set(
  (
    'aliceblue antiquewhite aqua aquamarine azure beige bisque black ' +
    'blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse ' +
    'chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan ' +
    'darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta ' +
    'darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen ' +
    'darkslateblue darkslategray darkslategrey darkturquoise darkviolet ' +
    'deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite ' +
    'forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green ' +
    'greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender ' +
    'lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan ' +
    'lightgoldenrodyellow lightgray lightgreen lightgrey lightpink ' +
    'lightsalmon lightseagreen lightskyblue lightslategray lightslategrey ' +
    'lightsteelblue lightyellow lime limegreen linen magenta maroon ' +
    'mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen ' +
    'mediumslateblue mediumspringgreen mediumturquoise mediumvioletred ' +
    'midnightblue mintcream mistyrose moccasin navajowhite navy oldlace ' +
    'olive olivedrab orange orangered orchid palegoldenrod palegreen ' +
    'paleturquoise palevioletred papayawhip peachpuff peru pink plum ' +
    'powderblue purple rebeccapurple red rosybrown royalblue saddlebrown ' +
    'salmon sandybrown seagreen seashell sienna silver skyblue slateblue ' +
    'slategray slategrey snow springgreen steelblue tan teal thistle tomato ' +
    'turquoise violet wheat white whitesmoke yellow yellowgreen'
  ).split(/\s+/),
);

function offendersIn(decl: { value: string }): string[] {
  // Data-URI SVGs carry colours of their own (`stroke='%2371717a'`) and are
  // images, not palette values. Remove the payload before scanning.
  const value = decl.value.replace(/url\((?:[^()]|\([^()]*\))*\)/gi, 'url()');
  const found: string[] = [];
  if (LITERAL_HEX.test(value) || LITERAL_FUNCTION.test(value)) found.push(value);
  for (const token of value.split(/[\s,()]+/)) {
    const lower = token.toLowerCase();
    if (NAMED_COLOURS.has(lower) && !ALLOWED.has(lower)) found.push(value);
  }
  return [...new Set(found)];
}

describe('public-src/style.css colour literals', () => {
  it('uses theme tokens instead of literal colours', () => {
    // Custom properties are the token definitions themselves (the local
    // --coffee-*/--ach-* palettes live in style.css next to their feature),
    // so only declarations that consume a colour are checked.
    const root = postcss.parse(readFileSync(CSS_PATH, 'utf-8'), { from: CSS_PATH });
    const offenders: string[] = [];
    root.walkDecls((decl) => {
      if (decl.prop.startsWith('--')) return;
      for (const value of offendersIn(decl)) {
        offenders.push(`${decl.prop}: ${value} (style.css:${decl.source?.start?.line})`);
      }
    });
    expect(
      offenders,
      'literal colour(s) in style.css — add a token to tokens.css and use var(--token):\n' +
        offenders.join('\n'),
    ).toEqual([]);
  });
});
