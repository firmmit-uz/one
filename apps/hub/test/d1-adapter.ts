// node:sqlite 기반 D1 최소 대체 (prepare/bind/first/all/run/batch/exec)
import { DatabaseSync } from 'node:sqlite';

type Param = string | number | bigint | null | Uint8Array;

const READ_RE = /^\s*(SELECT|WITH|PRAGMA|VALUES)\b/i;

function wrapError(e: unknown): Error {
  const msg = e instanceof Error ? e.message : String(e);
  return new Error(`D1_ERROR: ${msg}`, { cause: e });
}

function checkParams(params: unknown[]): Param[] {
  return params.map((p, i) => {
    if (p === undefined) throw new Error(`D1_TYPE_ERROR: Type 'undefined' not supported for value at index ${i}`);
    if (typeof p === 'boolean') throw new Error(`D1_TYPE_ERROR: boolean not supported at index ${i}`);
    if (p === null || typeof p === 'string' || typeof p === 'number' || typeof p === 'bigint' || p instanceof Uint8Array) return p;
    throw new Error(`D1_TYPE_ERROR: unsupported type at index ${i}`);
  });
}

export class FakeStatement {
  constructor(
    private readonly db: DatabaseSync,
    readonly sql: string,
    private readonly params: Param[] = [],
  ) {}

  bind(...params: unknown[]): FakeStatement {
    return new FakeStatement(this.db, this.sql, checkParams(params));
  }

  execute(): { results: Record<string, unknown>[]; meta: { changes: number; last_row_id: number; duration: number } } {
    try {
      const stmt = this.db.prepare(this.sql);
      const returnsRows = READ_RE.test(this.sql) || /\bRETURNING\b/i.test(this.sql);
      if (returnsRows) {
        const rows = stmt.all(...this.params) as Record<string, unknown>[];
        return { results: rows.map((r) => ({ ...r })), meta: { changes: 0, last_row_id: 0, duration: 0 } };
      }
      const info = stmt.run(...this.params);
      return {
        results: [],
        meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid), duration: 0 },
      };
    } catch (e) {
      throw wrapError(e);
    }
  }

  async first<T = Record<string, unknown>>(col?: string): Promise<T | null> {
    const row = this.execute().results[0];
    if (!row) return null;
    if (col !== undefined) {
      if (!(col in row)) throw new Error(`D1_COLUMN_NOTFOUND: ${col}`);
      return row[col] as T;
    }
    return row as T;
  }

  async all<T = Record<string, unknown>>() {
    const r = this.execute();
    return { results: r.results as T[], success: true as const, meta: r.meta };
  }

  async run() {
    const r = this.execute();
    return { results: r.results, success: true as const, meta: r.meta };
  }

  async raw<T = unknown[]>(): Promise<T[]> {
    return this.execute().results.map((r) => Object.values(r)) as T[];
  }
}

export class FakeD1 {
  /** 시험용: 실행된 SQL 기록 */
  readonly log: string[] = [];
  /** 시험용: 다음 batch 직전에 한 번 실행할 훅 */
  beforeBatch: (() => void) | null = null;

  constructor(readonly sqlite: DatabaseSync) {}

  prepare(sql: string): FakeStatement {
    this.log.push(sql);
    return new FakeStatement(this.sqlite, sql);
  }

  async batch(stmts: FakeStatement[]) {
    const hook = this.beforeBatch;
    this.beforeBatch = null;
    hook?.();
    this.sqlite.exec('BEGIN');
    try {
      const out = stmts.map((s) => {
        const r = s.execute();
        return { results: r.results, success: true as const, meta: r.meta };
      });
      this.sqlite.exec('COMMIT');
      return out;
    } catch (e) {
      this.sqlite.exec('ROLLBACK');
      throw e;
    }
  }

  async exec(sql: string) {
    try {
      this.sqlite.exec(sql);
    } catch (e) {
      throw wrapError(e);
    }
    return { count: 1, duration: 0 };
  }
}
