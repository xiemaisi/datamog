# Datalog course slides

An Astro static site rendering *Introduction to Logic Programming with Datalog*
(FLOLAC 2026) as a full-page slide deck, one HTML page per slide. It is an
alternative to the original Google Slides deck.

## Develop / build

```bash
bun install
bun run dev       # dev server with hot reload
bun run build     # static build into dist/
bun run preview   # serve the built dist/
```

`dev` and `build` both run `build:embed` first, which bundles
`packages/playground/src/embed/` into `public/embed/`. Without it the live
```datamog blocks silently do not mount.

Open the dev/preview URL; the root is a course home page linking to each part's
deck.

## Export to PDF

```bash
bun run slides:pdf   # build, then write flolac-slides.pdf (gitignored)
```

`scripts/build-pdf.mjs` serves the built `dist/` and drives headless Chromium
(Playwright, already available in the repo) over every slide **in presentation
order** — it reads each deck's entry point from the home page and then follows
the same `data-next` chain the arrow keys use. Each slide is rendered with its
client scripts (so Mermaid diagrams and live embeds appear), printed to one 16:9
landscape page, and the pages are merged with `pdf-lib`. Pass an output path to
export an existing `dist/` without rebuilding:
`bun run scripts/build-pdf.mjs my-deck.pdf`.

Note: the file is large (100 MB+) because the full-bleed splash art in
`public/images/` is heavy (8-10 MB per PNG) and the PDF embeds each once.
Shrinking those source images is the way to shrink the PDF (it would also
lighten the repo and the deployed site).

## Navigation

- **→ / Space / PageDown / `n`** — next slide
- **← / PageUp / `p`** — previous slide
- **Home / End** — first / last slide
- **`f`** — toggle fullscreen
- The footer arrows are also clickable.

## Course structure

The course is a standalone **Introduction** deck followed by one deck per
part, all defined in `src/decks.ts`:

| Deck | Slug | Content folder |
| --- | --- | --- |
| Introduction | `intro` | `src/content/slides/intro/` |
| Part 1 — Datalog Basics | `datalog-basics` | `src/content/slides/part1/` |
| Part 2 — Recursion | `recursion` | `src/content/slides/part2/` |
| Part 3 — Aggregates | `aggregates` | `src/content/slides/part3/` |
| Part 4 — Advanced Topics | `advanced-topics` | `src/content/slides/part4/` |

The intro slides (title, motivation, and the `Course overview` roadmap) live
only in the intro deck; they are **not** repeated in the part decks. The one
shared slide is the overview: `deckSequence()` in `decks.ts` prepends it to
each part deck (so a part opens with its row of the roadmap highlighted) while
the intro deck shows the same slide unhighlighted, second to last, before the
closing about slide.

## How it is put together

- **One Markdown file per slide** under `src/content/slides/<folder>/`, named
  `NN-slug.md`. The numeric prefix sets the order within a folder; the slug
  becomes the per-deck URL (`/<deck-slug>/<slug>/`). Frontmatter:
  - `title` — slide title (required)
  - `kind` — `content` (default) · `title` · `section` · `emphasis` · `placeholder`
  - `section` — short label shown in the footer
  - `image` — full-bleed background image under `public/images/`
  - `imageAlt` — accessible name for that image
  - `tight` — shrink body type for formula-/code-dense slides
  - `roadmap` — end-of-part navigation slide, rendering the roadmap with the
    parts covered so far marked (set on each `*-roadmap.md`)
- `src/pages/[...slide].astro` generates one route per slide **per deck**;
  `src/layouts/SlideLayout.astro` is the full-page chrome (FLOLAC banner, footer
  pager, progress bar, key handler). `src/pages/index.astro` is the course home
  page.
- The course-overview slide renders its roadmap from `src/components/CourseOverview.astro`,
  which reads the deck list from `decks.ts`: each part is a base-aware link to
  that deck's first slide, and the route passes `currentPart` so the deck's own
  part row is highlighted ("you are here"); in the intro deck none is.
- Each part deck opens with a `kind: title` slide (`partN/00-title.md`) carrying
  a `Part N` kicker, mirroring the intro deck's title slide (which is
  `intro/01-title.md`, the intro folder being the one that starts at `01`).
- `glossary.md` and `pokemon-glossary.md` in this directory are prose companions
  to the decks, not slides; nothing builds them.
- **Diagrams** use fenced ```mermaid blocks. `src/plugins/remark-mermaid.mjs`
  turns them into `<pre class="mermaid">`, and the layout's client script renders
  them with Mermaid, themed to the FLOLAC palette (Starlight-style).
- **Code** is highlighted by Shiki; Datalog is fenced as ```prolog (a close fit).

## Deploying under a sub-path

The build serves from `/` by default. To host under a sub-path, set `DECK_BASE`:

```bash
DECK_BASE=/datamog/slides/ bun run build
```

In-content image paths (`/images/...`) are root-absolute and assume the default
base; adjust them if you deploy under a sub-path.

## Assets and trademarks

Decorative bitmaps (the Pokémon splash art, the Pokédex entry, and the villager
art) are carried over from the original Google Slides deck. The Titanic-section
image is Willy Stöwer's 1912 illustration *Der Untergang der Titanic*, which is
in the public domain.

Pokémon and Pokémon names, types, moves, and abilities are trademarks of
Nintendo, Creatures Inc., and GAME FREAK inc.; they are used here only
nominatively, as an educational example.
