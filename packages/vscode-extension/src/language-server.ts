import {
  DatamogGeneratedModule,
  DatamogGeneratedSharedModule,
  DatamogLanguageMetaData,
} from "datamog-parser";
import { type Module, inject } from "langium";
import type { LangiumServices, PartialLangiumServices } from "langium/lsp";
import { createDefaultModule, createDefaultSharedModule, startLanguageServer } from "langium/lsp";
import { NodeFileSystem } from "langium/node";
import { ProposedFeatures, createConnection } from "vscode-languageserver/node.js";
import { DatamogCompletionProvider } from "./datamog-completion-provider.js";
import { DatamogDefinitionProvider } from "./datamog-definition-provider.js";
import { registerValidationChecks } from "./datamog-validator.js";

const connection = createConnection(ProposedFeatures.all);

const shared = inject(
  createDefaultSharedModule({ ...NodeFileSystem, connection }),
  DatamogGeneratedSharedModule,
);

const DatamogModule: Module<LangiumServices, PartialLangiumServices> = {
  // Same rationale as datamog-parser's DatamogModule: skip Chevrotain's
  // grammar self-analysis so the by-design BodyElement ambiguities
  // don't emit warnings on every LSP start-up.
  LanguageMetaData: () => ({ ...DatamogLanguageMetaData, mode: "production" }),
  validation: {},
  lsp: {
    CompletionProvider: (services) => new DatamogCompletionProvider(services),
    // The default provider resolves grammar cross-references; Datamog has
    // none, so navigation is computed from the AST instead.
    DefinitionProvider: () => new DatamogDefinitionProvider(),
  },
};

const Datamog = inject(createDefaultModule({ shared }), DatamogGeneratedModule, DatamogModule);

shared.ServiceRegistry.register(Datamog);
registerValidationChecks(Datamog.validation.ValidationRegistry);
startLanguageServer(shared);
