// Regression tests for the runtime type assertions in `values.ts`. These
// exercise failure paths that the analyzer is supposed to make impossible —
// if they ever fire from float input, that's an analyzer/planner bug. The
// tests here construct synthetic AST nodes and substitutions that bypass
// the analyzer, confirming that the helpers throw a precise error rather
// than silently coercing.

import { describe, expect, test } from "bun:test";
import {
  type Substitution,
  type TypeEnv,
  type Value,
  compareOp,
  evalTerm,
} from "datamog-backend-native";
import type { HeadTerm } from "datamog-core";

const env: TypeEnv = { vars: new Map(), columns: new Map(), functionOverloads: new Map() };
/** Like `env`, but with `J` typed `value` so the accessor takes its JSON path. */
const jsonEnv: TypeEnv = {
  vars: new Map([["J", "value" as const]]),
  columns: new Map(),
  functionOverloads: new Map(),
};

// Minimal AST node builders. Langium-generated types carry $container,
// $cstNode etc. that the runtime evaluator never reads, so an `unknown`
// cast is safe at the test boundary.
function variable(name: string): HeadTerm {
  return { $type: "Variable", name } as unknown as HeadTerm;
}
function unary(op: string, operand: HeadTerm): HeadTerm {
  return { $type: "UnaryExpr", op, operand } as unknown as HeadTerm;
}
function binary(op: string, left: HeadTerm, right: HeadTerm): HeadTerm {
  return { $type: "BinaryExpr", op, left, right } as unknown as HeadTerm;
}
function call(name: string, args: HeadTerm[]): HeadTerm {
  return { $type: "FunctionCall", name, args } as unknown as HeadTerm;
}
function subscript(object: HeadTerm, index: HeadTerm): HeadTerm {
  return { $type: "Subscript", object, index } as unknown as HeadTerm;
}
function slice(object: HeadTerm, start?: HeadTerm, end?: HeadTerm): HeadTerm {
  return { $type: "Slice", object, start, end } as unknown as HeadTerm;
}
function num(value: number): HeadTerm {
  return { $type: "NumberLiteral", value } as unknown as HeadTerm;
}
function str(value: string): HeadTerm {
  return { $type: "StringLiteral", value } as unknown as HeadTerm;
}

describe("compareOp — runtime type assertions", () => {
  test("ordering of mixed string/number operands throws", () => {
    expect(() => compareOp("<", 1, "two")).toThrow(/order-compare/);
    expect(() => compareOp(">=", "x", 0)).toThrow(/order-compare/);
  });

  test("ordering of boolean operands throws", () => {
    expect(() => compareOp(">", true, false)).toThrow(/expected number or string/);
  });

  test("a null operand never yields null, and never throws", () => {
    // Equality answers, `null` being a value. An ordering does not: `null` is
    // outside the order, so there is no answer to give and none is invented.
    // See doc/design/null-as-a-value.md §4.1. Agrees with `evalTerm`, which
    // decides these cases itself rather than calling here.
    expect(compareOp("<", null, 1)).toBeUndefined();
    expect(compareOp("<", null, null)).toBeUndefined();
    expect(compareOp(">=", "a", null)).toBeUndefined();
    expect(compareOp("<=", null, null)).toBeUndefined();
    expect(compareOp(">=", null, null)).toBeUndefined();
    expect(compareOp("=", null, null)).toBe(true);
    expect(compareOp("<>", null, null)).toBe(false);
    expect(compareOp("<>", 1, null)).toBe(true);
  });

  test("equality across mismatched types is permitted (= / <> never throw)", () => {
    expect(compareOp("=", 1, "1")).toBe(false);
    expect(compareOp("<>", 1, "1")).toBe(true);
    expect(compareOp("=", true, 1)).toBe(false);
  });

  test("Regression: equality compares value compounds structurally", () => {
    // `compareOp` is an exported runtime helper. It used JS identity for
    // objects, so two structurally equal value compounds compared as
    // unequal even though logical equality, atom matching, and SQL backends
    // use canonical structural equality.
    expect(compareOp("=", { a: 1 }, { a: 1 })).toBe(true);
    expect(compareOp("=", { b: 2, a: 1 }, { a: 1, b: 2 })).toBe(true);
    expect(compareOp("<>", [1, { a: true }], [1, { a: true }])).toBe(false);
  });
});

describe("evalTerm — runtime type assertions", () => {
  test("unary minus on a string-bound variable throws", () => {
    const sub: Substitution = new Map([["X", "hello"]]);
    expect(() => evalTerm(unary("-", variable("X")), sub, env)).toThrow(/expected number/);
  });

  test("numeric binary op on a boolean-bound variable throws", () => {
    const sub: Substitution = new Map<string, boolean | number>([
      ["X", true],
      ["Y", 1],
    ]);
    expect(() => evalTerm(binary("*", variable("X"), variable("Y")), sub, env)).toThrow(
      /expected number/,
    );
  });

  test("modulo with a string operand throws", () => {
    const sub: Substitution = new Map<string, string | number>([
      ["X", 7],
      ["Y", "two"],
    ]);
    expect(() => evalTerm(binary("%", variable("X"), variable("Y")), sub, env)).toThrow(
      /expected number/,
    );
  });

  test("string function on a number-bound variable throws", () => {
    const sub: Substitution = new Map([["X", 42]]);
    expect(() => evalTerm(call("upper", [variable("X")]), sub, env)).toThrow(/expected string/);
  });

  test("numeric function on a string-bound variable throws", () => {
    const sub: Substitution = new Map([["X", "hello"]]);
    expect(() => evalTerm(call("abs", [variable("X")]), sub, env)).toThrow(/expected number/);
  });

  test("subscript object that is not a string throws", () => {
    const sub: Substitution = new Map<string, number>([
      ["X", 42],
      ["I", 0],
    ]);
    expect(() => evalTerm(subscript(variable("X"), variable("I")), sub, env)).toThrow(
      /expected string/,
    );
  });

  test("subscript index that is not a number throws", () => {
    const sub: Substitution = new Map<string, string>([
      ["X", "hello"],
      ["I", "0"],
    ]);
    expect(() => evalTerm(subscript(variable("X"), variable("I")), sub, env)).toThrow(
      /expected number/,
    );
  });

  test("null operand still short-circuits to null without triggering a check", () => {
    const sub: Substitution = new Map<string, null | number>([
      ["X", null],
      ["Y", 2],
    ]);
    expect(evalTerm(binary("*", variable("X"), variable("Y")), sub, env)).toBe(null);
    expect(evalTerm(unary("-", variable("X")), sub, env)).toBe(null);
  });
});

describe("evalTerm — boolean operators", () => {
  // The connectives are non-strict at their absorbing value and strict
  // otherwise: `false` dominates `&&` and `true` dominates `||`, whatever the
  // other operand is, and past that an operand must be a truth value. A `null`
  // is not one, so it leaves the connective with no value (`undefined`) rather
  // than yielding SQL's "unknown". Same argument as the orderings' strictness,
  // and it is what keeps a connective's result non-nullable so that a SQL NULL
  // in one reads as undefined. See doc/design/null-as-a-value.md §15.26.
  //
  // The absorbing rows are the ones that matter for the guard idiom, and they
  // are exactly the rows that did not move.
  const cases: {
    op: "&&" | "||";
    l: boolean | null;
    r: boolean | null;
    expected: boolean | undefined;
  }[] = [
    // && — false dominates
    { op: "&&", l: false, r: false, expected: false },
    { op: "&&", l: false, r: true, expected: false },
    { op: "&&", l: true, r: false, expected: false },
    { op: "&&", l: true, r: true, expected: true },
    { op: "&&", l: false, r: null, expected: false },
    { op: "&&", l: null, r: false, expected: false },
    { op: "&&", l: true, r: null, expected: undefined },
    { op: "&&", l: null, r: true, expected: undefined },
    { op: "&&", l: null, r: null, expected: undefined },
    // || — true dominates
    { op: "||", l: false, r: false, expected: false },
    { op: "||", l: false, r: true, expected: true },
    { op: "||", l: true, r: false, expected: true },
    { op: "||", l: true, r: true, expected: true },
    { op: "||", l: true, r: null, expected: true },
    { op: "||", l: null, r: true, expected: true },
    { op: "||", l: false, r: null, expected: undefined },
    { op: "||", l: null, r: false, expected: undefined },
    { op: "||", l: null, r: null, expected: undefined },
  ];
  for (const c of cases) {
    test(`${c.op}: ${c.l} ${c.op} ${c.r} = ${c.expected}`, () => {
      const sub: Substitution = new Map<string, boolean | null>([
        ["L", c.l],
        ["R", c.r],
      ]);
      expect(evalTerm(binary(c.op, variable("L"), variable("R")), sub, env)).toBe(c.expected);
    });
  }

  test("! true = false; ! false = true; ! null has no value", () => {
    // `!` has no absorbing operand, so it is strict at a null outright.
    const sub: Substitution = new Map<string, boolean | null>([
      ["T", true],
      ["F", false],
      ["N", null],
    ]);
    expect(evalTerm(unary("!", variable("T")), sub, env)).toBe(false);
    expect(evalTerm(unary("!", variable("F")), sub, env)).toBe(true);
    expect(evalTerm(unary("!", variable("N")), sub, env)).toBeUndefined();
  });

  test("&& on a non-boolean operand throws", () => {
    const sub: Substitution = new Map<string, boolean | number>([
      ["X", true],
      ["Y", 1],
    ]);
    expect(() => evalTerm(binary("&&", variable("X"), variable("Y")), sub, env)).toThrow(
      /expected boolean/,
    );
  });

  test("! on a non-boolean operand throws", () => {
    const sub: Substitution = new Map([["X", 1]]);
    expect(() => evalTerm(unary("!", variable("X")), sub, env)).toThrow(/expected boolean/);
  });
});

describe("evalTerm — safe integer arithmetic", () => {
  test("keeps safe results and maps overflow to no value", () => {
    // Leaving the integer domain is a domain failure, so the result is
    // `undefined` (no value) rather than `null` (the null value). The two are
    // different markers and the accessor in §8 is why: see
    // doc/design/null-as-a-value.md §15.5.
    expect(evalTerm(binary("+", num(Number.MAX_SAFE_INTEGER), num(0)), new Map(), env)).toBe(
      Number.MAX_SAFE_INTEGER,
    );
    expect(
      evalTerm(binary("+", num(Number.MAX_SAFE_INTEGER), num(1)), new Map(), env),
    ).toBeUndefined();
    expect(
      evalTerm(binary("-", num(Number.MIN_SAFE_INTEGER), num(1)), new Map(), env),
    ).toBeUndefined();
    expect(evalTerm(binary("*", num(94_906_266), num(94_906_266)), new Map(), env)).toBeUndefined();
  });
});

describe("evalTerm — NULL propagation through non-boolean expressions", () => {
  // Spec §5.4 propagation rule: any NULL operand makes the whole
  // expression NULL, except for &&/|| short-circuit (covered above).
  // The boolean operators have their own coverage matrix; this block
  // covers arithmetic, string concat, string functions, subscript,
  // slice, and comparison expressions.
  const nullSub = (): Substitution =>
    new Map<string, null | number | string>([
      ["N", null],
      ["I", 5],
      ["S", "hello"],
    ]);

  test("arithmetic: NULL + 1 = NULL, 1 - NULL = NULL", () => {
    const sub = nullSub();
    expect(evalTerm(binary("+", variable("N"), num(1)), sub, env)).toBe(null);
    expect(evalTerm(binary("-", num(1), variable("N")), sub, env)).toBe(null);
  });

  test("string concatenation: NULL + 'x' = NULL, 'x' + NULL = NULL", () => {
    const sub = nullSub();
    expect(evalTerm(binary("+", variable("N"), str("x")), sub, env)).toBe(null);
    expect(evalTerm(binary("+", str("x"), variable("N")), sub, env)).toBe(null);
  });

  test("equality answers at NULL and the orderings have no answer", () => {
    // NULL stops travelling at a comparison either way: no comparison ever
    // *yields* a null. They part on what they do instead. Equality is total over
    // values, `null` being one, so it answers. An ordering needs an order and
    // `null` is not in one, so it has no value (null-as-a-value.md §4.1). In
    // condition position both readings drop the row, which is why so little
    // observes this; `null <= null` is the case that moved, from true by
    // convention to no answer at all.
    const sub = nullSub();
    expect(evalTerm(binary("<", variable("N"), num(1)), sub, env)).toBeUndefined();
    expect(evalTerm(binary(">=", num(1), variable("N")), sub, env)).toBeUndefined();
    expect(evalTerm(binary("<=", variable("N"), variable("N")), sub, env)).toBeUndefined();
    expect(evalTerm(binary("=", variable("N"), num(1)), sub, env)).toBe(false);
    expect(evalTerm(binary("<>", num(1), variable("N")), sub, env)).toBe(true);
  });

  test("string functions: length/upper/lower/trim/replace propagate NULL", () => {
    const sub = nullSub();
    // `length` takes a `value` parameter, so the null is an argument rather than
    // an absence and reaches the function, which has no answer for it: undefined.
    // The string-typed functions above still propagate, their parameter being a
    // primitive. See doc/design/null-as-a-value.md §15.10.
    expect(evalTerm(call("length", [variable("N")]), sub, env)).toBeUndefined();
    expect(evalTerm(call("upper", [variable("N")]), sub, env)).toBe(null);
    expect(evalTerm(call("lower", [variable("N")]), sub, env)).toBe(null);
    expect(evalTerm(call("trim", [variable("N")]), sub, env)).toBe(null);
    // replace: NULL in any of three args propagates.
    expect(evalTerm(call("replace", [variable("N"), str("a"), str("b")]), sub, env)).toBe(null);
    expect(evalTerm(call("replace", [str("aaa"), variable("N"), str("b")]), sub, env)).toBe(null);
    expect(evalTerm(call("replace", [str("aaa"), str("a"), variable("N")]), sub, env)).toBe(null);
  });

  test("math functions: abs/round/floor/ceil/exp propagate NULL", () => {
    const sub = nullSub();
    expect(evalTerm(call("abs", [variable("N")]), sub, env)).toBe(null);
    expect(evalTerm(call("round", [variable("N")]), sub, env)).toBe(null);
    expect(evalTerm(call("floor", [variable("N")]), sub, env)).toBe(null);
    expect(evalTerm(call("ceil", [variable("N")]), sub, env)).toBe(null);
    expect(evalTerm(call("exp", [variable("N")]), sub, env)).toBe(null);
  });

  test("subscript: a null receiver or index has no result, so no value", () => {
    // Accessing into a null, or at a null index, is a shape the operation has no
    // answer for, so it is undefined rather than null. That distinction is what
    // §8 needs: it leaves SQL NULL, and JS `null`, free to mean the null *value*
    // a present-but-null key holds. See doc/design/null-as-a-value.md §15.5.
    const sub = nullSub();
    expect(evalTerm(subscript(variable("N"), num(0)), sub, env)).toBeUndefined();
    expect(evalTerm(subscript(variable("S"), variable("N")), sub, env)).toBeUndefined();
  });

  test("slice: a null receiver or bound has no result, so no value", () => {
    const sub = nullSub();
    expect(evalTerm(slice(variable("N"), num(0), num(2)), sub, env)).toBeUndefined();
    expect(evalTerm(slice(variable("S"), variable("N"), num(2)), sub, env)).toBeUndefined();
    expect(evalTerm(slice(variable("S"), num(0), variable("N")), sub, env)).toBeUndefined();
  });

  test("but a present-but-null key yields the null value, not an absence", () => {
    // The pair this whole distinction exists for.
    const withObj = new Map([["J", { k: null } as unknown as Value]]);
    expect(evalTerm(subscript(variable("J"), str("k")), withObj, jsonEnv)).toBe(null);
    expect(evalTerm(subscript(variable("J"), str("missing")), withObj, jsonEnv)).toBeUndefined();
  });
});

describe("bitwise / shift operators (32-bit signed, Java/JS semantics)", () => {
  const i = (n: number): HeadTerm => num(n);
  const bit = (op: string, a: number, b: number): unknown =>
    evalTerm(binary(op, i(a), i(b)), new Map(), env);

  test("&, |, ^ on small integers", () => {
    expect(bit("&", 5, 3)).toBe(1);
    expect(bit("|", 5, 2)).toBe(7);
    expect(bit("^", 6, 3)).toBe(5);
  });

  test("& / | / ^ on negative operands stay 32-bit signed", () => {
    expect(bit("&", -1, 255)).toBe(255);
    expect(bit("|", -2, 1)).toBe(-1);
    expect(bit("^", -1, -1)).toBe(0);
  });

  test("<< wraps at the sign bit (1 << 31 = INT_MIN)", () => {
    expect(bit("<<", 1, 4)).toBe(16);
    expect(bit("<<", 1, 31)).toBe(-2147483648);
  });

  test(">> is an arithmetic (sign-extending) shift", () => {
    expect(bit(">>", -8, 1)).toBe(-4);
    expect(bit(">>", 16, 2)).toBe(4);
  });

  test(">>> is a logical (zero-fill) shift, result reinterpreted as int32", () => {
    expect(bit(">>>", -8, 28)).toBe(15);
    expect(bit(">>>", -1, 0)).toBe(-1);
    expect(bit(">>>", -1, 1)).toBe(2147483647);
  });

  test("shift count is taken mod 32", () => {
    expect(bit("<<", 5, 40)).toBe(1280); // 40 mod 32 = 8
    expect(bit("<<", 1, 32)).toBe(1); // 32 mod 32 = 0
  });

  test("NULL operand propagates to NULL", () => {
    const sub: Substitution = new Map();
    for (const op of ["&", "|", "^", "<<", ">>", ">>>"]) {
      expect(evalTerm(binary(op, variable("N"), i(7)), sub, env)).toBe(null);
      expect(evalTerm(binary(op, i(7), variable("N")), sub, env)).toBe(null);
    }
  });
});

describe("evalTerm — an absent part leaves the compound with no value", () => {
  // An absence is not a wrong type, so it must never reach one of the assertion
  // helpers: an accessor is strict in it and answers `undefined`, which is what
  // withholds the row. See doc/design/null-as-a-value.md §1.
  //
  // `1 / 0` is the shortest expression with no value.
  const absent = (): HeadTerm => binary("/", num(1), num(0));

  test("a subscript with an absent index or receiver", () => {
    expect(evalTerm(subscript(str("abcdef"), absent()), new Map(), env)).toBeUndefined();
    expect(evalTerm(subscript(absent(), num(0)), new Map(), env)).toBeUndefined();
  });

  test("a string slice with an absent bound or receiver", () => {
    expect(evalTerm(slice(str("abcdef"), num(0), absent()), new Map(), env)).toBeUndefined();
    expect(evalTerm(slice(str("abcdef"), absent(), num(3)), new Map(), env)).toBeUndefined();
    expect(evalTerm(slice(absent(), num(0), num(3)), new Map(), env)).toBeUndefined();
  });

  test("a value slice with an absent bound, next to one that has values", () => {
    const withArr = new Map([["J", [1, 2, 3] as unknown as Value]]);
    expect(evalTerm(slice(variable("J"), num(0), absent()), withArr, jsonEnv)).toBeUndefined();
    expect(evalTerm(slice(variable("J"), absent(), num(3)), withArr, jsonEnv)).toBeUndefined();
    expect(evalTerm(slice(variable("J"), num(0), num(2)), withArr, jsonEnv)).toEqual([1, 2]);
  });
});

describe("evalTerm — round at a scale beyond the float range", () => {
  test("a scale finer than the value's precision is the identity", () => {
    // `9e12 * 10 ** 300` leaves the float range, but no double that large carries
    // a digit at the 300th decimal place, so there is nothing to round away and
    // the answer is the input. Both SQL backends answer the same.
    expect(evalTerm(call("round", [num(9_000_000_000_000), num(300)]), new Map(), env)).toBe(
      9_000_000_000_000,
    );
  });

  test("a rounded result outside the float range has no value", () => {
    // Scaling by `10 ** -308` and rounding up pushes the unscaled result past the
    // float range. The integer overload truncates whatever the scaling produced,
    // so it has to carry the absence through rather than assert on it.
    const sub: Substitution = new Map<string, number>([
      ["X", 1.7e308],
      ["N", -308],
    ]);
    expect(evalTerm(call("round", [variable("X"), variable("N")]), sub, env)).toBeUndefined();
  });
});
