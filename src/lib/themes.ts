/**
 * Single source of truth for the color-theme catalog.
 *
 * The CSS variables themselves live in `src/app/globals.css` under
 * `html[data-theme="..."]` blocks — that file is the one we paste
 * theme tokens into. This module only carries the metadata the UI
 * (settings picker, no-flash boot script) needs.
 *
 * Adding a new theme is a two-step change:
 *   1. Append the new `html[data-theme="<id>"]` block in globals.css
 *      with every token from an existing theme (use violet as the
 *      shape reference).
 *   2. Add an entry below. The order here drives the picker grid.
 */

export const THEME_IDS = [
  "violet",
  "emerald",
  "cobalt",
  "amber",
  "rose",
] as const;

export type ThemeId = (typeof THEME_IDS)[number];

export const DEFAULT_THEME: ThemeId = "violet";

export const STORAGE_KEY = "wacrm.theme";

/**
 * MODE — the light/dark dimension, orthogonal to the accent theme.
 *
 * The CSS variables live in `src/app/globals.css` under
 * `html[data-mode="..."]` blocks (neutral surfaces only). Applied
 * at runtime via `document.documentElement.dataset.mode`. Dark is
 * the historical default and stays the app's identity; light is the
 * opt-in eye-strain-friendly alternative.
 *
 * Persisted under its own localStorage key so it composes freely
 * with the accent choice (you can run Violet-light or Violet-dark).
 */
export const MODES = ["light", "dark"] as const;

export type Mode = (typeof MODES)[number];

export const DEFAULT_MODE: Mode = "dark";

export const MODE_STORAGE_KEY = "wacrm.mode";

export function isMode(value: unknown): value is Mode {
  return (
    typeof value === "string" && (MODES as ReadonlyArray<string>).includes(value)
  );
}

export interface ThemeMeta {
  id: ThemeId;
  name: string;
  tagline: string;
  /**
   * Static swatch color for the picker chip. Hard-coded so the boot
   * script / picker cards don't need a getComputedStyle round trip
   * before the page settles. Must mirror `--primary` of the same
   * theme in globals.css.
   */
  swatch: string;
}

export const THEMES: ReadonlyArray<ThemeMeta> = [
  {
    id: "violet",
    name: "Violet",
    tagline: "The default — confident, slightly playful.",
    swatch: "oklch(0.526 0.247 293)",
  },
  {
    id: "emerald",
    name: "Emerald",
    tagline: "Growth-coded, nods at messaging without copying WhatsApp green.",
    swatch: "oklch(0.62 0.16 162)",
  },
  {
    id: "cobalt",
    name: "Cobalt",
    tagline: "Clean B2B-SaaS blue — calm and product-y.",
    swatch: "oklch(0.585 0.2 254)",
  },
  {
    id: "amber",
    name: "Amber",
    tagline: "Warm and friendly — feels good for SMB teams.",
    swatch: "oklch(0.745 0.16 65)",
  },
  {
    id: "rose",
    name: "Rose",
    tagline: "Bold and modern — D2C, creator-economy, lifestyle.",
    swatch: "oklch(0.645 0.22 16)",
  },
];

export function isThemeId(value: unknown): value is ThemeId {
  return (
    typeof value === "string" &&
    (THEME_IDS as ReadonlyArray<string>).includes(value)
  );
}

// ============================================================
// ACCENT — cor de destaque PERSONALIZADA (opcional).
//
// Além dos presets (data-theme), o usuário pode escolher qualquer cor.
// Quando definida, ela sobrescreve as variáveis CSS abaixo direto no
// <html> (inline style), vencendo o preset. Quando limpa, o preset volta.
// Persistida por dispositivo, como o tema/modo.
// ============================================================
export const ACCENT_STORAGE_KEY = "wacrm.accent";

/** Variáveis CSS que recebem a COR escolhida (fundo do destaque). */
const ACCENT_BG_VARS = [
  "--primary",
  "--ring",
  "--sidebar-primary",
  "--sidebar-ring",
] as const;

/** Variáveis CSS que recebem a cor de TEXTO sobre o destaque (contraste). */
const ACCENT_FG_VARS = [
  "--primary-foreground",
  "--sidebar-primary-foreground",
] as const;

/** Aceita apenas hex #rrggbb (o que o <input type="color"> emite). */
export function isHexColor(value: unknown): value is string {
  return typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value);
}

/** Texto legível (claro/escuro) sobre a cor, via luminância relativa. */
export function accentForeground(hex: string): string {
  const toLin = (c: number) =>
    c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  const r = toLin(parseInt(hex.slice(1, 3), 16) / 255);
  const g = toLin(parseInt(hex.slice(3, 5), 16) / 255);
  const b = toLin(parseInt(hex.slice(5, 7), 16) / 255);
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return luminance > 0.45 ? "oklch(0.15 0 0)" : "oklch(0.985 0 0)";
}

/** Aplica a cor personalizada nas variáveis de destaque do <html>. */
export function applyAccent(root: HTMLElement, hex: string): void {
  const fg = accentForeground(hex);
  for (const v of ACCENT_BG_VARS) root.style.setProperty(v, hex);
  for (const v of ACCENT_FG_VARS) root.style.setProperty(v, fg);
}

/** Remove a cor personalizada — o preset (data-theme) volta a valer. */
export function clearAccent(root: HTMLElement): void {
  for (const v of [...ACCENT_BG_VARS, ...ACCENT_FG_VARS]) {
    root.style.removeProperty(v);
  }
}

/** Cor dos balões de mensagem enviados (agente). */
export function applyBubble(root: HTMLElement, hex: string): void {
  root.style.setProperty("--chat-out", hex);
  root.style.setProperty("--chat-out-foreground", accentForeground(hex));
}

/** Remove a cor custom dos balões — voltam a herdar o destaque (--primary). */
export function clearBubble(root: HTMLElement): void {
  root.style.removeProperty("--chat-out");
  root.style.removeProperty("--chat-out-foreground");
}
