/** Per-operation limits for exact semantic type operations, separate from widening. */
export interface SemanticTypeWorkOptions {
  readonly maxWork?: number;
}

export class SemanticTypeLimitError extends Error {
  constructor(reason: string) {
    super(`Semantic type ${reason} limit exceeded`);
    this.name = "SemanticTypeLimitError";
  }
}

/** Charge traversals, allocations and key text before doing potentially large work. */
export class SemanticTypeWork {
  readonly keys = new WeakMap<object, string>();
  private remaining: number;

  constructor(options: SemanticTypeWorkOptions = {}) {
    this.remaining = options.maxWork ?? 1_000_000;
    if (!Number.isSafeInteger(this.remaining) || this.remaining < 0)
      throw new Error("Semantic type work limit must be a nonnegative safe integer");
  }

  spend(units = 1): void {
    this.remaining -= units;
    if (this.remaining < 0) throw new SemanticTypeLimitError("work");
  }

  visit(depth: number): void {
    this.spend();
    if (depth > 256) throw new SemanticTypeLimitError("nesting");
  }
}
