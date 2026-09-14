import {
  AGGREGATE_FUNCTION_NAMES,
  BUILTIN_BODY_ATOM_NAMES,
  BUILTIN_FUNCTION_NAMES,
  type PredicateInfo,
  collectProofTypeNames,
  collectTypeAliases,
  collectUserPredicates,
  collectVariablesInRule,
  findEnclosingRule,
} from "datamog-core";
import type { Program } from "datamog-parser";
import { AstUtils, GrammarAST } from "langium";
import {
  type CompletionAcceptor,
  type CompletionContext,
  DefaultCompletionProvider,
} from "langium/lsp";
import { CompletionItemKind } from "vscode-languageserver";

/**
 * Extends Langium's default keyword + cross-reference completion with
 * Datamog-specific identifier suggestions. The default provider only
 * proposes grammar keywords (`extensional`, `not`, `string`, …) and
 * cross-reference targets — Datamog has no cross-references, so
 * predicate names, built-in function names, and in-scope variables
 * would otherwise never surface.
 *
 * The dispatch keys on the Langium grammar feature the parser expects
 * next:
 *   - `Identifier` parser rule (called from Literal/HeadAtom/ExtDecl
 *      predicates, ColumnDecl names, *and* Variable.name in expression
 *      position) → predicate names and, when inside a rule body, the
 *      in-scope variable names too. The grammar no longer distinguishes
 *      predicates from variables at the terminal level — case is just a
 *      style convention — so we can't know which kind the user is about
 *      to type until they type it. Over-proposing is harmless: the two
 *      groups have distinct `kind` / `sortText`, and fuzzy filtering
 *      narrows by what's typed.
 *   - `name=IDENT` directly under FunctionCall (covers aggregate calls
 *      in heads, since they share the FunctionCall parse shape and are
 *      split apart only by post-processing) → built-in functions +
 *      aggregates.
 *
 * Keyword and column-type completion comes for free from `super`.
 */
export class DatamogCompletionProvider extends DefaultCompletionProvider {
  protected override async completionFor(
    context: CompletionContext,
    next: Parameters<DefaultCompletionProvider["completionFor"]>[1],
    acceptor: CompletionAcceptor,
  ): Promise<void> {
    // Keep the default keyword + cross-reference behaviour intact.
    await super.completionFor(context, next, acceptor);

    // Langium flattens parser-rule references when computing next
    // features — so the leaf RuleCall for `predicate=Identifier` ends
    // up as a TerminalRuleCall to IDENT *inside* the `Identifier`
    // parser rule, not the outer Assignment in Literal/HeadAtom/ExtDecl.
    // That's why we key on the enclosing ParserRule (always reachable
    // via the $container chain) plus the terminal's name, rather than
    // the consuming Assignment.
    if (!GrammarAST.isRuleCall(next.feature)) return;
    const ruleName = next.feature.rule?.ref?.name;
    if (!ruleName) return;
    const parserRule = AstUtils.getContainerOfType(next.feature, GrammarAST.isParserRule);
    const parserRuleName = parserRule?.name;
    const program = context.document.parseResult.value as Program;

    // Inside the `Identifier` parser rule → could be a predicate name,
    // a variable, or a column name (we can't tell which the user is
    // typing until they finish — see the class docstring). Propose
    // predicates always, and in-scope variables additionally when the
    // cursor sits inside a rule. Column-name positions get over-proposed
    // identifiers too; fuzzy filtering on what the user types narrows
    // down to the relevant set.
    if (parserRuleName === "Identifier") {
      for (const name of collectTypeAliases(program)) {
        acceptor(context, {
          label: name,
          kind: CompletionItemKind.TypeParameter,
          detail: "type alias",
          sortText: `1_${name}`,
        });
      }
      for (const name of collectProofTypeNames(program))
        acceptor(context, {
          label: name,
          kind: CompletionItemKind.TypeParameter,
          detail: "nominal proof type",
          sortText: `1_${name}`,
        });
      this.proposePredicates(context, program, acceptor);
      this.proposeVariables(context, program, acceptor);
      return;
    }
    // `name=IDENT` inside FunctionCall → built-in / aggregate names.
    if (parserRuleName === "FunctionCall" && ruleName === "IDENT") {
      this.proposeFunctions(context, acceptor);
      return;
    }
  }

  private proposePredicates(
    context: CompletionContext,
    program: Program,
    acceptor: CompletionAcceptor,
  ): void {
    for (const pi of collectUserPredicates(program)) {
      acceptor(context, {
        label: pi.name,
        kind: pi.kind === "extensional" ? CompletionItemKind.Struct : CompletionItemKind.Function,
        detail: predicateDetail(pi),
        sortText: `1_${pi.name}`,
      });
    }
    for (const name of BUILTIN_BODY_ATOM_NAMES) {
      acceptor(context, {
        label: name,
        kind: CompletionItemKind.Method,
        detail: "built-in iteration atom",
        sortText: `2_${name}`,
      });
    }
  }

  private proposeFunctions(context: CompletionContext, acceptor: CompletionAcceptor): void {
    for (const name of BUILTIN_FUNCTION_NAMES) {
      acceptor(context, {
        label: name,
        kind: CompletionItemKind.Function,
        detail: "built-in function",
        sortText: `1_${name}`,
      });
    }
    for (const name of AGGREGATE_FUNCTION_NAMES) {
      acceptor(context, {
        label: name,
        kind: CompletionItemKind.Function,
        detail: "aggregate",
        sortText: `1_${name}`,
      });
    }
  }

  private proposeVariables(
    context: CompletionContext,
    program: Program,
    acceptor: CompletionAcceptor,
  ): void {
    const rule = findEnclosingRule(program, context.offset);
    if (!rule) return;
    for (const v of collectVariablesInRule(rule)) {
      acceptor(context, {
        label: v,
        kind: CompletionItemKind.Variable,
        sortText: `0_${v}`,
      });
    }
  }
}

function predicateDetail(pi: PredicateInfo): string {
  if (pi.kind === "extensional") {
    return pi.columns ? `input(${pi.columns.join(", ")})` : `input/${pi.arity}`;
  }
  return `rule/${pi.arity}`;
}
