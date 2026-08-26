import { describe, expect, test } from "bun:test";
import type {
  AggregateCall,
  AggregateFunction,
  ExtDecl,
  Literal,
  Query,
  Rule,
} from "../src/index.ts";
import { ParseError, parse, parseLenient } from "../src/index.ts";

describe("parser", () => {
  test("ext declaration", () => {
    const program = parse("input predicate parent(name: string, child: string).");
    expect(program.statements).toHaveLength(1);
    const decl = program.statements[0] as ExtDecl;
    expect(decl.$type).toBe("ExtDecl");
    expect(decl.predicate).toBe("parent");
    expect(decl.columns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "name", type: "string" }),
        expect.objectContaining({ name: "child", type: "string" }),
      ]),
    );
  });

  test("ext declaration with all types", () => {
    const program = parse(
      "input predicate t(a: string, b: integer?, c: float, d: boolean?, e: value).",
    );
    const decl = program.statements[0] as ExtDecl;
    expect(decl.columns[0]).toMatchObject({ name: "a", type: "string" });
    expect(decl.columns[1]).toMatchObject({ name: "b", type: "integer", nullable: true });
    expect(decl.columns[2]).toMatchObject({ name: "c", type: "float" });
    expect(decl.columns[3]).toMatchObject({ name: "d", type: "boolean", nullable: true });
    expect(decl.columns[4]).toMatchObject({ name: "e", type: "value" });
  });

  test("unannotated columns default to string", () => {
    const program = parse("input predicate person(name, age: integer, city, note?).");
    const decl = program.statements[0] as ExtDecl;
    expect(decl.columns[0]).toMatchObject({ name: "name", type: "string" });
    expect(decl.columns[1]).toMatchObject({ name: "age", type: "integer" });
    expect(decl.columns[2]).toMatchObject({ name: "city", type: "string" });
    // `note?` is a nullable untyped column: string, nullable.
    expect(decl.columns[3]).toMatchObject({ name: "note", type: "string", nullable: true });
  });

  test("quoted predicate and column identifiers", () => {
    const program = parse(`
      input predicate \`http-event\`(\`content-type\`: string, \`in\`: integer).
      \`ok-response\`(Kind) :- \`http-event\`(Kind, Code), Code = 200.
      ?- \`ok-response\`(Kind).
    `);
    const decl = program.statements[0] as ExtDecl;
    expect(decl.predicate).toBe("http-event");
    expect(decl.columns[0]).toMatchObject({ name: "content-type", type: "string" });
    expect(decl.columns[1]).toMatchObject({ name: "in", type: "integer" });

    const rule = program.statements[1] as Rule;
    expect(rule.head.predicate).toBe("ok-response");
    expect(rule.body[0]).toMatchObject({ $type: "Literal", predicate: "http-event" });

    const query = program.statements[2] as Query;
    expect(query.body[0]).toMatchObject({ $type: "Literal", predicate: "ok-response" });
  });

  test("quoted variables behave the same as unquoted variables", () => {
    // Backticks are a pure syntactic escape: `Foo` and Foo refer to
    // the same variable. Whether an identifier is a variable or a
    // predicate is decided by syntactic position (`(` follows = call /
    // literal; otherwise variable) — casing and quoting don't change it.
    const program = parse("p(`X`) :- q(X).");
    const rule = program.statements[0] as Rule;
    expect(rule.head.args[0]).toMatchObject({ $type: "Variable", name: "X" });
    expect(rule.body[0]).toMatchObject({
      $type: "Literal",
      predicate: "q",
      args: [expect.objectContaining({ $type: "Variable", name: "X" })],
    });
  });

  test("backtick-quoted variables can contain punctuation", () => {
    const program = parse("p(`First Name`) :- q(`First Name`).");
    const rule = program.statements[0] as Rule;
    expect(rule.head.args[0]).toMatchObject({ $type: "Variable", name: "First Name" });
    expect(rule.body[0]).toMatchObject({
      $type: "Literal",
      args: [expect.objectContaining({ $type: "Variable", name: "First Name" })],
    });
  });

  test("backtick-quoted don't-care variable", () => {
    // `_` and _ are both anonymous; each occurrence becomes its own
    // fresh internal name during post-processing.
    const program = parse("p(`_`, _) :- q(X).");
    const rule = program.statements[0] as Rule;
    const arg0 = rule.head.args[0] as { $type: string; name: string };
    const arg1 = rule.head.args[1] as { $type: string; name: string };
    expect(arg0.$type).toBe("Variable");
    expect(arg1.$type).toBe("Variable");
    expect(arg0.name).toMatch(/^\$anon/);
    expect(arg1.name).toMatch(/^\$anon/);
    expect(arg0.name).not.toBe(arg1.name);
  });

  test("backtick-quoted identifier starting with a digit works in predicate position", () => {
    // QUOTED_IDENT accepts any non-empty backticked content, including
    // names that the bare IDENT pattern would reject (digits, hyphens).
    const program = parse("`2024-q1`(X) :- something(X).");
    const rule = program.statements[0] as Rule;
    expect(rule.head.predicate).toBe("2024-q1");
  });

  test("uppercase identifier is a predicate when followed by parens", () => {
    // Case doesn't determine the lexical role — syntactic position does.
    // `Foo(` commits to a Literal / HeadAtom; the same `Foo` elsewhere
    // would be a Variable.
    const program = parse("Foo(X, Y) :- Bar(X, Y).");
    const rule = program.statements[0] as Rule;
    expect(rule.head.predicate).toBe("Foo");
    expect(rule.head.args[0]).toMatchObject({ $type: "Variable", name: "X" });
    expect(rule.body[0]).toMatchObject({ $type: "Literal", predicate: "Bar" });
  });

  test("lowercase identifier is a variable when not followed by parens", () => {
    const program = parse("path(a, b) :- edge(a, b).");
    const rule = program.statements[0] as Rule;
    expect(rule.head.predicate).toBe("path");
    expect(rule.head.args[0]).toMatchObject({ $type: "Variable", name: "a" });
    expect(rule.head.args[1]).toMatchObject({ $type: "Variable", name: "b" });
    expect(rule.body[0]).toMatchObject({
      $type: "Literal",
      predicate: "edge",
      args: [
        expect.objectContaining({ $type: "Variable", name: "a" }),
        expect.objectContaining({ $type: "Variable", name: "b" }),
      ],
    });
  });

  test("same identifier can be a predicate and a variable in the same rule", () => {
    // `Edge` is the predicate (followed by `(`), then `edge` is bound as
    // a variable. The two are unrelated names that happen to look alike.
    const program = parse("Edge(edge, dst) :- raw(edge, dst).");
    const rule = program.statements[0] as Rule;
    expect(rule.head.predicate).toBe("Edge");
    expect(rule.head.args[0]).toMatchObject({ $type: "Variable", name: "edge" });
    expect(rule.body[0]).toMatchObject({ $type: "Literal", predicate: "raw" });
  });

  test("simple rule", () => {
    const program = parse("ancestor(X, Y) :- parent(X, Y).");
    expect(program.statements).toHaveLength(1);
    const rule = program.statements[0] as Rule;
    expect(rule.$type).toBe("Rule");
    expect(rule.head.predicate).toBe("ancestor");
    expect(rule.head.args).toHaveLength(2);
    expect(rule.head.args[0]).toMatchObject({ $type: "Variable", name: "X" });
    expect(rule.head.args[1]).toMatchObject({ $type: "Variable", name: "Y" });
    expect(rule.body).toHaveLength(1);
    expect(rule.body[0]).toMatchObject({ $type: "Literal", predicate: "parent" });
  });

  test("rule with multiple body atoms", () => {
    const program = parse("ancestor(X, Y) :- parent(X, Z), ancestor(Z, Y).");
    const rule = program.statements[0] as Rule;
    expect(rule.body).toHaveLength(2);
    expect(rule.body[0]).toMatchObject({ predicate: "parent" });
    expect(rule.body[1]).toMatchObject({ predicate: "ancestor" });
  });

  test("fact (rule with no body)", () => {
    const program = parse('base("x").');
    const rule = program.statements[0] as Rule;
    expect(rule.$type).toBe("Rule");
    expect(rule.head.predicate).toBe("base");
    expect(rule.body).toHaveLength(0);
  });

  test("query", () => {
    const program = parse('?- ancestor("alice", X).');
    expect(program.statements).toHaveLength(1);
    const query = program.statements[0] as Query;
    expect(query.$type).toBe("Query");
    expect(query.body).toHaveLength(1);
    const literal = query.body[0] as Literal;
    expect(literal.predicate).toBe("ancestor");
    expect(literal.args[0]).toMatchObject({ $type: "StringLiteral", value: "alice" });
    expect(literal.args[1]).toMatchObject({ $type: "Variable", name: "X" });
  });

  test("conjunctive query (multiple body literals)", () => {
    const program = parse("?- parent(N, C), ancestor(C, G).");
    expect(program.statements).toHaveLength(1);
    const query = program.statements[0] as Query;
    expect(query.$type).toBe("Query");
    expect(query.body).toHaveLength(2);
    expect(query.body[0]).toMatchObject({ $type: "Literal", predicate: "parent" });
    expect(query.body[1]).toMatchObject({ $type: "Literal", predicate: "ancestor" });
  });

  test("number literal in term", () => {
    const program = parse("foo(42, 3.14).");
    const rule = program.statements[0] as Rule;
    expect(rule.head.args[0]).toMatchObject({ $type: "NumberLiteral", value: 42 });
    expect(rule.head.args[1]).toMatchObject({ $type: "NumberLiteral", value: 3.14 });
  });

  test("binary integer literal in term", () => {
    const program = parse("bits(0b101, 0b0).");
    const rule = program.statements[0] as Rule;
    // `0b101` = 5; post-processing converts to the decimal value and
    // normalises rawText so later stages see an ordinary integer literal.
    expect(rule.head.args[0]).toMatchObject({
      $type: "NumberLiteral",
      value: 5,
      rawText: "5",
    });
    expect(rule.head.args[1]).toMatchObject({ $type: "NumberLiteral", value: 0 });
  });

  test("boolean literal in term", () => {
    const program = parse("flag(true, false).");
    const rule = program.statements[0] as Rule;
    expect(rule.head.args[0]).toMatchObject({ $type: "BooleanLiteral", value: true });
    expect(rule.head.args[1]).toMatchObject({ $type: "BooleanLiteral", value: false });
  });

  test("string literal escape sequences", () => {
    const program = parse('text("line\\nbreak", "say \\"hi\\"", "slash\\\\path").');
    const rule = program.statements[0] as Rule;
    expect(rule.head.args[0]).toMatchObject({ $type: "StringLiteral", value: "line\nbreak" });
    expect(rule.head.args[1]).toMatchObject({ $type: "StringLiteral", value: 'say "hi"' });
    expect(rule.head.args[2]).toMatchObject({ $type: "StringLiteral", value: "slash\\path" });
  });

  test("complete program", () => {
    const source = `
      # Extensional
      input predicate parent(name: string, child: string).

      # Rules
      ancestor(X, Y) :- parent(X, Y).
      ancestor(X, Y) :- parent(X, Z), ancestor(Z, Y).

      # Query
      ?- ancestor("alice", X).
    `;
    const program = parse(source);
    expect(program.statements).toHaveLength(4);
    expect(program.statements[0]?.$type).toBe("ExtDecl");
    expect(program.statements[1]?.$type).toBe("Rule");
    expect(program.statements[2]?.$type).toBe("Rule");
    expect(program.statements[3]?.$type).toBe("Query");
  });

  test("rejects unexpected token", () => {
    expect(() => parse(":-")).toThrow();
  });

  test("rejects missing dot", () => {
    expect(() => parse("foo(X)")).toThrow();
  });

  test("rejects missing closing paren", () => {
    expect(() => parse("foo(X.")).toThrow();
  });

  test("don't-care variables get unique names", () => {
    const program = parse("foo(_, _) :- bar(_, X).");
    const rule = program.statements[0] as Rule;
    const headArgs = rule.head.args;
    expect(headArgs[0]).toMatchObject({ $type: "Variable" });
    expect(headArgs[1]).toMatchObject({ $type: "Variable" });
    // Each _ should have a distinct generated name
    expect((headArgs[0] as { name: string }).name).not.toBe((headArgs[1] as { name: string }).name);
    // Body _ should also be distinct from head _s
    const bodyLit = rule.body[0]!;
    if (bodyLit.$type === "Literal") {
      const bodyArg = bodyLit.args[0]!;
      expect(bodyArg).toMatchObject({ $type: "Variable" });
      expect((bodyArg as { name: string }).name).not.toBe((headArgs[0] as { name: string }).name);
      // Named variable X should be preserved
      expect(bodyLit.args[1]).toMatchObject({ $type: "Variable", name: "X" });
    }
  });

  test("negated literal in rule body", () => {
    const program = parse("foo(X) :- bar(X), not baz(X).");
    const rule = program.statements[0] as Rule;
    expect(rule.body).toHaveLength(2);
    expect(rule.body[0]?.negated).toBeFalsy();
    expect(rule.body[1]?.negated).toBe(true);
    if (rule.body[1]?.$type === "Literal") {
      expect(rule.body[1].predicate).toBe("baz");
    }
  });

  test("negated comparison atom stays a negated filter, not a logical-not", () => {
    // `not X = Y` keeps its `negated` flag rather than being rewritten into a
    // Filter over `!(X = Y)`. The two are different operators: `not` is
    // negation as failure and `!` propagates a NULL operand. They agree on a
    // comparison, which is why the rewrite used to be safe, and they do not
    // agree in general. See doc/design/null-as-a-value.md §4.4.
    const program = parse("foo(X, Y) :- bar(X), bar(Y), not X = Y.");
    const rule = program.statements[0] as Rule;
    expect(rule.body).toHaveLength(3);
    const filter = rule.body[2]!;
    expect(filter.$type).toBe("Filter");
    if (filter.$type === "Filter") {
      expect(filter.negated).toBe(true);
      // The comparison is left exactly as parsed, with no synthesised node.
      expect(filter.expr.$type).toBe("BinaryExpr");
      expect(filter.expr.$container).toBe(filter);
    }
  });

  test("negated comparison with a function-call LHS stays a filter, not a literal", () => {
    // `not length(W) = 3` looks like `not IDENT(...)` (the negated-literal
    // shape) up to the `)`, but the trailing `= 3` makes it a comparison.
    const program = parse("foo(W) :- s(W), not length(W) = 3.");
    const rule = program.statements[0] as Rule;
    const filter = rule.body[1]!;
    expect(filter.$type).toBe("Filter");
    if (filter.$type === "Filter") {
      expect(filter.negated).toBe(true);
      expect(filter.expr.$type).toBe("BinaryExpr");
    }
  });

  test("arithmetic expression in atom argument", () => {
    const program = parse("foo(X + 1) :- bar(X).");
    const rule = program.statements[0] as Rule;
    const arg = rule.head.args[0]!;
    expect(arg.$type).toBe("BinaryExpr");
    if (arg.$type === "BinaryExpr") {
      expect(arg.op).toBe("+");
      expect(arg.left).toMatchObject({ $type: "Variable", name: "X" });
      expect(arg.right).toMatchObject({ $type: "NumberLiteral", value: 1 });
    }
  });

  test("operator precedence: * before +", () => {
    const program = parse("foo(X + Y * 2) :- bar(X, Y).");
    const rule = program.statements[0] as Rule;
    const arg = rule.head.args[0]!;
    expect(arg.$type).toBe("BinaryExpr");
    if (arg.$type === "BinaryExpr") {
      expect(arg.op).toBe("+");
      expect(arg.left).toMatchObject({ $type: "Variable", name: "X" });
      expect(arg.right.$type).toBe("BinaryExpr");
    }
  });

  test("unary minus", () => {
    const program = parse("foo(-X) :- bar(X).");
    const rule = program.statements[0] as Rule;
    const arg = rule.head.args[0]!;
    expect(arg.$type).toBe("UnaryExpr");
    if (arg.$type === "UnaryExpr") {
      expect(arg.op).toBe("-");
      expect(arg.operand).toMatchObject({ $type: "Variable", name: "X" });
    }
  });

  test("parenthesized expression", () => {
    const program = parse("foo((X + 1) * 2) :- bar(X).");
    const rule = program.statements[0] as Rule;
    const arg = rule.head.args[0]!;
    expect(arg.$type).toBe("BinaryExpr");
    if (arg.$type === "BinaryExpr") {
      expect(arg.op).toBe("*");
      expect(arg.left.$type).toBe("BinaryExpr");
      expect(arg.right).toMatchObject({ $type: "NumberLiteral", value: 2 });
    }
  });

  test("equality in rule body", () => {
    const program = parse("foo(X, Z) :- bar(X, Y), Z = Y + 1.");
    const rule = program.statements[0] as Rule;
    expect(rule.body).toHaveLength(2);
    const eq = rule.body[1]!;
    expect(eq.$type).toBe("Equality");
    if (eq.$type === "Equality") {
      expect(eq.left.$type).toBe("Variable");
      if (eq.left.$type === "Variable") expect(eq.left.name).toBe("Z");
      expect(eq.expr.$type).toBe("BinaryExpr");
    }
  });

  test("% operator for modulo", () => {
    const program = parse("foo(R) :- bar(X), R = X % 2.");
    const rule = program.statements[0] as Rule;
    expect(rule.body).toHaveLength(2);
    const eq = rule.body[1]!;
    expect(eq.$type).toBe("Equality");
    if (eq.$type === "Equality") {
      expect(eq.expr.$type).toBe("BinaryExpr");
      if (eq.expr.$type === "BinaryExpr") {
        expect(eq.expr.op).toBe("%");
      }
    }
  });

  test("array literal in equality RHS", () => {
    const program = parse("r(J) :- J = [1, 2, 3].");
    const rule = program.statements[0] as Rule;
    const eq = rule.body[0]!;
    expect(eq.$type).toBe("Equality");
    if (eq.$type === "Equality") {
      expect(eq.expr.$type).toBe("ArrayLiteral");
      if (eq.expr.$type === "ArrayLiteral") {
        expect(eq.expr.elements).toHaveLength(3);
        expect(eq.expr.elements[0]).toMatchObject({ $type: "NumberLiteral", value: 1 });
      }
    }
  });

  test("empty array literal", () => {
    const program = parse("r(J) :- J = [].");
    const rule = program.statements[0] as Rule;
    const eq = rule.body[0]!;
    if (eq.$type === "Equality" && eq.expr.$type === "ArrayLiteral") {
      expect(eq.expr.elements).toHaveLength(0);
    } else {
      throw new Error("expected empty ArrayLiteral");
    }
  });

  test("object literal with nested array", () => {
    const program = parse('r(J) :- J = {"name": "alice", "tags": ["a", "b"]}.');
    const rule = program.statements[0] as Rule;
    const eq = rule.body[0]!;
    if (eq.$type === "Equality" && eq.expr.$type === "ObjectLiteral") {
      expect(eq.expr.entries).toHaveLength(2);
      expect(eq.expr.entries[0]?.key).toBe("name");
      expect(eq.expr.entries[1]?.key).toBe("tags");
      expect(eq.expr.entries[1]?.value.$type).toBe("ArrayLiteral");
    } else {
      throw new Error("expected ObjectLiteral");
    }
  });

  test("subscript into array literal", () => {
    const program = parse("r(J) :- J = [10, 20, 30][1].");
    const rule = program.statements[0] as Rule;
    const eq = rule.body[0]!;
    if (eq.$type === "Equality" && eq.expr.$type === "Subscript") {
      expect(eq.expr.object.$type).toBe("ArrayLiteral");
      expect(eq.expr.index).toMatchObject({ $type: "NumberLiteral", value: 1 });
    } else {
      throw new Error("expected Subscript over ArrayLiteral");
    }
  });

  test("comparison in rule body parses as Filter wrapping a comparison BinaryExpr", () => {
    const program = parse("foo(X) :- bar(X, Y), Y > 10.");
    const rule = program.statements[0] as Rule;
    expect(rule.body).toHaveLength(2);
    const filter = rule.body[1]!;
    expect(filter.$type).toBe("Filter");
    if (filter.$type === "Filter") {
      expect(filter.expr.$type).toBe("BinaryExpr");
      if (filter.expr.$type === "BinaryExpr") {
        expect(filter.expr.op).toBe(">");
        expect(filter.expr.left).toMatchObject({ $type: "Variable", name: "Y" });
        expect(filter.expr.right).toMatchObject({ $type: "NumberLiteral", value: 10 });
      }
    }
  });

  test("comparison with expressions on both sides", () => {
    const program = parse("foo(X) :- bar(X, Y), X + 1 <= Y * 2.");
    const rule = program.statements[0] as Rule;
    const filter = rule.body[1]!;
    expect(filter.$type).toBe("Filter");
    if (filter.$type === "Filter" && filter.expr.$type === "BinaryExpr") {
      expect(filter.expr.op).toBe("<=");
      expect(filter.expr.left.$type).toBe("BinaryExpr");
      expect(filter.expr.right.$type).toBe("BinaryExpr");
    }
  });

  test("all comparison operators", () => {
    for (const [src, op] of [
      ["X < 1", "<"],
      ["X > 1", ">"],
      ["X <= 1", "<="],
      ["X >= 1", ">="],
      ["X <> 1", "<>"],
      // `!=` is an accepted spelling of `<>`; `parseRaw` normalises it, so
      // the AST carries the canonical operator.
      ["X != 1", "<>"],
    ] as const) {
      const program = parse(`foo(X) :- bar(X), ${src}.`);
      const rule = program.statements[0] as Rule;
      const filter = rule.body[1]!;
      expect(filter.$type).toBe("Filter");
      if (filter.$type === "Filter" && filter.expr.$type === "BinaryExpr") {
        expect(filter.expr.op).toBe(op);
      }
    }
  });

  test("logical equality operators parse in expression position", () => {
    for (const op of ["=", "<>"] as const) {
      const program = parse(`foo(B) :- bar(X), B = (X ${op} 1).`);
      const rule = program.statements[0] as Rule;
      const equality = rule.body[1]!;
      expect(equality.$type).toBe("Equality");
      if (equality.$type === "Equality" && equality.expr.$type === "BinaryExpr") {
        expect(equality.expr.op).toBe(op);
      }
    }
  });

  test("rejects chained comparisons without parentheses", () => {
    expect(() => parse("foo(X) :- bar(X, Y, Z), X > Y > Z.")).toThrow();
  });

  test("function call in expression", () => {
    const program = parse("foo(N) :- bar(X), N = length(X).");
    const rule = program.statements[0] as Rule;
    const eq = rule.body[1]!;
    expect(eq.$type).toBe("Equality");
    if (eq.$type === "Equality") {
      expect(eq.expr.$type).toBe("FunctionCall");
      if (eq.expr.$type === "FunctionCall") {
        expect(eq.expr.name).toBe("length");
        expect(eq.expr.args).toHaveLength(1);
      }
    }
  });

  test("subscript expression", () => {
    const program = parse("foo(C) :- bar(X), C = X[0].");
    const rule = program.statements[0] as Rule;
    const eq = rule.body[1]!;
    if (eq.$type === "Equality") {
      expect(eq.expr.$type).toBe("Subscript");
    }
  });

  test("slice expression", () => {
    const program = parse("foo(S) :- bar(X), S = X[1:3].");
    const rule = program.statements[0] as Rule;
    const eq = rule.body[1]!;
    if (eq.$type === "Equality") {
      expect(eq.expr.$type).toBe("Slice");
      if (eq.expr.$type === "Slice") {
        expect(eq.expr.start).toMatchObject({ $type: "NumberLiteral", value: 1 });
        expect(eq.expr.end).toMatchObject({ $type: "NumberLiteral", value: 3 });
      }
    }
  });

  test("slice with omitted start", () => {
    const program = parse("foo(S) :- bar(X), S = X[:3].");
    const rule = program.statements[0] as Rule;
    const eq = rule.body[1]!;
    if (eq.$type === "Equality") {
      expect(eq.expr.$type).toBe("Slice");
      if (eq.expr.$type === "Slice") {
        expect(eq.expr.start).toBeUndefined();
        expect(eq.expr.end).toMatchObject({ $type: "NumberLiteral", value: 3 });
      }
    }
  });

  test("slice with omitted end", () => {
    const program = parse("foo(S) :- bar(X), S = X[1:].");
    const rule = program.statements[0] as Rule;
    const eq = rule.body[1]!;
    if (eq.$type === "Equality") {
      expect(eq.expr.$type).toBe("Slice");
      if (eq.expr.$type === "Slice") {
        expect(eq.expr.start).toMatchObject({ $type: "NumberLiteral", value: 1 });
        expect(eq.expr.end).toBeUndefined();
      }
    }
  });

  test("range atom with variable", () => {
    const program = parse("foo(X) :- X in [1 .. 10].");
    const rule = program.statements[0] as Rule;
    expect(rule.body).toHaveLength(1);
    const range = rule.body[0]!;
    expect(range.$type).toBe("RangeAtom");
    if (range.$type === "RangeAtom") {
      expect(range.expr).toMatchObject({ $type: "Variable", name: "X" });
      expect(range.low).toMatchObject({ $type: "NumberLiteral", value: 1 });
      expect(range.high).toMatchObject({ $type: "NumberLiteral", value: 10 });
    }
  });

  test("range atom with expression", () => {
    const program = parse("foo(X) :- bar(X, Y), Y + 1 in [0 .. 100].");
    const rule = program.statements[0] as Rule;
    expect(rule.body).toHaveLength(2);
    const range = rule.body[1]!;
    expect(range.$type).toBe("RangeAtom");
    if (range.$type === "RangeAtom") {
      expect(range.expr.$type).toBe("BinaryExpr");
    }
  });

  test("range atom with expression bounds", () => {
    const program = parse("foo(X) :- bar(X, Y), X in [Y .. Y + 10].");
    const rule = program.statements[0] as Rule;
    const range = rule.body[1]!;
    expect(range.$type).toBe("RangeAtom");
    if (range.$type === "RangeAtom") {
      expect(range.low).toMatchObject({ $type: "Variable", name: "Y" });
      expect(range.high.$type).toBe("BinaryExpr");
    }
  });

  test("range atom with function call expression", () => {
    const program = parse("foo(X) :- bar(X), length(X) in [1 .. 10].");
    const rule = program.statements[0] as Rule;
    const range = rule.body[1]!;
    expect(range.$type).toBe("RangeAtom");
    if (range.$type === "RangeAtom") {
      expect(range.expr.$type).toBe("FunctionCall");
    }
  });

  test("aggregate count in head", () => {
    const program = parse("cnt(X, count(Y)) :- bar(X, Y).");
    const rule = program.statements[0] as Rule;
    expect(rule.head.args[0]).toMatchObject({ $type: "Variable", name: "X" });
    const agg = rule.head.args[1] as unknown as AggregateCall;
    expect(agg.$type).toBe("AggregateCall");
    expect(agg.func).toBe("count");
    expect(agg.arg).toMatchObject({ $type: "Variable", name: "Y" });
  });

  test("aggregate sum in head", () => {
    const program = parse("total(X, sum(Y)) :- bar(X, Y).");
    const rule = program.statements[0] as Rule;
    const agg = rule.head.args[1] as unknown as AggregateCall;
    expect(agg.$type).toBe("AggregateCall");
    expect(agg.func).toBe("sum");
  });

  test("all aggregate functions", () => {
    const funcs: AggregateFunction[] = ["count", "sum", "avg", "min", "max", "concat", "list"];
    for (const func of funcs) {
      const program = parse(`r(X, ${func}(Y)) :- bar(X, Y).`);
      const rule = program.statements[0] as Rule;
      const agg = rule.head.args[1] as unknown as AggregateCall;
      expect(agg.$type).toBe("AggregateCall");
      expect(agg.func).toBe(func);
    }
  });

  test("aggregate with expression argument", () => {
    const program = parse("total(X, sum(Y * Z)) :- bar(X, Y, Z).");
    const rule = program.statements[0] as Rule;
    const agg = rule.head.args[1] as unknown as AggregateCall;
    expect(agg.func).toBe("sum");
    expect(agg.arg.$type).toBe("BinaryExpr");
  });

  test("count(*) parses with a Wildcard argument", () => {
    const program = parse("cnt(count(*)) :- bar(_).");
    const rule = program.statements[0] as Rule;
    const agg = rule.head.args[0] as AggregateCall;
    expect(agg.func).toBe("count");
    expect(agg.arg.$type).toBe("Wildcard");
  });

  test("aggregate names are not aggregates in body position", () => {
    const program = parse("foo(X) :- bar(X), X = min(X, 0).");
    const rule = program.statements[0] as Rule;
    const eq = rule.body[1]!;
    expect(eq.$type).toBe("Equality");
    if (eq.$type === "Equality") {
      expect(eq.expr.$type).toBe("FunctionCall");
      if (eq.expr.$type === "FunctionCall") {
        expect(eq.expr.name).toBe("min");
      }
    }
  });

  test("EOF parse error reports the end of the source, not NaN", () => {
    // Missing trailing period — Chevrotain's EOF token has NaN for
    // startLine/startColumn; parse() should fall back to end-of-source.
    let caught: ParseError | undefined;
    try {
      parse("r(1)");
    } catch (e) {
      caught = e as ParseError;
    }
    expect(caught).toBeDefined();
    expect(caught!).toBeInstanceOf(ParseError);
    expect(Number.isFinite(caught!.line)).toBe(true);
    expect(Number.isFinite(caught!.column)).toBe(true);
    expect(caught!.line).toBe(1);
    expect(caught!.column).toBe(5);
    expect(caught!.message).not.toMatch(/NaN/);
  });

  test("EOF error on a later line points to that line", () => {
    let caught: ParseError | undefined;
    try {
      parse("r(1).\nfoo(X)");
    } catch (e) {
      caught = e as ParseError;
    }
    expect(caught!.line).toBe(2);
    expect(caught!.column).toBe(7);
  });

  test("a parse error carries the source file when one is given", () => {
    // Source positions generalise to name their file (for the module system).
    const fileOf = (src: string, file?: string): string | undefined => {
      try {
        parse(src, file);
      } catch (e) {
        return (e as ParseError).file;
      }
      return "NO ERROR";
    };
    // Lexer/parser error and a post-process error (the `$`-namespace guard)
    // both carry the file; a file-less parse (a REPL chunk / stdin) leaves it
    // undefined.
    expect(fileOf("foo(X)", "prog.dl")).toBe("prog.dl");
    expect(fileOf("`$p`(1).", "prog.dl")).toBe("prog.dl");
    expect(fileOf("foo(X)")).toBeUndefined();
  });

  test("Regression: unsafe integer literals are rejected before JS rounds them", () => {
    // Langium's `NUMBER returns number` coercion turns this literal into
    // 9007199254740992 before downstream stages see it. Loaders already
    // reject integers outside the JS safe-integer window; source literals
    // need the same gate or the program evaluates a value the user never
    // wrote.
    let caught: unknown;
    try {
      parse("p(9007199254740993).");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ParseError);
    const pe = caught as ParseError;
    expect(pe.message).toContain("safe integer range");
    expect(pe.offset).toBe(2);
    expect(pe.end).toBe("p(9007199254740993".length);
  });

  test("Regression: non-finite numeric literals are rejected", () => {
    // A sufficiently long decimal literal overflows the JS Number that
    // Langium stores on the AST to Infinity. Letting that through leaks
    // non-finite values into native evaluation and SQL result decoding.
    const huge = `${"9".repeat(400)}.0`;
    expect(() => parse(`p(${huge}).`)).toThrow(/finite number range/);
  });

  test("slice with negative end parses", () => {
    // `W[0:-1]` used to hit a Subscript/Slice LL(k) ambiguity compounded
    // by the `:-` lexer keyword. Both are resolved now.
    const program = parse("r(S) :- w(W), S = W[0:-1].");
    const rule = program.statements[0] as Rule;
    const eq = rule.body[1]!;
    expect(eq.$type).toBe("Equality");
    if (eq.$type === "Equality") {
      expect(eq.expr.$type).toBe("Slice");
    }
  });

  test("slice with omitted start and negative end parses", () => {
    const program = parse("r(S) :- w(W), S = W[:-1].");
    const rule = program.statements[0] as Rule;
    const eq = rule.body[1]!;
    if (eq.$type === "Equality") {
      expect(eq.expr.$type).toBe("Slice");
    }
  });

  test("slice with negative start and negative end parses", () => {
    const program = parse("r(S) :- w(W), S = W[-3:-1].");
    const rule = program.statements[0] as Rule;
    const eq = rule.body[1]!;
    if (eq.$type === "Equality") {
      expect(eq.expr.$type).toBe("Slice");
    }
  });

  test("rejects empty bracket access W[]", () => {
    // The grammar allows `W[]` (both start and the `:` are optional),
    // but a Subscript with no index can't be translated. Post-processing
    // flags it explicitly.
    expect(() => parse("r(C) :- w(W), C = W[].")).toThrow(/Empty bracket access/);
  });

  test("Regression: empty bracket access error carries source position", () => {
    // The post-processor used to throw a bare `new Error("…")` for
    // `W[]`, with the byte offset only embedded in the message string.
    // The playground squiggly defaults to byte 0 unless the thrown
    // error is `instanceof ParseError` (or `AnalyzerError`) and exposes
    // numeric `offset` / `end` fields, so a malformed empty bracket
    // produced a squiggly at the start of the file rather than at the
    // `[]` token.
    // The CST node spans the whole `W[]` expression — receiver
    // included — so the squiggly can highlight the offending term as
    // a single unit rather than just the `[]` punctuation.
    const source = "r(C) :- w(W), C = W[].";
    const wStart = source.indexOf("W[]");
    const closingBracket = source.indexOf("]");
    let caught: unknown;
    try {
      parse(source);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ParseError);
    const pe = caught as ParseError;
    expect(pe.offset).toBe(wStart);
    expect(pe.end).toBe(closingBracket + 1);
  });

  describe("parseLenient", () => {
    test("returns a populated AST when the strict parser would throw on a partial statement", () => {
      // Strict `parse` blows up at the trailing comma — a typical
      // mid-edit state when the user is about to type another atom.
      // `parseLenient` should still surface the rule and the predicate
      // that has already been written so editor completions can offer
      // it back.
      expect(() => parse("r(X) :- p(X), q(X),")).toThrow(ParseError);
      const program = parseLenient("r(X) :- p(X), q(X),");
      // Chevrotain's error recovery leaves the rule head + at least one
      // body atom intact, which is what the completion collectors read.
      expect(program.statements.length).toBeGreaterThan(0);
      const rule = program.statements[0] as Rule;
      expect(rule.$type).toBe("Rule");
      expect(rule.head.predicate).toBe("r");
    });

    test("does not throw on malformed bracket access that post-processing rejects", () => {
      // `foo[]` is the kind of half-typed expression a user produces
      // when they reach for a subscript — strict parse would throw via
      // post-processing. `parseLenient` swallows the post-process
      // failure and returns whatever was already rewritten.
      expect(() => parse("r(X) :- p(X), X = foo[].")).toThrow();
      expect(() => parseLenient("r(X) :- p(X), X = foo[].")).not.toThrow();
    });
  });

  test("user-written _0 does not collide with auto-generated anon names", () => {
    // User-written `_0` is a valid but unusual variable name. It must remain
    // distinct from a source-level `_`, which is rewritten to an internal
    // anonymous name.
    const program = parse("r(_0) :- p(_, X).");
    const rule = program.statements[0] as Rule;
    const headName = (rule.head.args[0] as { name: string }).name;
    expect(headName).toBe("_0");
    const bodyLit = rule.body[0]!;
    if (bodyLit.$type === "Literal") {
      const firstArg = bodyLit.args[0] as { name: string };
      // The auto-generated anon should not equal the user's _0.
      expect(firstArg.name).not.toBe("_0");
      expect(firstArg.name).toMatch(/^\$anon\d+$/);
    }
  });
});

describe("bitwise / shift operators", () => {
  // The RHS expression of a body-level `X = <expr>` equality.
  function rhs(src: string): { $type: string; op?: string; left?: unknown; right?: unknown } {
    const program = parse(src);
    const rule = program.statements[0] as Rule;
    // biome-ignore lint/suspicious/noExplicitAny: test reaches into the Equality node
    return (rule.body[0] as any).expr;
  }

  test("bit-or binds looser than bit-and: A | B & C => A | (B & C)", () => {
    expect(rhs("r(X) :- X = A | B & C.")).toMatchObject({
      $type: "BinaryExpr",
      op: "|",
      left: { $type: "Variable", name: "A" },
      right: { $type: "BinaryExpr", op: "&" },
    });
  });

  test("equality binds tighter than bitwise-and: A & B <> C => A & (B <> C)", () => {
    expect(rhs("r(X) :- X = A & B <> C.")).toMatchObject({
      $type: "BinaryExpr",
      op: "&",
      right: { $type: "BinaryExpr", op: "<>" },
    });
  });

  test("shifts bind tighter than comparison: A << B < C => (A << B) < C", () => {
    expect(rhs("r(X) :- X = A << B < C.")).toMatchObject({
      $type: "BinaryExpr",
      op: "<",
      left: { $type: "BinaryExpr", op: "<<" },
      right: { $type: "Variable", name: "C" },
    });
  });

  test("additive binds tighter than shift: A + B << C => (A + B) << C", () => {
    expect(rhs("r(X) :- X = A + B << C.")).toMatchObject({
      $type: "BinaryExpr",
      op: "<<",
      left: { $type: "BinaryExpr", op: "+" },
    });
  });

  test(">>> lexes distinctly from >>, >=, and >", () => {
    expect(rhs("r(X) :- X = A >>> B.")).toMatchObject({ $type: "BinaryExpr", op: ">>>" });
    expect(rhs("r(X) :- X = A >> B.")).toMatchObject({ $type: "BinaryExpr", op: ">>" });
    expect(rhs("r(X) :- X = A >= B.")).toMatchObject({ $type: "BinaryExpr", op: ">=" });
    // `&&` / `||` still lex as the logical operators, not bitwise `&` / `|`.
    expect(rhs("r(X) :- X = A && B.")).toMatchObject({ $type: "BinaryExpr", op: "&&" });
  });
});

describe("exponentiation operator **", () => {
  function rhs(src: string): { $type: string; op?: string; left?: unknown; right?: unknown } {
    const program = parse(src);
    const rule = program.statements[0] as Rule;
    // biome-ignore lint/suspicious/noExplicitAny: test reaches into the Equality node
    return (rule.body[0] as any).expr;
  }

  test("** is right-associative: 2 ** 3 ** 2 => 2 ** (3 ** 2)", () => {
    expect(rhs("r(X) :- X = 2 ** 3 ** 2.")).toMatchObject({
      $type: "BinaryExpr",
      op: "**",
      left: { $type: "NumberLiteral", value: 2 },
      right: { $type: "BinaryExpr", op: "**" },
    });
  });

  test("** binds tighter than multiplication: 2 * 3 ** 2 => 2 * (3 ** 2)", () => {
    expect(rhs("r(X) :- X = 2 * 3 ** 2.")).toMatchObject({
      $type: "BinaryExpr",
      op: "*",
      right: { $type: "BinaryExpr", op: "**" },
    });
  });

  test("unary minus on the left binds tighter: -2 ** 2 => (-2) ** 2", () => {
    expect(rhs("r(X) :- X = -2 ** 2.")).toMatchObject({
      $type: "BinaryExpr",
      op: "**",
      left: { $type: "UnaryExpr", op: "-" },
    });
  });
});

describe("head argument names", () => {
  const headArgs = (src: string) => {
    const program = parse(src);
    const rule = program.statements[0] as unknown as { head: { args: { $type: string }[] } };
    return rule.head.args;
  };

  test("substitutes the name away, leaving an ordinary expression", () => {
    // No stage after parsing should see a name, so the second argument is a
    // BinaryExpr over a copy of the first, not a reference to it.
    const args = headArgs("p(1 as N, N + 1) :- q(_).");
    expect(args[0]!.$type).toBe("NumberLiteral");
    expect(args[1]!.$type).toBe("BinaryExpr");
    const right = args[1] as unknown as { left: { $type: string } };
    expect(right.left.$type).toBe("NumberLiteral");
  });

  test("each use gets its own copy rather than a shared node", () => {
    const args = headArgs("p(1 as N, N, N) :- q(_).");
    expect(args[1]).not.toBe(args[2]);
  });

  test("rejects a name that collides with a body variable", () => {
    expect(() => parse("p(1 as N) :- q(N).")).toThrow(/also a body variable/);
  });

  test("rejects a self-referential name", () => {
    expect(() => parse("p(N + 1 as N) :- q(_).")).toThrow(/refers to itself/);
  });

  test("rejects a cycle between two names", () => {
    expect(() => parse("p(Y + 1 as X, X + 1 as Y) :- q(_).")).toThrow(/refers to itself/);
  });

  test("rejects a duplicate name", () => {
    expect(() => parse("p(1 as N, 2 as N) :- q(_).")).toThrow(/Duplicate head argument name/);
  });

  test("a name composes with a type annotation", () => {
    const args = headArgs("p(1 as N: integer, N + 1) :- q(_).");
    expect(args[0]!.$type).toBe("NumberLiteral");
    expect(args[1]!.$type).toBe("BinaryExpr");
  });
});

describe("the conditional's `:` against the other five", () => {
  // `c ? a : b` adds a sixth meaning to `:`, beside head annotations, column
  // declarations, proof captures, slices and object entries.
  // functional-sublanguage.md originally rejected the ternary on the grounds that
  // this would collide; it does not, because a `?` commits the parse to the
  // matching `:` and every other use is reached only when no `?` opened one.
  // These pin that, since it is the reason the syntax is spellable at all.

  function bodyExpr(src: string) {
    const rule = parse(src).statements[0] as Rule;
    const eq = rule.body[rule.body.length - 1] as { expr: Record<string, unknown> };
    return eq.expr;
  }

  test("a conditional index is a subscript, not a slice", () => {
    const e = bodyExpr("q(X) :- s(W), X = W[A ? 1 : 2].") as {
      $type: string;
      index: { $type: string };
    };
    expect(e.$type).toBe("Subscript");
    expect(e.index.$type).toBe("Conditional");
  });

  test("a slice over a conditional start still slices", () => {
    // Three colons in one bracket: the conditional takes the first, the slice the
    // second. Reading it the other way would need the conditional to stop early.
    const e = bodyExpr("q(X) :- s(W), X = W[A ? 1 : 2 : 3].") as {
      $type: string;
      start: { $type: string };
      end: { $type: string };
    };
    expect(e.$type).toBe("Slice");
    expect(e.start.$type).toBe("Conditional");
    expect(e.end.$type).toBe("NumberLiteral");
  });

  test("a plain slice and a plain subscript are unaffected", () => {
    expect(bodyExpr("q(X) :- s(W), X = W[1:2].").$type).toBe("Slice");
    expect(bodyExpr("q(X) :- s(W), X = W[1].").$type).toBe("Subscript");
  });

  test("a head annotation applies to a conditional term", () => {
    const rule = parse("q((A ? 1 : 2): integer) :- p(A).").statements[0] as Rule;
    expect(rule.head.args[0]!.$type).toBe("Conditional");
    expect(rule.head.argTypes?.[0]).toMatchObject({ type: "integer" });
  });

  test("a refinement may hold a conditional", () => {
    expect(() => parse("q(X: integer, _: X > 0 ? true : false) :- p(X).")).not.toThrow();
  });

  test("an object entry's value may be a conditional", () => {
    expect(() => parse('q(X) :- p(A), X = {"k": A ? 1 : 2}.')).not.toThrow();
  });

  test("a proof capture is still a proof capture", () => {
    const rule = parse("p(1) :: C.\nq(V) :- V : p.").statements[1] as Rule;
    expect((rule.body[0] as Literal).predicate).toBe("p");
  });

  test("`if` and `else` are ordinary identifiers, the ternary needing no keyword", () => {
    expect(() => parse("input predicate p(if: integer, else: integer).")).not.toThrow();
    expect(() => parse("q(X) :- p(if, else), X = if.")).not.toThrow();
  });

  test("an annotation closes the term, so a conditional cannot follow it", () => {
    // The one shape that does not parse. Documented in spec §2.6 with the
    // rewrite, because the diagnostic alone does not suggest it.
    expect(() => parse("q(X: integer ? 1 : 2) :- p(X).")).toThrow();
  });
});
