---
name: Bohemarr
description: Management UI for a Czech/Slovak streaming indexer and download client for Sonarr and Radarr
colors:
  signal-blue: "oklch(0.53 0.15 252)"
  signal-blue-dark: "oklch(0.7 0.13 245)"
  go-green: "oklch(0.52 0.14 150)"
  go-green-dark: "oklch(0.74 0.16 150)"
  amber: "oklch(0.55 0.13 65)"
  amber-dark: "oklch(0.8 0.14 75)"
  signal-red: "oklch(0.577 0.245 27.325)"
  signal-red-dark: "oklch(0.704 0.191 22.216)"
  rack: "oklch(0.22 0.012 260)"
  rack-dark: "oklch(0.18 0.01 260)"
  rack-raised: "oklch(0.29 0.014 260)"
  ink: "oklch(0.145 0 0)"
  graphite: "oklch(0.205 0 0)"
  slate-dim: "oklch(0.269 0 0)"
  steel-muted: "oklch(0.556 0 0)"
  hairline: "oklch(0.922 0 0)"
  mist: "oklch(0.97 0 0)"
  paper: "oklch(1 0 0)"
typography:
  title:
    fontFamily: "Geist Variable, sans-serif"
    fontSize: "1rem"
    fontWeight: 500
    lineHeight: 1.375
  body:
    fontFamily: "Geist Variable, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.43
  label:
    fontFamily: "Geist Variable, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 500
    lineHeight: 1.33
rounded:
  sm: "3.6px"
  md: "4.8px"
  lg: "6px"
  xl: "8.4px"
  pill: "15.6px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "20px"
components:
  button-primary:
    backgroundColor: "{colors.signal-blue}"
    textColor: "{colors.paper}"
    typography: "{typography.body}"
    rounded: "{rounded.lg}"
    padding: "0 10px"
    height: "32px"
  button-outline:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
    padding: "0 10px"
    height: "32px"
  button-destructive:
    backgroundColor: "oklch(0.577 0.245 27.325 / 10%)"
    textColor: "{colors.signal-red}"
    rounded: "{rounded.lg}"
    padding: "0 10px"
    height: "32px"
  input:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.lg}"
    padding: "4px 10px"
    height: "32px"
  card:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.xl}"
    padding: "12px"
  nav-item:
    backgroundColor: "transparent"
    textColor: "oklch(0.8 0.01 260)"
    typography: "{typography.body}"
    rounded: "{rounded.lg}"
    padding: "0 12px"
    height: "36px"
  nav-item-active:
    backgroundColor: "{colors.rack-raised}"
    textColor: "{colors.signal-blue-dark}"
  badge-success:
    backgroundColor: "oklch(0.52 0.14 150 / 12%)"
    textColor: "{colors.go-green}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: "2px 8px"
    height: "20px"
---

# Design System: Bohemarr

## Overview

**Creative North Star: "The Control Room"**

Bohemarr's UI is a control room for a service that otherwise runs unattended: the operator walks in to check what is downloading, fix an account, or push one manual Job, then leaves. State, numbers and actions come first; decoration does not. It is dense and utilitarian: compact controls, tight radii, flat surfaces, and colour that reports state.

It deliberately reads as a neighbour of Sonarr and Radarr: a dark sidebar rack on the left in both themes, one content column beside it, and the *arr family's status language (blue for activity, green for connected or done, amber for attention, red for failure). Built on shadcn/ui (`radix-nova`) and Geist; light and dark follow the system theme.

**Key Characteristics:**

- Dark sidebar navigation in both themes; it becomes a horizontal strip on phones.
- Colour reports state; neutrals carry everything else.
- One family (Geist), hierarchy by weight and size.
- Flat panels separated by hairline rings, not shadows.
- Compact: 32px controls, 6px corners, 12px gaps.

## Colors

Neutral surfaces with a four-colour status vocabulary borrowed from the *arr apps.

### Primary

- **Signal Blue** (`signal-blue`, dark `signal-blue-dark`): primary buttons, links, focus rings, the active navigation item, running (Downloading) Jobs, the active-Job counter.

### Secondary

- **Go Green** (`go-green`, dark `go-green-dark`): connected, active, on, completed.
- **Amber** (`amber`, dark `amber-dark`): needs attention: saved but not applied, needs an account, paused, unsaved changes.

### Tertiary

- **Signal Red** (`signal-red`, dark `signal-red-dark`): failure and destructive actions. Text on a 10–20% tint of itself, never a solid fill.

### Neutral

- **Rack** (`rack`, dark `rack-dark`): the sidebar, in both themes; **Rack Raised** (`rack-raised`) for its hover and active items.
- **Ink** / **Paper**: text and background, swapped between themes.
- **Mist** / **Slate Dim**: muted fills and hover backgrounds (light / dark).
- **Steel Muted**: descriptions, hints, placeholders.
- **Hairline**: borders and input strokes (dark mode: white at 10–15%).

### Named Rules

**The Earned Colour Rule.** Colour encodes state. Blue, green, amber and red each mean one thing everywhere; nothing decorative uses them.

**The Tint Rule.** Status badges are coloured text on a 12–20% tint of the same colour, never a solid fill.

## Typography

**Body Font:** Geist Variable (with sans-serif)

**Character:** A neutral grotesk that stays legible at small sizes; table numerals are tabular.

### Hierarchy

- **Title** (500, 1rem, 1.375): panel headings (`h2`).
- **Body** (400, 0.875rem, 1.43): tables, fields (1rem on mobile to avoid zoom), descriptions.
- **Label** (500, 0.75rem): badges, field hints, sidebar status, group legends.

### Named Rules

**The One Family Rule.** Hierarchy comes from weight and size inside Geist; no second typeface.

## Layout

A 13rem sidebar beside a content column capped at `max-w-5xl` (from 768px up); below that the sidebar collapses into a header with a horizontally scrolling navigation strip whose active item scrolls into view. Each view is one or more panels with 12px gaps; forms run one column on phones and two to three from `sm` up. Unsaved changes raise a bar fixed to the bottom of the content area with Discard and Save, then Restart. The URL hash names the view (`#jobs`, `#search`, `#providers`, `#accounts`, `#arrs`, `#general`); every view stays mounted so a search survives switching views.

## Elevation & Depth

Flat. Panels are separated by a 1px ring of foreground at 10% opacity; depth comes from the dark sidebar against the content and from tonal fills. The bottom save bar uses a translucent card fill with backdrop blur so content scrolls visibly beneath it.

### Named Rules

**The Flat Panel Rule.** No drop shadows on surfaces; a hairline ring or a tonal fill separates panels.

## Shapes

Tight corners: 6px controls (`--radius: 0.375rem`), 8.4px panels, pill badges. Change the radius globally through `--radius`, never per component.

## Components

### Buttons

- **Shape:** 6px corners, 32px tall (44px for touch targets on phones), 10px side padding, 14px medium text.
- **Primary:** Signal Blue fill, white text (dark mode: light blue, dark text); hover drops to 80%.
- **Outline / Ghost:** hairline border or none; hover fills with muted.
- **Destructive:** Signal Red text on a red tint.
- **Focus:** 3px Signal Blue ring at 50%; pressed buttons shift down 1px.

### Cards / Containers

- **Corner Style:** 8.4px. **Background:** Paper (Graphite in dark mode). **Border:** 1px ring at 10% foreground. **Padding:** 12px (the `sm` card size).

### Inputs / Fields

- **Style:** 32px, transparent, hairline border, 6px corners; a label above and a one-line hint below.
- **Placeholders:** show the effective default as `value (default)`, or an example as `e.g. …`.
- **Focus:** Signal Blue ring. **Locked by .env:** disabled with "Set in .env; change it there." **Saved secrets:** masked placeholder and "Saved. Type to replace it."

### Navigation

Sidebar items: 36px tall (44px on phones), icon plus label, Rack-foreground text; hover and active on Rack Raised, active text in Signal Blue. An amber dot marks a view with unsaved changes; a blue counter on Jobs shows active Jobs. The sidebar foot lists Sonarr, Radarr and provider status.

### Status badges

Pill, 20px, coloured by the status vocabulary (Tint Rule): Jobs (Queued outline, Downloading blue, Paused amber, Completed green, Failed red), *arr connections (Not configured, Restart to connect, Connected, Setup failing), accounts (Active, Saved but not active, No credentials).

## Do's and Don'ts

### Do:

- **Do** use the shadcn components in `web/src/components/ui/` and their variants (including Badge `success` and `warning`) before writing new styles.
- **Do** define colours as tokens on `:root` and `.dark` in `web/src/index.css`.
- **Do** show state with the status vocabulary and words together, never colour alone.
- **Do** keep both themes working; every token has a light and a dark value.

### Don't:

- **Don't** add drop shadows to panels (The Flat Panel Rule).
- **Don't** add a second typeface (The One Family Rule).
- **Don't** use blue, green, amber or red decoratively (The Earned Colour Rule).
- **Don't** mark the active navigation item with a thick coloured side border; use the raised fill and blue text.
