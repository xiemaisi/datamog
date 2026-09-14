import { describe, expect, test } from "bun:test";
import { create as native } from "datamog-backend-native";
import { create as postgres } from "datamog-backend-postgres";
import { create as seminaive } from "datamog-backend-seminaive";
import { create as sqlite } from "datamog-backend-sqlite";
import { create as sqljs } from "datamog-backend-sqljs";
import { type Backend, DatamogExecutor, IncrementalSession } from "datamog-engine";

const engines: [string, () => Promise<Backend>][] = Object.entries({
  native,
  seminaive,
  sqlite,
  sqljs,
});
if (process.env.DATABASE_URL)
  engines.push([
    "postgres",
    async () => {
      const sql = new Bun.SQL(
        process.env.DATAMOG_EXAMPLES_DATABASE_URL ?? process.env.DATABASE_URL!,
        { max: 1 },
      );
      const schema = `incremental_proofs_${crypto.randomUUID().replaceAll("-", "")}`;
      await sql.unsafe(`CREATE SCHEMA ${schema}`);
      await sql.unsafe(`SET search_path TO ${schema}`);
      const backend = await postgres(sql);
      return {
        ...backend,
        async close() {
          try {
            await sql.unsafe(`DROP SCHEMA ${schema} CASCADE`);
          } finally {
            await backend.close();
          }
        },
      };
    },
  ]);

for (const [name, create] of engines) {
  describe(`${name}: incremental proofs`, () => {
    test("recursive proofs, nominal aliases and nested patterns agree with whole-program execution", async () => {
      const backend = await create();
      const whole = await create();
      try {
        const session = new IncrementalSession(backend);
        const chunks = [
          "nat(0) :: Zero(). nat(N+1) :: Succ(P:nat) :- P:nat(N), N<2.",
          "type N = nat.",
          "wrap() :: W(P:N) :- P:nat.",
          "grab(T:N) :- W:wrap, W=wrap::W(T), T<>null.",
        ];
        for (const chunk of chunks) await session.addStatements(chunk);
        const query = "?- P:wrap, P=wrap::W(nat::Succ(nat::Zero())).";
        const actual = await session.addStatements(query);
        const expected = await new DatamogExecutor(whole).execute(chunks.join("\n") + query);
        expect(actual.queries[0]!.rows).toEqual(expected[0]!.rows);
        expect(actual.queries[0]!.rows).toHaveLength(1);
        expect((await session.addStatements("?- grab(T).")).queries[0]!.rows).toHaveLength(3);
        if (backend.sqlDialect) expect(session.peekSql(query)).toContain("SELECT");
        expect((await session.addStatements(query)).queries[0]!.rows).toEqual(
          actual.queries[0]!.rows,
        );
      } finally {
        await backend.close();
        await whole.close();
      }
    });

    test("implicit subproof payloads and quoted producers retain published scalar contracts", async () => {
      const backend = await create();
      try {
        const session = new IncrementalSession(backend);
        await session.addStatements("`some-kind`(1) :: Tag(7:float).");
        await session.addStatements("q() :: Q :- P:`some-kind`(_).");
        await session.addStatements("answer(X/2) :- W:q, W=Q(`some-kind`::Tag(X)).");
        const result = await session.addStatements("?- answer(N).");
        expect(result.queries[0]!.rows).toEqual([{ N: 3.5 }]);
        await expect(session.addStatements("`some-kind`(2) :: New.")).rejects.toThrow(
          "earlier chunk",
        );
        const rules = session.accumulatedStatements.filter((s) => s.$type === "Rule");
        expect(rules.map((r) => r.head.args.length)).toEqual([2, 1, 1]);
      } finally {
        await backend.close();
      }
    });

    test("ambiguity, arity errors and rejected chunks leave prior proof context usable", async () => {
      const backend = await create();
      try {
        const session = new IncrementalSession(backend);
        await session.addStatements("a() :: C.");
        await expect(session.addStatements("a() :: D.")).rejects.toThrow("earlier chunk");
        await session.addStatements("b() :: C.");
        await expect(session.addStatements("?- P=C().")).rejects.toThrow("ambiguous");
        await expect(session.addStatements("?- P=a::C(1).")).rejects.toThrow();
        await expect(session.addStatements("bad() :: Bad(1:string).")).rejects.toThrow("payload 1");
        await expect(session.addStatements("?- P:bad.")).rejects.toThrow("no named rules");
        await expect(session.addStatements("bad() :: Bad(P:b) :- P:a.")).rejects.toThrow(
          "expected proof of 'b'",
        );
        await session.addStatements("bad() :: Bad(P:a) :- P:a.");
        expect(
          (await session.addStatements("?- P:bad, P=Bad(a::C()).")).queries[0]!.rows,
        ).toHaveLength(1);
      } finally {
        await backend.close();
      }
    });
  });
}
