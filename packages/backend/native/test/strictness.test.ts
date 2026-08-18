// A property test over the whole builtin registry: every `nulls.strict` bit
// must match what the builtin actually does with a null argument.
//
// The bit is not documentation. `strictVars` in `core/src/nullness.ts` reads it
// as "this call has a value and it is not null, therefore every argument was
// non-null", and the translator turns that conclusion into a plain SQL `=`
// instead of a null-aware one. A builtin marked strict that answers *about* a
// null instead of propagating it makes that inference false, which silently
// drops null-to-null matches on every SQL backend, bypasses the nullable-operand
// rejection, and hands `--verify` a contract the run rejects.
//
// Only a `value` parameter can receive a null in practice, since Position 3
// rejects a nullable primitive operand statically, so that is where the bit has
// teeth and where the test looks.

import { describe, expect, test } from "bun:test";
import { type TypeEnv, type Value, evalTerm } from "datamog-backend-native";
import { BUILTINS } from "datamog-core";
import type { HeadTerm, PrimitiveType } from "datamog-core";

const env: TypeEnv = { vars: new Map(), columns: new Map(), functionOverloads: new Map() };

function call(name: string, args: HeadTerm[]): HeadTerm {
  return { $type: "FunctionCall", name, args } as unknown as HeadTerm;
}
function nullLit(): HeadTerm {
  return { $type: "NullLiteral" } as unknown as HeadTerm;
}

/** A defined, in-domain argument for a slot we are not probing. */
function sampleFor(type: PrimitiveType): HeadTerm {
  switch (type) {
    case "integer":
      return { $type: "NumberLiteral", value: 2, rawText: "2" } as unknown as HeadTerm;
    case "float":
      return { $type: "NumberLiteral", value: 2.5, rawText: "2.5" } as unknown as HeadTerm;
    case "boolean":
      return { $type: "BooleanLiteral", value: true } as unknown as HeadTerm;
    // A key that a probed receiver plausibly has, and a parseable string.
    default:
      return { $type: "StringLiteral", value: "k" } as unknown as HeadTerm;
  }
}

/** Every (builtin, overload, `value`-parameter index) triple in the registry. */
const valueSlots: { name: string; key: string; index: number; strict: boolean }[] = [];
for (const builtin of BUILTINS.values()) {
  for (const overload of builtin.overloads) {
    overload.params.forEach((param, index) => {
      if (param !== "value") return;
      valueSlots.push({
        name: builtin.name,
        key: overload.key,
        index,
        strict: overload.nulls.strict,
      });
    });
  }
}

describe("nulls.strict matches runtime behaviour at a `value` parameter", () => {
  test("the registry has value-parameter overloads to check", () => {
    // Guards against the loop above silently finding nothing if the registry
    // shape changes, which would make every test below vacuously pass.
    expect(valueSlots.length).toBeGreaterThan(5);
  });

  for (const slot of valueSlots) {
    const label = `${slot.key} arg ${slot.index} (strict: ${slot.strict})`;
    test(label, () => {
      const overload = [...BUILTINS.values()]
        .flatMap((b) => b.overloads)
        .find((o) => o.key === slot.key);
      if (overload === undefined) throw new Error(`no overload ${slot.key}`);

      const args = overload.params.map((param, i) =>
        i === slot.index ? nullLit() : sampleFor(param),
      );
      const result: Value | undefined = evalTerm(call(slot.name, args), new Map(), env);

      if (slot.strict) {
        // Strict: a null in, so a null or no value out. Anything else is a
        // value derived from a null, which is what the bit promises cannot
        // happen and what refinement relies on.
        expect(result === null || result === undefined).toBe(true);
      } else {
        // Non-strict is the claim that it answers for a null, so it must
        // produce something that is neither. A bit set to `false` where the
        // builtin does propagate is merely imprecise, but it is also always
        // wrong about this call, so pin it.
        expect(result === null || result === undefined).toBe(false);
      }
    });
  }
});
