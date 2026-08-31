declare module 'sql.js' {
  export type SqlJsValue = number | string | Uint8Array | null;

  export interface QueryExecResult {
    columns: string[];
    values: SqlJsValue[][];
  }

  export interface Statement {
    bind(values?: SqlJsValue[] | Record<string, SqlJsValue>): boolean;
    step(): boolean;
    getAsObject(params?: SqlJsValue[] | Record<string, SqlJsValue>): Record<string, SqlJsValue>;
    free(): boolean;
  }

  export interface Database {
    run(sql: string, params?: SqlJsValue[] | Record<string, SqlJsValue>): Database;
    exec(sql: string): QueryExecResult[];
    prepare(sql: string, params?: SqlJsValue[] | Record<string, SqlJsValue>): Statement;
    export(): Uint8Array;
    close(): void;
  }

  export interface SqlJsStatic {
    Database: new (data?: Uint8Array) => Database;
  }

  export default function initSqlJs(config?: {
    locateFile?: (file: string) => string;
  }): Promise<SqlJsStatic>;
}
