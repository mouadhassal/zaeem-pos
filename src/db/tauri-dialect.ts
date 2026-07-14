import type Database from "@tauri-apps/plugin-sql";
import {
  type Dialect,
  type Driver,
  type DatabaseConnection,
  type QueryResult,
  CompiledQuery,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
  type Kysely,
} from "kysely";

class TauriSqliteConnection implements DatabaseConnection {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  async executeQuery<R>(compiledQuery: CompiledQuery): Promise<QueryResult<R>> {
    const { sql, parameters, query } = compiledQuery;
    const kind = (query as any)?.kind;

    if (kind === "SelectQueryNode" || kind === "RawNode" && sql.trim().toLowerCase().startsWith("select")) {
      const rows = await this.#db.select<R>(sql, parameters as any[]) as R[];
      return { rows };
    }

    const params = parameters as any[];
    const result = await this.#db.execute(sql, params);
    const numAffectedRows = result.rowsAffected != null ? BigInt(result.rowsAffected) : undefined;
    const insertId: bigint | undefined = result.lastInsertId != null ? BigInt(result.lastInsertId) : undefined;

    return {
      rows: [],
      numAffectedRows,
      insertId,
    } as unknown as QueryResult<R>;
  }

  async *streamQuery<R>(_compiledQuery: CompiledQuery, _chunkSize?: number): AsyncIterableIterator<QueryResult<R>> {
    throw new Error("TauriSqliteConnection does not support streaming");
  }
}

class TauriSqliteDriver implements Driver {
  readonly #db: Database;
  #connection: TauriSqliteConnection | null = null;

  constructor(db: Database) {
    this.#db = db;
  }

  async init(): Promise<void> {
    this.#connection = new TauriSqliteConnection(this.#db);
  }

  async acquireConnection(): Promise<DatabaseConnection> {
    return this.#connection!;
  }

  async beginTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw("begin"));
  }

  async commitTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw("commit"));
  }

  async rollbackTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw("rollback"));
  }

  async releaseConnection(): Promise<void> {
    // no-op: single connection
  }

  async destroy(): Promise<void> {
    await (this.#db as any).close?.();
  }
}

export class TauriSqliteDialect implements Dialect {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  createDriver(): Driver {
    return new TauriSqliteDriver(this.#db);
  }

  createQueryCompiler() {
    return new SqliteQueryCompiler();
  }

  createAdapter() {
    return new SqliteAdapter();
  }

  createIntrospector(db: Kysely<unknown>) {
    return new SqliteIntrospector(db);
  }
}
