// The course is a standalone "Introduction" deck followed by one deck per
// part. The intro slides live under `intro/` and are NOT repeated in the part
// decks; only the course-overview roadmap slide is shared, opening each part
// deck with that part highlighted (and closing the intro deck unhighlighted).
// A deck's URL namespace is its `slug`; slides are ordered by their numeric
// filename prefix within a folder.

export interface Deck {
  slug: string;
  title: string;
  /** Course part number (1-4); undefined for the standalone intro deck. */
  part?: number;
  /** Content sub-folder under `src/content/slides` holding this deck's slides. */
  dir: string;
  /** Prepend the shared course-overview slide (true for the part decks). */
  opensWithOverview: boolean;
  /** One-line description shown on the course home page. */
  blurb: string;
  /** Short subtitle for the overview-slide chip (falls back to `blurb`). */
  tagline?: string;
  /** False while the deck is still a placeholder stub. */
  ready: boolean;
}

/** Folder holding the intro slides and the shared overview. */
export const INTRO_DIR = "intro";

/** Id of the shared course-overview roadmap slide. */
export const OVERVIEW_ID = "intro/07-course-overview";

export const DECKS: Deck[] = [
  {
    slug: "intro",
    title: "Introduction",
    dir: "intro",
    opensWithOverview: false,
    blurb: "What logic programming and Datalog are, and the shape of the course.",
    tagline: "What Datalog is, and the plan",
    ready: true,
  },
  {
    slug: "datalog-basics",
    title: "Datalog Basics",
    part: 1,
    dir: "part1",
    opensWithOverview: true,
    blurb: "Facts, rules, and queries, and how a Datalog program is evaluated.",
    tagline: "Facts, rules, and queries",
    ready: true,
  },
  {
    slug: "recursion",
    title: "Recursion",
    part: 2,
    dir: "part2",
    opensWithOverview: true,
    blurb: "Recursive predicates, how they are evaluated, and where negation fits.",
    tagline: "Recursion and negation",
    ready: true,
  },
  {
    slug: "aggregates",
    title: "Aggregates",
    part: 3,
    dir: "part3",
    opensWithOverview: true,
    blurb: "Summarising data: count, sum, average, and friends.",
    tagline: "Summarising data",
    ready: true,
  },
  {
    slug: "advanced-topics",
    title: "Advanced Topics",
    part: 4,
    dir: "part4",
    opensWithOverview: true,
    blurb: "Metatheory, the limits of impure Datalog, and working with JSON.",
    tagline: "Theory, limits, and the real world",
    ready: true,
  },
];

/** Top-level content folder of a slide id (e.g. `intro/01-title` -> `intro`). */
export const topDir = (id: string): string => id.split("/")[0];

/** Slide id with its top folder stripped (e.g. `part1/07-x` -> `07-x`). */
export const baseName = (id: string): string => id.split("/").slice(1).join("/");

/**
 * The ordered slide sequence for a deck. The intro deck is just its folder
 * in numeric order, so it runs title, intro slides, the overview, then the
 * about slide. A part deck opens on its own
 * title slide (sorted first in its folder), then the shared overview slide
 * with that part highlighted, then the rest of the part's slides. `all` is the
 * full slide collection.
 */
export function deckSequence<T extends { id: string }>(
  deck: Deck,
  all: T[],
): T[] {
  const own = all
    .filter((e) => topDir(e.id) === deck.dir)
    .sort((a, b) => a.id.localeCompare(b.id));
  if (!deck.opensWithOverview) return own;
  const overview = all.find((e) => e.id === OVERVIEW_ID);
  if (!overview) return own;
  return own.length > 0 ? [own[0], overview, ...own.slice(1)] : [overview];
}
