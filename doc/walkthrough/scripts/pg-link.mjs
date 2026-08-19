// Generate a playground URL for a tutorial `.dl` file.
//
// If the program declares `input predicate p(col1: t1, col2: t2, ...)` and a
// sibling `p.csv` exists, inline the CSV rows as `p("v1", ...).` facts and
// drop the `input predicate` declaration, so the resulting URL is
// self-contained. Other `.dl` text passes through untouched.
//
// Usage: node pg-link.mjs <dl-path> [<dl-path> ...]
//
// Prints one line per input: `<input-path>\t<url>`.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const BASE = "https://xiemaisi.github.io/datamog/";
const EXT_RE = /^\s*input\s+predicate\s+(\w+)\s*\(([^)]+)\)\s*\.\s*$/gm;

function parseCsvFields(line, delimiter = ",") {
  // Minimal CSV splitter: quoted fields, escaped quotes as "".
  const fields = [];
  let i = 0;
  let cur = "";
  let inQuotes = false;
  while (i < line.length) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      cur += c;
      i++;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (c === delimiter) {
      fields.push(cur);
      cur = "";
      i++;
      continue;
    }
    cur += c;
    i++;
  }
  fields.push(cur);
  return fields;
}

function parseColumnType(spec) {
  // "name: type" — we only need the type to decide quoting.
  const colon = spec.lastIndexOf(":");
  if (colon < 0) return "string";
  return spec.slice(colon + 1).trim();
}

function inlineFact(predicate, columns, fields) {
  const parts = [];
  for (let i = 0; i < columns.length; i++) {
    const t = parseColumnType(columns[i]);
    const v = fields[i];
    if (t === "integer" || t === "float" || t === "boolean") {
      parts.push(v);
    } else {
      parts.push(`"${v.replace(/"/g, '""')}"`);
    }
  }
  return `${predicate}(${parts.join(", ")}).`;
}

function inlineExtensionals(source, dir) {
  const facts = [];
  let edited = source;
  EXT_RE.lastIndex = 0;
  const declarations = [];
  for (let m = EXT_RE.exec(source); m !== null; m = EXT_RE.exec(source)) {
    declarations.push({
      full: m[0],
      predicate: m[1],
      columns: m[2].split(",").map((s) => s.trim()),
    });
  }
  for (const d of declarations) {
    const csvPath = join(dir, `${d.predicate}.csv`);
    if (!existsSync(csvPath)) continue;
    const rows = readFileSync(csvPath, "utf8")
      .split(/\r?\n/)
      .filter((l) => l.trim() !== "");
    // First row is a header; skip it.
    const data = rows.slice(1);
    for (const r of data) {
      facts.push(inlineFact(d.predicate, d.columns, parseCsvFields(r)));
    }
    edited = edited.replace(d.full, "");
  }
  if (facts.length === 0) return source;
  return `${facts.join("\n")}\n${edited.replace(/\n{3,}/g, "\n\n")}`;
}

function urlFor(dlPath) {
  const source = readFileSync(dlPath, "utf8");
  const inlined = inlineExtensionals(source, dirname(dlPath));
  return `${BASE}#p=${encodeURIComponent(inlined)}`;
}

for (const p of process.argv.slice(2)) {
  console.log(`${p}\t${urlFor(p)}`);
}
