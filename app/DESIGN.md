---
name: Consumption Central app
description: Calm FinOps workspace for Copilot credit consumption and cost, computed in the browser from CSV exports.
colors:
  canvas: "#f3f6f5"
  surface: "#ffffff"
  surface-2: "#f7faf9"
  ink: "#12201e"
  ink-2: "#445653"
  ink-3: "#5f716e"
  line: "#d9e2e0"
  line-2: "#e9efed"
  band: "#0b3d3a"
  band-ink-2: "#b9d3cf"
  band-accent: "#7fe0cf"
  accent: "#0f766e"
  accent-ink: "#0b5a52"
  accent-soft: "#e6f3f0"
  hover: "#eef5f3"
  cowork: "#0f766e"
  studio: "#6d28d9"
  github: "#1f2937"
  azure: "#2563eb"
  prepaid: "#64b5a8"
  payg: "#b45309"
  bad: "#b42318"
typography:
  page-title:
    fontFamily: "Segoe UI Variable Display, Segoe UI, system-ui, sans-serif"
    fontSize: "21px"
    fontWeight: 600
    letterSpacing: "-0.01em"
  kpi-value:
    fontFamily: "Segoe UI Variable Display, Segoe UI, system-ui, sans-serif"
    fontSize: "28px"
    fontWeight: 600
    lineHeight: 1.15
    fontFeature: "tnum"
  panel-title:
    fontFamily: "Segoe UI Variable Text, Segoe UI, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 600
  body:
    fontFamily: "Segoe UI Variable Text, Segoe UI, system-ui, sans-serif"
    fontSize: "14px"
    lineHeight: 1.45
  label:
    fontFamily: "Segoe UI Variable Text, Segoe UI, system-ui, sans-serif"
    fontSize: "12.5px"
    fontWeight: 500
rounded:
  sm: "6px"
  md: "8px"
  lg: "10px"
  pill: "999px"
spacing:
  gutter: "16px"
  page-x: "28px"
  page-x-mobile: "14px"
components:
  panel:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.lg}"
    padding: "16px 18px 18px"
  kpi:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.lg}"
    padding: "14px 16px 15px"
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.surface}"
    rounded: "{rounded.md}"
    height: "36px"
  segmented-on:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    height: "32px"
  table-header:
    backgroundColor: "{colors.surface-2}"
    textColor: "{colors.ink-2}"
---

# DESIGN.md: Consumption Central app

> Recorded from the shipped build in `src/index.css`, `src/ui/theme.ts` and the components in `src/ui/`. It shares its design kit with the AI in One app, so the two apps look and behave the same.

## Overview

**North star: the FinOps workbench.** A quiet, light workspace where the numbers carry the colour. A single dark-teal band at the top holds the brand, the data source, the Rates button and the six tabs. Below it, white panels sit on a pale green-grey canvas.

Navigation always has three levels, in the same places:
1. **Top tabs:** Overview, Cowork & Work IQ, Copilot Studio, GitHub Copilot, Azure AI Foundry, Guide.
2. **Segmented sub-views** under the page title. Each product tab has Consumption, Cost, Optimization and Forecast; Cowork also has Tasks. Azure has Spend, Capacity & health and Reconciliation.
3. **Filters** in the toolbar. Each tab shows only its own slicers, matching the Power BI page, and a set filter is tinted. Filters reset when you change tab.

On narrow screens the tab strip and the segmented control scroll sideways. The active tab and segment are scrolled into view automatically, so the current location is never hidden off-screen.

## Colors

- **Colour means something.** Each product has one hue, set in `PRODUCT_COLOR`:
  - `cowork` teal
  - `studio` violet
  - `github` graphite
  - `azure` blue

  These colours are used only where products appear side by side (Overview, the Guide cards) and for each product's own lines and bars. Never reuse a product hue for a category.
- **Prepaid and pay-as-you-go** always use the same two colours: `prepaid` light teal, then `payg` amber. Prepaid draws first, so it is always the lower or first segment. Amber means pay-as-you-go and nothing else.
- **Reference lines** (allowance, current rate, included pool) use `NEUTRAL` slate, dashed where they're a projection.
- **Signed differences** use `OVER` red and `UNDER` teal. A difference that rounds to zero is `NEUTRAL`, and a KPI only takes the warning dot when its value is actually a problem.
- **Model tiers** use `TIER_COLOR`, one slate hue that darkens with capability.
- **Studio agent actions** use `ACTION_COLOR`, which runs from urgent reds through slate and green to a pale grey for unused agents. Its order matches the action priority used in the PBI.
- **Small categorical series** (model, feature, task type) use the `SERIES` palette, never a rainbow. It avoids every product and PAYG hue.
- `band` is only for the header. `band-accent` is only for the active-tab underline and for focus rings inside the band.
- `accent` covers interactive states: primary buttons, active sort arrows, set filters and selected bar rows.
- **SVG chart colours are constants** in `theme.ts`. SVG presentation attributes don't resolve CSS variables reliably inside the Managed App host.

## Typography

- The Segoe UI Variable family throughout. Display is for page titles, KPI values and sheet titles; Text is for everything else. No web fonts are loaded, because the host CSP blocks them.
- Every number that lines up uses `font-variant-numeric: tabular-nums`. That covers KPI values, table numbers, bar values and axes.
- Type sizes: page title 21px, section title 16px, panel title 15px, body 14px, labels and notes 12.5px.
- Sentence case everywhere, with no uppercase eyebrows.
- Cowork, Studio and GitHub amounts are in US dollars. Azure amounts carry the billing currency code from the export. Axes use compact numbers, such as "1.2m".

## Layout

- **Content column:** max width 1480px with 28px side padding. At 600px and below, the padding drops to 14px.
- **KPI row:** tiles wrap in a flex row, each at least 170px wide. Text-valued KPIs, such as the billing period, take double width.
- **Panel grids:** `grid-2`, `grid-3`, `grid-2-1` and `grid-1-2`, with a 16px gap. Panels align to the top so they never stretch to empty height.
  - Wide tables always get the full width. Never put a table of five or more columns in the narrow column of a split.
  - Grid tracks that contain charts must be `minmax(0, 1fr)`. Charts measure their own width, and an `auto` track locks them at their first measured size.
- **Breakpoints:**
  - 1100px: three-column grids become two.
  - 900px: every grid becomes one column and the toolbar stacks.
  - 600px: filters move into a two-column grid and KPIs show two per row. The header tightens, and "Change data" is hidden while the Sample tag is showing.
- **Tables** scroll horizontally inside their own frame. They never widen the page.
  - `DataTable` sets a minimum table width from its column count. Pass `minWidth` when a table needs more.
  - On phones the first column is fixed at 170px, or 230px for tree tables. This keeps names readable while the number columns scroll.

## Elevation & Depth

Mostly flat:
- Panels and KPIs have a 1px `line` border and a hairline shadow (`0 1px 2px rgb(16 40 37 / .06)`).
- The only real elevation is on tooltips, info pops and dialogs: `0 8px 28px rgb(16 40 37 / .18)`.
- No nested cards. Sub-areas inside a panel use a `surface-2` fill (stat grid, file drop) rather than another bordered box.

## Shapes

- Panels and KPIs have a 10px radius. Controls are 7–8px, and bars are 2–3px.
- Pills (999px) are only for status: the source chip, the sample tag, action tags and the child count.

## Components

- **KPI tile:**
  - A product-coloured dot and the label, with an info button carrying the PBI glossary text.
  - The value, then a sub-line of context, such as the period or the filter scope.
  - Trends are green when up and red when down.
- **Panel:** a title and optional note, with an info button. The note explains in plain words what the visual counts.
- **Charts:** line charts (optionally area-filled) for trends and forecasts, stacked or clustered columns (prepaid then pay-as-you-go), grouped bars, a scatter and a distribution strip.
  - Treemaps, funnels and donuts from the PBI become ranked bar lists.
  - The second measure of a combo chart appears in its tooltip.
- **BarList:** a ranked label, a track and a right-aligned value, laid out in a three-column grid.
  - Rows can be clicked to filter, and the selected row is tinted `accent-soft`.
  - "Show all N" expands the list.
  - Long labels truncate with a hover title.
- **DataTable:**
  - Fixed layout, sortable headers, search, and an optional parent > child tree (for example, department > person) with a twisty and a child count.
  - Numbers are right-aligned and tabular.
  - In-cell bars sit in a grey track beside their value.
  - "Show more" pages through the rows, 25 at a time.
- **Rates sheet:** a native `<dialog>` that holds the report parameters: credit rates, the prepaid pack balance, GitHub seat prices, included credits and the allowance change date.
- **Data source sheet:** a centred dialog with a file drop. It lists every recognised source and whether it was supplied.
- **Segmented control:** a grey trough. The active segment is white, with a hairline shadow. Arrow keys, Home and End move between segments; only the active one is in the tab order.
- **Info button:** opens on hover or keyboard focus. A click or tap pins it open until Esc, a second click or a tap elsewhere.
- **Forecast view:** the monthly run rate first, then the next 12 months as a range from the current rate to the growth trend, with its confidence. With too little history the range is replaced by "Not enough history" and the chart shows only the current rate.
- **Focus:** a 2px `accent` outline with a 2px offset everywhere. Inside the header band, the outline is `band-accent`.

## Do's and Don'ts

**Do**
- Keep every Power BI measure, chart and table. Reorganise them into tabs and sub-views; never drop them.
- Put each metric's definition behind its info button, sourced from the PBI glossary.
- Show a dash or an empty state when a source is missing. Never show zero or NaN.
- Keep the six top tabs. New content goes into a sub-view.

**Don't**
- Use eyebrow labels, gradient text, or side-stripe accents thicker than 1px.
- Use product colours for decoration.
- Add motion beyond the sheet entrance and the spinner. Respect `prefers-reduced-motion`.
- Load anything from a CDN, or make any network call other than reading the bundled sample.
