/** One hue per product, used wherever products appear side by side. */
export const PRODUCT_COLOR = {
  cowork: '#0f766e',
  studio: '#6d28d9',
  github: '#1f2937',
  azure: '#2563eb',
}

/** Prepaid draws first, then pay-as-you-go. */
export const PREPAID = '#64b5a8'
export const PAYG = '#b45309'

/** Reference values (allowance, current rate): a quiet slate that never reads as a product. */
export const NEUTRAL = '#7b8794'
export const SECONDARY = NEUTRAL

/** Categorical palette for small series counts (model, feature, task type). Avoids product and PAYG hues. */
export const SERIES = ['#0e7490', '#be185d', '#4d7c0f', '#475569', '#a16207']

/** Model tiers: lightness rises with capability, in one hue so tier never reads as a product. */
export const TIER_COLOR: Record<string, string> = { '1. Lightweight': '#94a3b8', '2. Versatile': '#5b6b7f', '3. Powerful': '#1e293b' }

/** Signed differences: over and under in two distinct hues, zero stays neutral. */
export const OVER = '#b42318'
export const UNDER = '#0e7490'

/** Studio agent-action ramp: review, investigate, monitor, healthy, unused. No product or PAYG hues. */
export const ACTION_COLOR = ['#b42318', '#d4553a', '#7b8794', '#4d7c0f', '#cbd5e1']
