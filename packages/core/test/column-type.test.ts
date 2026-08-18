import { describe, expect, test } from "bun:test";
import {
  BOTTOM,
  NULL_TYPE,
  TOP,
  VALUE_TYPE,
  col,
  columnTypeCompatible,
  formatColumnType,
  isBottom,
  isNullType,
  joinColumn,
  meetColumn,
  sameColumnType,
  subsumes,
  withNull,
  withoutNull,
} from "../src/column-type.ts";

// The lattice of doc/design/null-as-a-value.md §3, as a pair per §6. The cases
// worth pinning are the ones the design argues about: that `null` beside the
// primitives keeps `string` meet `integer` empty while making `string?` meet
// `integer?` inhabited, and that the join stays total.

const INT = col("integer");
const FLOAT = col("float");
const STR = col("string");
const BOOL = col("boolean");
const INTQ = col("integer", true);
const FLOATQ = col("float", true);
const STRQ = col("string", true);

describe("the two elements that are not a plain primitive", () => {
  test("bottom is the join's identity", () => {
    for (const t of [INT, STR, VALUE_TYPE, NULL_TYPE, INTQ]) {
      expect(sameColumnType(joinColumn(BOTTOM, t), t)).toBe(true);
      expect(sameColumnType(joinColumn(t, BOTTOM), t)).toBe(true);
    }
  });

  test("value is the meet's identity, and it is a different element", () => {
    // type-lattice.md has `undefined` wearing both hats, which is what breaks
    // the laws below. Here the two units are distinct elements of the lattice.
    for (const t of [INT, STR, NULL_TYPE, INTQ, BOTTOM]) {
      expect(sameColumnType(meetColumn(TOP, t), t)).toBe(true);
      expect(sameColumnType(meetColumn(t, TOP), t)).toBe(true);
    }
  });

  test("bottom absorbs under meet, since nothing inhabits it", () => {
    expect(isBottom(meetColumn(BOTTOM, INT))).toBe(true);
    expect(isBottom(meetColumn(BOTTOM, VALUE_TYPE))).toBe(true);
  });

  test("the null type is bottom plus the bit, and the two are distinguishable", () => {
    expect(isBottom(BOTTOM)).toBe(true);
    expect(isBottom(NULL_TYPE)).toBe(false);
    expect(isNullType(NULL_TYPE)).toBe(true);
    expect(isNullType(BOTTOM)).toBe(false);
  });

  test("`T?` is the join of `T` and null, not a separate kind of type", () => {
    expect(sameColumnType(joinColumn(INT, NULL_TYPE), INTQ)).toBe(true);
    expect(sameColumnType(joinColumn(STR, NULL_TYPE), STRQ)).toBe(true);
  });
});

describe("join: total, and widening carries the bit", () => {
  test("integer joins float to float, as today", () => {
    expect(sameColumnType(joinColumn(INT, FLOAT), FLOAT)).toBe(true);
    expect(sameColumnType(joinColumn(INTQ, FLOAT), FLOATQ)).toBe(true);
  });

  test("incompatible primitives widen to value rather than erroring", () => {
    expect(joinColumn(INT, STR).base).toBe("value");
    expect(joinColumn(BOOL, STR).base).toBe("value");
  });

  test("widening never launders the bit away", () => {
    // nullness-tracking.md §7 reason 1 feared exactly this join dropping the
    // bit. It cannot, the bit having its own join.
    expect(joinColumn(INTQ, STR).nullable).toBe(true);
    expect(joinColumn(INT, STRQ).nullable).toBe(true);
  });

  test("and it does not invent one either, so widening is exact", () => {
    // The pair is strictly more precise than the flattened ten-element lattice
    // §3 first described, where `value` was the top and admitted a null: there,
    // joining two non-null primitives over-approximated. Here `(value, false)`
    // is a real element meaning "any JSON shape, never null".
    expect(joinColumn(INT, STR).nullable).toBe(false);
    expect(formatColumnType(joinColumn(INT, STR))).toBe("value");
  });
});

describe("meet: the case null.md §7 feared, and why it is fine here", () => {
  test("string meet integer is still empty, so still an error", () => {
    expect(isBottom(meetColumn(STR, INT))).toBe(true);
    expect(isBottom(meetColumn(BOOL, FLOAT))).toBe(true);
  });

  test("string? meet integer? is the null type, which is inhabited and correct", () => {
    expect(isNullType(meetColumn(STRQ, INTQ))).toBe(true);
  });

  test("a nullable meets a non-nullable to non-nullable", () => {
    expect(sameColumnType(meetColumn(INTQ, INT), INT)).toBe(true);
  });

  test("a value slot accepts what the other side requires", () => {
    expect(sameColumnType(meetColumn(VALUE_TYPE, INT), INT)).toBe(true);
    expect(sameColumnType(meetColumn(VALUE_TYPE, INTQ), INTQ)).toBe(true);
  });

  test("integer meets float to integer, the narrower of the two", () => {
    expect(sameColumnType(meetColumn(INT, FLOAT), INT)).toBe(true);
  });
});

describe("compatibility is directional", () => {
  test("a declaration may widen what the program proves", () => {
    expect(columnTypeCompatible(INT, FLOAT)).toBe(true);
    expect(columnTypeCompatible(INT, VALUE_TYPE)).toBe(true);
    expect(columnTypeCompatible(INT, INTQ)).toBe(true);
  });

  test("a declaration may not narrow it", () => {
    expect(columnTypeCompatible(VALUE_TYPE, INT)).toBe(false);
    expect(columnTypeCompatible(FLOAT, INT)).toBe(false);
    // The one that matters for this design: a nullable column cannot be
    // declared non-null, which is what makes the annotation a contract.
    expect(columnTypeCompatible(INTQ, INT)).toBe(false);
  });

  test("subsumption agrees with the join", () => {
    expect(subsumes(VALUE_TYPE, INT)).toBe(true);
    expect(subsumes(INTQ, NULL_TYPE)).toBe(true);
    expect(subsumes(INT, NULL_TYPE)).toBe(false);
  });
});

describe("narrowing", () => {
  test("removing null is what a guard does", () => {
    expect(sameColumnType(withoutNull(INTQ), INT)).toBe(true);
    expect(sameColumnType(withoutNull(INT), INT)).toBe(true);
  });

  test("narrowing the null type lands on bottom, so the rule derives nothing", () => {
    expect(isBottom(withoutNull(NULL_TYPE))).toBe(true);
  });

  test("adding null is what the `?` suffix does", () => {
    expect(sameColumnType(withNull(INT), INTQ)).toBe(true);
  });
});

describe("how a type prints", () => {
  test("each element has the spelling the spec uses", () => {
    expect(formatColumnType(INT)).toBe("integer");
    expect(formatColumnType(INTQ)).toBe("integer?");
    expect(formatColumnType(NULL_TYPE)).toBe("null");
    expect(formatColumnType(BOTTOM)).toBe("unknown");
  });

  test("`value?` is a distinct type from `value`, and prints as one", () => {
    // `?` means the same thing on every base type: add null. So `value` is
    // "any JSON shape but not null" and `value?` admits one.
    expect(formatColumnType(col("value"))).toBe("value");
    expect(formatColumnType(VALUE_TYPE)).toBe("value?");
    expect(sameColumnType(col("value"), VALUE_TYPE)).toBe(false);
  });
});

describe("the lattice laws the fixed points rely on", () => {
  // All twelve, including `boolean?` and the non-null `value` that §3.1 is
  // about. Laws checked over a partial set are laws checked nowhere.
  const all = [
    BOTTOM,
    NULL_TYPE,
    INT,
    FLOAT,
    STR,
    BOOL,
    INTQ,
    FLOATQ,
    STRQ,
    col("boolean", true),
    col("value"),
    VALUE_TYPE,
  ];

  test("the set under test is the whole lattice", () => {
    expect(all.length).toBe(12);
    expect(new Set(all.map(formatColumnType)).size).toBe(12);
  });

  test("join and meet are commutative", () => {
    for (const a of all) {
      for (const b of all) {
        expect(sameColumnType(joinColumn(a, b), joinColumn(b, a))).toBe(true);
        expect(sameColumnType(meetColumn(a, b), meetColumn(b, a))).toBe(true);
      }
    }
  });

  test("join and meet are associative", () => {
    for (const a of all) {
      for (const b of all) {
        for (const c of all) {
          expect(
            sameColumnType(joinColumn(joinColumn(a, b), c), joinColumn(a, joinColumn(b, c))),
          ).toBe(true);
          expect(
            sameColumnType(meetColumn(meetColumn(a, b), c), meetColumn(a, meetColumn(b, c))),
          ).toBe(true);
        }
      }
    }
  });

  test("join is monotone, which is what makes the column fixed point terminate", () => {
    for (const a of all) {
      for (const b of all) {
        expect(subsumes(joinColumn(a, b), a)).toBe(true);
        expect(subsumes(joinColumn(a, b), b)).toBe(true);
      }
    }
  });

  test("meet is below both, which is what makes the variable solve sound", () => {
    for (const a of all) {
      for (const b of all) {
        expect(subsumes(a, meetColumn(a, b))).toBe(true);
        expect(subsumes(b, meetColumn(a, b))).toBe(true);
      }
    }
  });
});
