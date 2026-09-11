/** Lower proven JSON scalar operands onto existing backend extraction operations. */
import type { AnalyzedProgram } from "./analyzer.ts";
import type { BodyElement, FunctionCall, HeadTerm, PrimitiveType } from "./ast.ts";
import { EQUALITY_OPS, ORDERING_OPS } from "./ast.ts";
import { resolveCall } from "./builtins.ts";
import { constrainSemanticVariable } from "./semantic-constraints.ts";
import { inferSemanticExpression } from "./semantic-expressions.ts";
import { type SemanticType, fromPrimitiveType, unionType } from "./semantic-type.ts";
import { type TypedProgram, inferTermType, rebuildVarTypes } from "./types.ts";

const implicitOperands = new WeakMap<object, HeadTerm>();

/** Re-analysis must re-prove conversions, especially after REPL rules widen a type. */
export function restoreTypedOperands(program: AnalyzedProgram): void {
  const visit = (value: unknown): unknown => {
    if (!value || typeof value !== "object") return value;
    const original = implicitOperands.get(value);
    if (original) {
      const wrapper = value as FunctionCall;
      const node = original as unknown as Record<string, unknown>;
      for (const key of ["$container", "$containerProperty", "$containerIndex"]) {
        node[key] = (wrapper as unknown as Record<string, unknown>)[key];
      }
      return visit(original);
    }
    if (Array.isArray(value)) {
      value.forEach((item, i) => {
        value[i] = visit(item);
      });
      return value;
    }
    const node = value as Record<string, unknown>;
    if (typeof node.$type !== "string") return value;
    for (const key of Object.keys(node)) if (!key.startsWith("$")) node[key] = visit(node[key]);
    return value;
  };
  for (const rules of program.rules.values()) rules.forEach(visit);
  program.queries.forEach(visit);
  program.constraints.forEach(visit);
}

/** Mutates expression slots only; leaves predicate bindings and JSON storage intact. */
export function lowerTypedOperands(program: TypedProgram): boolean {
  let changed = false;
  const lower = (body: BodyElement[], heads: HeadTerm[] = [], owner?: string) => {
    const storage = new Map(program.publishedTypes);
    if (owner) storage.set(owner, program.columnTypes.get(owner)!);
    const legacy = rebuildVarTypes(body, storage);
    const vars = new Map<string, SemanticType>();
    const nonNull = program.nullness.nonNullVars.get(body) ?? new Set<string>();
    for (const element of body) {
      if (element.$type !== "Literal" || element.negated) continue;
      const columns =
        element.predicate === owner
          ? program.semanticColumnTypes
          : program.publishedSemanticColumnTypes;
      for (const [i, arg] of element.args.entries()) {
        if (arg.$type !== "Variable") continue;
        const type = columns.get(element.predicate)?.[i];
        if (type) constrainSemanticVariable(vars, arg.name, type);
      }
    }
    const infer = (term: HeadTerm): SemanticType | undefined =>
      inferSemanticExpression(term, {
        variable: (name) => vars.get(name),
        primitive: (expr) => inferTermType(expr, legacy, storage),
        payload: (id, name) =>
          (id.predicate === owner ? program.proofTypes : program.publishedProofTypes).payload(
            id,
            name,
          ),
        fallback: (expr) => {
          const type = inferTermType(expr, legacy, storage);
          return type ? fromPrimitiveType(type) : undefined;
        },
      });
    for (let pass = 0; pass <= body.length; pass++) {
      let learned = false;
      for (const element of body) {
        if (element.$type !== "Equality") continue;
        for (const [target, source] of [
          [element.left, element.expr],
          [element.expr, element.left],
        ]) {
          if (target!.$type !== "Variable") continue;
          const type = infer(source!);
          if (type) learned = constrainSemanticVariable(vars, target!.name, type) || learned;
        }
      }
      if (!learned) break;
    }
    const scalar = (term: HeadTerm): PrimitiveType | undefined => {
      let type = infer(term);
      if (term.$type === "Variable" && nonNull.has(term.name) && type?.kind === "union") {
        type = unionType(...type.members.filter((t) => t.kind !== "scalar" || t.name !== "null"));
      }
      return type?.kind === "scalar" && type.name !== "null" ? type.name : undefined;
    };
    const extract = (term: HeadTerm): HeadTerm => {
      // Existing primitive operands and explicit conversions already have the
      // backend representation they need. Nullable/unknown shapes do not justify
      // an implicit conversion, which would otherwise silently drop null values.
      if (inferTermType(term, legacy, storage) !== "value") return term;
      const type = scalar(term);
      if (!type) return term;
      changed = true;
      const call = {
        $type: "FunctionCall",
        name: `as_${type}`,
        args: [term],
        $cstNode: term.$cstNode,
        $container: term.$container,
      } as unknown as FunctionCall;
      implicitOperands.set(call, term);
      const node = term as unknown as Record<string, unknown>;
      const wrapper = call as unknown as Record<string, unknown>;
      wrapper.$containerProperty = node.$containerProperty;
      wrapper.$containerIndex = node.$containerIndex;
      node.$container = call;
      node.$containerProperty = "args";
      node.$containerIndex = 0;
      return call;
    };
    const visit = (term: HeadTerm): HeadTerm => {
      // The postprocessed AST has a wider expression union than generated
      // parser slots. Assign through local slots to preserve the existing nodes
      // (and therefore proof metadata), replacing only scalar operand positions.
      const slots = term as unknown as Record<string, HeadTerm | HeadTerm[]>;
      const one = (key: string, convert = false) => {
        const value = visit(slots[key] as HeadTerm);
        slots[key] = convert ? extract(value) : value;
      };
      switch (term.$type) {
        case "BinaryExpr": {
          const compute = !EQUALITY_OPS.has(term.op) && !ORDERING_OPS.has(term.op);
          one("left", compute);
          one("right", compute);
          break;
        }
        case "UnaryExpr":
          one("operand", true);
          break;
        case "FunctionCall": {
          term.args.forEach((arg, i) => {
            (slots.args as HeadTerm[])[i] = visit(arg);
          });
          const overload = resolveCall(
            term.name,
            term.args.map((arg) => scalar(arg) ?? inferTermType(arg, legacy, storage)),
          ).overload;
          if (overload)
            term.args.forEach((arg, i) => {
              if (overload.params[i] !== "value") (slots.args as HeadTerm[])[i] = extract(arg);
            });
          break;
        }
        case "AggregateCall":
          one("arg", term.func === "sum" || term.func === "avg" || term.func === "concat");
          break;
        case "Subscript":
          one("object", scalar(term.object) === "string");
          one("index");
          break;
        case "Slice":
          one("object", scalar(term.object) === "string");
          if (term.start) one("start");
          if (term.end) one("end");
          break;
        case "Conditional":
          one("cond", true);
          one("consequent");
          one("alternate");
          break;
        case "ArrayLiteral":
          term.elements.forEach((arg, i) => {
            (slots.elements as HeadTerm[])[i] = visit(arg);
          });
          break;
        case "ObjectLiteral":
          for (const entry of term.entries)
            (entry as unknown as { value: HeadTerm }).value = visit(entry.value);
          break;
      }
      return term;
    };
    heads.forEach((term, i) => {
      heads[i] = visit(term);
    });
    for (const element of body) {
      const slots = element as unknown as Record<string, HeadTerm | HeadTerm[]>;
      if (element.$type === "Equality") {
        slots.left = visit(element.left);
        slots.expr = visit(element.expr);
      } else if (element.$type === "Filter") slots.expr = visit(element.expr);
      else if (element.$type === "Literal")
        element.args.forEach((arg, i) => {
          (slots.args as HeadTerm[])[i] = visit(arg);
        });
      else if (element.$type === "RangeAtom") {
        slots.low = extract(visit(element.low));
        slots.high = extract(visit(element.high));
        slots.expr = visit(element.expr);
      }
    }
  };
  for (const [predicate, rules] of program.rules)
    for (const rule of rules) lower(rule.body, rule.head.args, predicate);
  for (const query of [...program.queries, ...program.constraints]) lower(query.body);
  return changed;
}
