import type { ExtDecl } from "datamog-core";
import type { Backend, ExtensionalLoader, LoadResult } from "datamog-engine";
import { type DirectoryLoader, createDirectoryLoader } from "datamog-engine/directory-loader";
import { type ParseParquetOptions, parseParquetContent } from "./parse-content.ts";

export type { ParseParquetOptions };
export { parseParquetContent };

export interface ParquetLoaderOptions {
  directory: string;
}

export class ParquetLoader implements ExtensionalLoader {
  readonly name = "parquet";
  private readonly inner: DirectoryLoader;

  constructor(options: ParquetLoaderOptions) {
    this.inner = createDirectoryLoader({
      name: "parquet",
      extension: ".parquet",
      directory: options.directory,
      parseBinary: (buffer, decl) => parseParquetContent(buffer, decl),
    });
  }

  canLoad(decl: ExtDecl): Promise<boolean> {
    return this.inner.canLoad(decl);
  }

  load(decl: ExtDecl, backend: Backend): Promise<LoadResult> {
    return this.inner.load(decl, backend);
  }

  /** Read and parse the Parquet file into typed rows. Exposed for testing. */
  readRows(decl: ExtDecl): Promise<Record<string, unknown>[]> {
    return this.inner.readRows(decl);
  }
}
