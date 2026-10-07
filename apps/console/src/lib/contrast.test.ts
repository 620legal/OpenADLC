import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MARK_FLOOR } from '../components/engine-avatars';
import { CREW_COLORS } from './crew-colors';
import { REPO_COLORS } from './repo-colors';

/**
 * Contrast, checked rather than assumed.
 *
 * "Looks fine" is how the dark theme shipped with its two quietest text colours
 * at 1.67:1 and 4.23:1 — the first is barely visible and the second is under AA,
 * and between them they cover about a hundred call sites. Nobody noticed because
 * nobody measured.
 *
 * So the tokens are parsed out of `globals.css` and the ratios are computed. A
 * value edited to look better in a screenshot fails here instead.
 */
const CSS = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'app', 'globals.css'),
  'utf8',
);

interface Oklch {
  L: number;
  C: number;
  h: number;
}

/** The tokens of one block, by name. */
function block(pattern: RegExp): Record<string, Oklch> {
  const match = pattern.exec(CSS);
  if (!match) throw new Error(`no block matched ${pattern}`);
  const tokens: Record<string, Oklch> = {};
  for (const line of match[1]!.matchAll(/--color-([\w-]+):\s*oklch\(([\d.]+)\s+([\d.]+)\s+([\d.]+)\)/g)) {
    tokens[line[1]!] = { L: Number(line[2]), C: Number(line[3]), h: Number(line[4]) };
  }
  return tokens;
}

/** oklch to linear sRGB, clipped to the screen's gamut. */
function linearRgb({ L, C, h }: Oklch): [number, number, number] {
  const a = C * Math.cos((h * Math.PI) / 180);
  const b = C * Math.sin((h * Math.PI) / 180);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const rgb = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map((value) => Math.max(0, Math.min(1, value)));
  return [rgb[0]!, rgb[1]!, rgb[2]!];
}

/** Relative luminance, the way WCAG defines it. */
function luminance(color: Oklch): number {
  const rgb = linearRgb(color);
  return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
}

function ratio(foreground: Oklch, background: Oklch): number {
  const a = luminance(foreground);
  const b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

const dark = block(/@theme \{([\s\S]*?)\n\}/);
const light = block(/:root\[data-theme='light'\] \{([\s\S]*?)\n\}/);

/** Everything a component puts text in. */
const TEXT = ['body', 'soft', 'muted', 'dim', 'signal', 'attention', 'alarm', 'link'] as const;
const BACKGROUNDS = ['surface', 'panel', 'well'] as const;
/**
 * The avatars' tints, which carry a bot's initials: every color a person can
 * give a crew member, so no choice in Settings → Appearance makes them
 * unreadable.
 */
const TINTS = CREW_COLORS.map((color) => `tint-${color}`);

/** AA for text below 18.66px, which is all of it here. */
const AA = 4.5;

describe.each([
  ['dark', dark],
  ['light', light],
])('%s mode', (_mode, tokens) => {
  it('defines every token the other mode does', () => {
    // A token missing from the light block falls through to the dark value and
    // is then black text on a white page, or worse, invisible.
    for (const name of [...TEXT, ...BACKGROUNDS, ...TINTS]) {
      expect(tokens[name], name).toBeDefined();
    }
  });

  it.each(TEXT.flatMap((text) => BACKGROUNDS.map((bg) => [text, bg] as const)))(
    '%s on %s meets AA',
    (text, bg) => {
      const measured = ratio(tokens[text]!, tokens[bg]!);
      expect(Number(measured.toFixed(2)), `${text} on ${bg}`).toBeGreaterThanOrEqual(AA);
    },
  );

  it.each(TINTS)('an avatar’s initials on %s meet AA', (tint) => {
    const measured = ratio(tokens.soft!, tokens[tint]!);
    expect(Number(measured.toFixed(2)), `soft on ${tint}`).toBeGreaterThanOrEqual(AA);
  });

  it.each(TINTS)('an avatar’s mark at its faintest keeps 3:1 on %s', (tint) => {
    // A mark is drawn in `soft` at an opacity, which the browser blends in
    // sRGB over the tint. At MARK_FLOOR, the faintest any part is drawn, it has
    // to stay a graphic a person can see.
    const encode = (value: number): number => (value <= 0.0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - 0.055);
    const decode = (value: number): number => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
    const fg = linearRgb(tokens.soft!).map(encode);
    const bg = linearRgb(tokens[tint]!).map(encode);
    const mixed = fg.map((value, index) => decode(MARK_FLOOR * value + (1 - MARK_FLOOR) * bg[index]!));
    const lum = (rgb: number[]): number => 0.2126 * rgb[0]! + 0.7152 * rgb[1]! + 0.0722 * rgb[2]!;
    const a = lum(mixed);
    const b = lum(linearRgb(tokens[tint]!));
    const measured = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    expect(Number(measured.toFixed(2)), `soft at ${MARK_FLOOR} on ${tint}`).toBeGreaterThanOrEqual(3);
  });

  it('keeps the tints quiet: each within reach of the panel, so none reads as a status', () => {
    for (const tint of TINTS) expect(Math.abs(tokens[tint]!.L - tokens.panel!.L), tint).toBeLessThan(0.15);
  });

  it('keeps the text ramp in order, so the names still mean something', () => {
    // `dim` quieter than `muted` quieter than `soft` quieter than `body`. If two
    // collapse onto each other the ramp has four names and three steps.
    const against = tokens.panel!;
    const steps = (['dim', 'muted', 'soft', 'body'] as const).map((name) => ratio(tokens[name]!, against));
    for (let i = 1; i < steps.length; i += 1) {
      expect(steps[i]!, `${(['dim', 'muted', 'soft', 'body'] as const)[i]}`).toBeGreaterThan(steps[i - 1]!);
    }
  });
});

describe('the two modes', () => {
  it('are not the same palette', () => {
    // A light block that forgot to change the surface is a dark page with a
    // light-mode toggle on it.
    expect(light.surface!.L).toBeGreaterThan(0.8);
    expect(dark.surface!.L).toBeLessThan(0.3);
  });

  it('keep each accent recognisably the same colour', () => {
    // A status that changes hue between modes is a status that has to be
    // relearned. Lightness moves; hue does not.
    for (const accent of ['signal', 'attention', 'alarm', 'link'] as const) {
      expect(Math.abs(light[accent]!.h - dark[accent]!.h), accent).toBeLessThan(1);
    }
  });
});

/**
 * A repository's colour: the edge of its cards and the dot beside its name.
 *
 * A graphic rather than text, so 3:1 against what it sits on (WCAG 1.4.11)
 * rather than 4.5 — but on every background, because a dot is on a card, on the
 * page and in a hovered menu row. And they have to stay apart for people who
 * do not see them as most do, which is what the rest of this checks.
 */
const REPOS = REPO_COLORS.map((color) => `repo-${color}`);

/**
 * How a colour looks to somebody with a colour-vision deficiency: Machado,
 * Oliveira and Fernandes (2009) at full severity, applied in linear sRGB, then
 * put into OKLab, where a distance is a difference a person sees.
 */
const DEFICIENCIES: Record<string, number[][]> = {
  protanopia: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
  deuteranopia: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.01182, 0.04294, 0.968881]],
  tritanopia: [[1.255528, -0.076749, -0.178779], [-0.078411, 0.930809, 0.147602], [0.004733, 0.691367, 0.3039]],
};

function oklab([r, g, b]: [number, number, number]): [number, number, number] {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function seenWith(color: Oklch, matrix: number[][]): [number, number, number] {
  const rgb = linearRgb(color);
  const seen = matrix.map((row) => Math.max(0, Math.min(1, row[0]! * rgb[0] + row[1]! * rgb[1] + row[2]! * rgb[2])));
  return oklab([seen[0]!, seen[1]!, seen[2]!]);
}

const apart = (a: number[], b: number[]): number => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);

describe.each([
  ['dark', dark],
  ['light', light],
])('a repository’s colour in %s mode', (_mode, tokens) => {
  it('is defined for every colour the bridge can store', () => {
    for (const name of REPOS) expect(tokens[name], name).toBeDefined();
  });

  it.each(REPOS.flatMap((repo) => BACKGROUNDS.map((bg) => [repo, bg] as const)))('%s on %s is 3:1 or more', (repo, bg) => {
    const measured = ratio(tokens[repo]!, tokens[bg]!);
    expect(Number(measured.toFixed(2)), `${repo} on ${bg}`).toBeGreaterThanOrEqual(3);
  });

  it('puts each on a rung of its own, so they differ in lightness and not only in hue', () => {
    // What tells them apart with no colour vision at all.
    const rungs = REPOS.map((repo) => tokens[repo]!.L).sort((a, b) => a - b);
    for (let i = 1; i < rungs.length; i += 1) expect(rungs[i]! - rungs[i - 1]!).toBeGreaterThanOrEqual(0.039);
  });

  it.each(Object.keys(DEFICIENCIES))('keeps every two apart for somebody with %s', (deficiency) => {
    for (let i = 0; i < REPOS.length; i += 1) {
      for (let j = i + 1; j < REPOS.length; j += 1) {
        const distance = apart(seenWith(tokens[REPOS[i]!]!, DEFICIENCIES[deficiency]!), seenWith(tokens[REPOS[j]!]!, DEFICIENCIES[deficiency]!));
        expect(distance, `${REPOS[i]} and ${REPOS[j]}`).toBeGreaterThanOrEqual(0.075);
      }
    }
  });
});

describe('a repository’s colour in the two modes', () => {
  it('keeps its place on the ladder, lightest to darkest, in both', () => {
    const order = (tokens: Record<string, Oklch>) => [...REPOS].sort((a, b) => tokens[a]!.L - tokens[b]!.L);
    expect(order(light)).toEqual(order(dark));
  });

  it('keeps its hue, so a repository is the same colour after the mode changes', () => {
    for (const repo of REPOS) expect(Math.abs(light[repo]!.h - dark[repo]!.h), repo).toBeLessThanOrEqual(8);
  });

  it('is the same in the light mode whether it was chosen or is the system’s', () => {
    // The media query's block is a copy of the explicit one; a colour edited
    // in one and not the other changes with how the mode was reached.
    const system = block(/:root:not\(\[data-theme='dark'\]\):not\(\[data-theme='light'\]\) \{([\s\S]*?)\n {2}\}/);
    for (const repo of REPOS) expect(system[repo], repo).toEqual(light[repo]);
    for (const tint of TINTS) expect(system[tint], tint).toEqual(light[tint]);
  });
});
