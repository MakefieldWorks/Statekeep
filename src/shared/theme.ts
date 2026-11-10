/**
 * Theme definitions are deliberately data-only. The renderer turns the token
 * values into CSS custom properties, so a future imported theme can use this
 * exact contract without being allowed to inject arbitrary CSS.
 */

export type ThemeScheme = 'light' | 'dark'
export type AppearanceMode = 'system' | ThemeScheme

export const THEME_TOKEN_NAMES = [
  'surface-canvas',
  'surface-raised',
  'surface-recessed',
  'surface-hairline',
  'surface-selected',
  'surface-disabled',
  'control-primary',
  'control-primary-hover',
  'text-disabled',
  'text-faint',
  'text-muted',
  'text-secondary',
  'text-body',
  'text-strong',
  'text-primary',
  'text-on-primary',
  'border-subtle',
  'border-default',
  'border-strong',
  'border-emphasis',
  'border-inverse',
  'focus-soft',
  'focus',
  'focus-strong',
  'attention-wash',
  'attention-tint',
  'attention-edge',
  'attention-edge-strong',
  'attention-signal',
  'attention-fill',
  'attention-ink-soft',
  'attention-ink',
  'attention-ink-strong',
  'attention-ink-deep',
  'success-wash',
  'success-tint',
  'success-edge',
  'success-ink-soft',
  'success-ink',
  'success-ink-strong',
  'success-ink-deep',
  'danger-wash',
  'danger-tint',
  'danger-edge',
  'danger-edge-strong',
  'danger-fill',
  'danger-ink-soft',
  'danger-ink',
  'danger-ink-strong',
  'danger-ink-deep',
  'info-wash',
  'info-tint',
  'info-edge',
  'info-edge-strong',
  'info-signal',
  'info-fill',
  'info-ink-soft',
  'info-ink',
  'info-ink-strong',
  'info-ink-deep',
  'violet-wash',
  'violet-tint',
  'violet-edge',
  'violet-ink',
  'violet-ink-deep',
  'purple-wash',
  'purple-ink-deep',
  'indigo-tint',
  'indigo-ink',
  'slate-tint',
  'slate-edge',
  'slate-ink',
] as const

export type ThemeTokenName = typeof THEME_TOKEN_NAMES[number]
export type HexColor = `#${string}`
export type ThemeTokens = Readonly<Record<ThemeTokenName, HexColor>>

export interface ThemeDefinition {
  /** A stable machine-readable ID, suitable for storage in app settings. */
  id: string
  label: string
  scheme: ThemeScheme
  tokens: ThemeTokens
}

/**
 * The selected light and dark IDs are intentionally independent. A future
 * theme-pack feature can add any number of definitions and let a person pick
 * one of each without changing the preference shape or rendering code.
 */
export interface AppearancePreference {
  mode: AppearanceMode
  lightThemeId: string
  darkThemeId: string
}

export const DEFAULT_APPEARANCE_PREFERENCE: Readonly<AppearancePreference> = {
  mode: 'system',
  lightThemeId: 'statekeep-light',
  darkThemeId: 'statekeep-dark',
}

const lightTokens: ThemeTokens = {
  'surface-canvas': '#f8f8f7',
  'surface-raised': '#ffffff',
  'surface-recessed': '#fafaf9',
  'surface-hairline': '#f5f5f4',
  'surface-selected': '#e7e5e4',
  'surface-disabled': '#d6d3d1',
  'control-primary': '#292524',
  'control-primary-hover': '#44403c',
  'text-disabled': '#d6d3d1',
  'text-faint': '#716a65',
  'text-muted': '#78716c',
  'text-secondary': '#57534e',
  'text-body': '#44403c',
  'text-strong': '#292524',
  'text-primary': '#1c1917',
  'text-on-primary': '#ffffff',
  'border-subtle': '#f5f5f4',
  'border-default': '#e7e5e4',
  'border-strong': '#d6d3d1',
  'border-emphasis': '#78716c',
  'border-inverse': '#44403c',
  'focus-soft': '#e7e5e4',
  'focus': '#d6d3d1',
  'focus-strong': '#a8a29e',
  'attention-wash': '#fffbeb',
  'attention-tint': '#fef3c7',
  'attention-edge': '#fde68a',
  'attention-edge-strong': '#fcd34d',
  'attention-signal': '#fbbf24',
  'attention-fill': '#f59e0b',
  'attention-ink-soft': '#d97706',
  'attention-ink': '#b45309',
  'attention-ink-strong': '#92400e',
  'attention-ink-deep': '#78350f',
  'success-wash': '#ecfdf5',
  'success-tint': '#d1fae5',
  'success-edge': '#a7f3d0',
  'success-ink-soft': '#059669',
  'success-ink': '#047857',
  'success-ink-strong': '#065f46',
  'success-ink-deep': '#064e3b',
  'danger-wash': '#fef2f2',
  'danger-tint': '#fee2e2',
  'danger-edge': '#fecaca',
  'danger-edge-strong': '#fca5a5',
  'danger-fill': '#b91c1c',
  'danger-ink-soft': '#f87171',
  'danger-ink': '#dc2626',
  'danger-ink-strong': '#b91c1c',
  'danger-ink-deep': '#991b1b',
  'info-wash': '#f0f9ff',
  'info-tint': '#e0f2fe',
  'info-edge': '#bae6fd',
  'info-edge-strong': '#7dd3fc',
  'info-signal': '#38bdf8',
  'info-fill': '#0ea5e9',
  'info-ink-soft': '#0ea5e9',
  'info-ink': '#0369a1',
  'info-ink-strong': '#075985',
  'info-ink-deep': '#0c4a6e',
  'violet-wash': '#f5f3ff',
  'violet-tint': '#ede9fe',
  'violet-edge': '#ddd6fe',
  'violet-ink': '#6d28d9',
  'violet-ink-deep': '#5b21b6',
  'purple-wash': '#faf5ff',
  'purple-ink-deep': '#581c87',
  'indigo-tint': '#e0e7ff',
  'indigo-ink': '#4338ca',
  'slate-tint': '#f1f5f9',
  'slate-edge': '#e2e8f0',
  'slate-ink': '#475569',
}

const darkTokens: ThemeTokens = {
  'surface-canvas': '#1c1917',
  'surface-raised': '#292524',
  'surface-recessed': '#211e1c',
  'surface-hairline': '#332e2b',
  'surface-selected': '#403936',
  'surface-disabled': '#57534e',
  'control-primary': '#44403c',
  'control-primary-hover': '#57534e',
  'text-disabled': '#78716c',
  'text-faint': '#a8a29e',
  'text-muted': '#c1bcb8',
  'text-secondary': '#d6d3d1',
  'text-body': '#e7e5e4',
  'text-strong': '#f5f5f4',
  'text-primary': '#fafaf9',
  'text-on-primary': '#ffffff',
  'border-subtle': '#332e2b',
  'border-default': '#44403c',
  'border-strong': '#57534e',
  'border-emphasis': '#a8a29e',
  'border-inverse': '#d6d3d1',
  'focus-soft': '#57534e',
  'focus': '#78716c',
  'focus-strong': '#a8a29e',
  'attention-wash': '#422006',
  'attention-tint': '#713f12',
  'attention-edge': '#92400e',
  'attention-edge-strong': '#b45309',
  'attention-signal': '#d97706',
  'attention-fill': '#92400e',
  'attention-ink-soft': '#fbbf24',
  'attention-ink': '#fcd34d',
  'attention-ink-strong': '#fde68a',
  'attention-ink-deep': '#fef3c7',
  'success-wash': '#052e16',
  'success-tint': '#064e3b',
  'success-edge': '#065f46',
  'success-ink-soft': '#34d399',
  'success-ink': '#6ee7b7',
  'success-ink-strong': '#a7f3d0',
  'success-ink-deep': '#d1fae5',
  'danger-wash': '#450a0a',
  'danger-tint': '#7f1d1d',
  'danger-edge': '#991b1b',
  'danger-edge-strong': '#b91c1c',
  'danger-fill': '#991b1b',
  'danger-ink-soft': '#f87171',
  'danger-ink': '#fca5a5',
  'danger-ink-strong': '#fecaca',
  'danger-ink-deep': '#fee2e2',
  'info-wash': '#082f49',
  'info-tint': '#0c4a6e',
  'info-edge': '#075985',
  'info-edge-strong': '#0369a1',
  'info-signal': '#0284c7',
  'info-fill': '#075985',
  'info-ink-soft': '#38bdf8',
  'info-ink': '#7dd3fc',
  'info-ink-strong': '#bae6fd',
  'info-ink-deep': '#e0f2fe',
  'violet-wash': '#2e1065',
  'violet-tint': '#4c1d95',
  'violet-edge': '#5b21b6',
  'violet-ink': '#c4b5fd',
  'violet-ink-deep': '#ede9fe',
  'purple-wash': '#3b0764',
  'purple-ink-deep': '#f3e8ff',
  'indigo-tint': '#312e81',
  'indigo-ink': '#a5b4fc',
  'slate-tint': '#334155',
  'slate-edge': '#475569',
  'slate-ink': '#cbd5e1',
}

/**
 * A higher-contrast carbon-neutral pair. It retains the established semantic
 * change language while adapting chrome and foreground contrast for Graphite.
 */
const graphiteLightTokens: ThemeTokens = {
  ...lightTokens,
  'surface-canvas': '#f4f6f8',
  'surface-raised': '#ffffff',
  'surface-recessed': '#edf1f5',
  'surface-hairline': '#e4e9ee',
  'surface-selected': '#d8e0e8',
  'surface-disabled': '#c0cad5',
  'control-primary': '#1f2933',
  'control-primary-hover': '#354252',
  'text-disabled': '#7c8795',
  'text-faint': '#606c7a',
  'text-muted': '#5d6978',
  'text-secondary': '#465160',
  'text-body': '#34404d',
  'text-strong': '#27313c',
  'text-primary': '#131a22',
  'text-on-primary': '#ffffff',
  'border-subtle': '#e4e9ee',
  'border-default': '#d8e0e8',
  'border-strong': '#c0cad5',
  'border-emphasis': '#657384',
  'border-inverse': '#34404d',
  'focus-soft': '#d8e0e8',
  'focus': '#aeb9c5',
  'focus-strong': '#607080',
  'attention-fill': '#a84b08',
  'attention-ink-soft': '#a84b08',
  'attention-ink': '#9a3f08',
  'attention-ink-strong': '#7c2d12',
  'attention-ink-deep': '#5f240d',
  'success-ink-soft': '#047857',
  'danger-ink-soft': '#dc2626',
  'info-ink-soft': '#0369a1',
}

const graphiteDarkTokens: ThemeTokens = {
  ...darkTokens,
  'surface-canvas': '#10151b',
  'surface-raised': '#182029',
  'surface-recessed': '#131a22',
  'surface-hairline': '#222d38',
  'surface-selected': '#2d3a47',
  'surface-disabled': '#465463',
  'control-primary': '#303d4b',
  'control-primary-hover': '#3d4c5c',
  'text-disabled': '#718093',
  'text-faint': '#93a1b2',
  'text-muted': '#b0bdca',
  'text-secondary': '#c8d1db',
  'text-body': '#d9e0e7',
  'text-strong': '#ebeff3',
  'text-primary': '#f8fafc',
  'text-on-primary': '#ffffff',
  'border-subtle': '#222d38',
  'border-default': '#2d3a47',
  'border-strong': '#465463',
  'border-emphasis': '#718093',
  'border-inverse': '#c8d1db',
  'focus-soft': '#465463',
  'focus': '#718093',
  'focus-strong': '#b0bdca',
}

export const BUILT_IN_THEMES: readonly ThemeDefinition[] = [
  {
    id: 'statekeep-light',
    label: 'Statekeep Light',
    scheme: 'light',
    tokens: lightTokens,
  },
  {
    id: 'statekeep-graphite-light',
    label: 'Statekeep Graphite Light',
    scheme: 'light',
    tokens: graphiteLightTokens,
  },
  {
    id: 'statekeep-dark',
    label: 'Statekeep Dark',
    scheme: 'dark',
    tokens: darkTokens,
  },
  {
    id: 'statekeep-graphite-dark',
    label: 'Statekeep Graphite Dark',
    scheme: 'dark',
    tokens: graphiteDarkTokens,
  },
]

export function isAppearanceMode(value: unknown): value is AppearanceMode {
  return value === 'system' || value === 'light' || value === 'dark'
}

export function isThemeDefinition(value: unknown): value is ThemeDefinition {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<ThemeDefinition>
  if (typeof candidate.id !== 'string' || candidate.id.trim() === '') return false
  if (typeof candidate.label !== 'string' || candidate.label.trim() === '') return false
  if (candidate.scheme !== 'light' && candidate.scheme !== 'dark') return false
  if (!candidate.tokens || typeof candidate.tokens !== 'object') return false
  return THEME_TOKEN_NAMES.every(token => isHexColor(candidate.tokens?.[token]))
}

export function normalizeAppearancePreference(
  value: unknown,
  themes: readonly ThemeDefinition[] = BUILT_IN_THEMES,
): AppearancePreference {
  const candidate = value && typeof value === 'object'
    ? value as Partial<AppearancePreference>
    : {}

  return {
    mode: isAppearanceMode(candidate.mode) ? candidate.mode : DEFAULT_APPEARANCE_PREFERENCE.mode,
    lightThemeId: themeIdForScheme(candidate.lightThemeId, 'light', themes),
    darkThemeId: themeIdForScheme(candidate.darkThemeId, 'dark', themes),
  }
}

export function resolveTheme(
  preference: AppearancePreference,
  systemScheme: ThemeScheme,
  themes: readonly ThemeDefinition[] = BUILT_IN_THEMES,
): ThemeDefinition {
  const scheme = preference.mode === 'system' ? systemScheme : preference.mode
  const requestedId = scheme === 'light' ? preference.lightThemeId : preference.darkThemeId
  return themes.find(theme => theme.id === requestedId && theme.scheme === scheme)
    ?? themes.find(theme => theme.id === defaultThemeIdForScheme(scheme))
    ?? themes.find(theme => theme.scheme === scheme)
    ?? BUILT_IN_THEMES[0]!
}

export function themesForScheme(
  scheme: ThemeScheme,
  themes: readonly ThemeDefinition[] = BUILT_IN_THEMES,
): readonly ThemeDefinition[] {
  return themes.filter(theme => theme.scheme === scheme)
}

function themeIdForScheme(
  value: unknown,
  scheme: ThemeScheme,
  themes: readonly ThemeDefinition[],
): string {
  if (typeof value === 'string' && themes.some(theme => theme.id === value && theme.scheme === scheme)) {
    return value
  }
  return defaultThemeIdForScheme(scheme)
}

function defaultThemeIdForScheme(scheme: ThemeScheme): string {
  return scheme === 'light'
    ? DEFAULT_APPEARANCE_PREFERENCE.lightThemeId
    : DEFAULT_APPEARANCE_PREFERENCE.darkThemeId
}

function isHexColor(value: unknown): value is HexColor {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value)
}
