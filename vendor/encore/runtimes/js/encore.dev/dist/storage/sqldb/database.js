import { getCurrentRequest } from "../../internal/reqtrack/mod.js";
import * as runtime from "../../internal/runtime/mod.js";
const driverName = "node-pg";
/** Base class containing shared query functionality */
class BaseQueryExecutor {
    impl;
    constructor(impl) {
        this.impl = impl;
    }
    /**
     * query queries the database using a template string, replacing your placeholders in the template
     * with parametrised values without risking SQL injections.
     *
     * It returns an async generator, that allows iterating over the results
     * in a streaming fashion using `for await`.
     *
     * @example
     *
     * const email = "foo@example.com";
     * const result = database.query`SELECT id FROM users WHERE email=${email}`
     *
     * This produces the query: "SELECT id FROM users WHERE email=$1".
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async *query(strings, ...params) {
        const query = buildQuery(strings, params);
        const args = buildQueryArgs(params);
        const source = getCurrentRequest();
        const cursor = await this.impl.query(query, args, source);
        while (true) {
            const row = await cursor.next();
            if (row === null)
                break;
            yield row.values();
        }
    }
    /**
     * rawQuery queries the database using a raw parametrised SQL query and parameters.
     *
     * It returns an async generator, that allows iterating over the results
     * in a streaming fashion using `for await`.
     *
     * @example
     * const query = "SELECT id FROM users WHERE email=$1";
     * const email = "foo@example.com";
     * for await (const row of database.rawQuery(query, email)) {
     *   console.log(row);
     * }
     *
     * @param query - The raw SQL query string.
     * @param params - The parameters to be used in the query.
     * @returns An async generator that yields rows from the query result.
     */
    async *rawQuery(query, ...params) {
        const args = buildQueryArgs(params);
        const source = getCurrentRequest();
        const result = await this.impl.query(query, args, source);
        while (true) {
            const row = await result.next();
            if (row === null)
                break;
            yield row.values();
        }
    }
    /**
     * queryAll queries the database using a template string, replacing your placeholders in the template
     * with parametrised values without risking SQL injections.
     *
     * It returns an array of all results.
     *
     * @example
     *
     * const email = "foo@example.com";
     * const result = database.queryAll`SELECT id FROM users WHERE email=${email}`
     *
     * This produces the query: "SELECT id FROM users WHERE email=$1".
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async queryAll(strings, ...params) {
        const query = buildQuery(strings, params);
        const args = buildQueryArgs(params);
        const source = getCurrentRequest();
        const cursor = await this.impl.query(query, args, source);
        const result = [];
        while (true) {
            const row = await cursor.next();
            if (row === null)
                break;
            result.push(row.values());
        }
        return result;
    }
    /**
     * rawQueryAll queries the database using a raw parametrised SQL query and parameters.
     *
     * It returns an array of all results.
     *
     * @example
     *
     * const query = "SELECT id FROM users WHERE email=$1";
     * const email = "foo@example.com";
     * const rows = await database.rawQueryAll(query, email);
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async rawQueryAll(query, ...params) {
        const args = buildQueryArgs(params);
        const source = getCurrentRequest();
        const cursor = await this.impl.query(query, args, source);
        const result = [];
        while (true) {
            const row = await cursor.next();
            if (row === null)
                break;
            result.push(row.values());
        }
        return result;
    }
    /**
     * queryRow is like query but returns only a single row.
     * If the query selects no rows it returns null.
     * Otherwise it returns the first row and discards the rest.
     *
     * @example
     * const email = "foo@example.com";
     * const result = database.queryRow`SELECT id FROM users WHERE email=${email}`
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async queryRow(strings, ...params) {
        const query = buildQuery(strings, params);
        const args = buildQueryArgs(params);
        const source = getCurrentRequest();
        const result = await this.impl.query(query, args, source);
        const row = await result.next();
        return row ? row.values() : null;
    }
    /**
     * rawQueryRow is like rawQuery but returns only a single row.
     * If the query selects no rows, it returns null.
     * Otherwise, it returns the first row and discards the rest.
     *
     * @example
     * const query = "SELECT id FROM users WHERE email=$1";
     * const email = "foo@example.com";
     * const result = await database.rawQueryRow(query, email);
     * console.log(result);
     *
     * @param query - The raw SQL query string.
     * @param params - The parameters to be used in the query.
     * @returns A promise that resolves to a single row or null.
     */
    async rawQueryRow(query, ...params) {
        const args = buildQueryArgs(params);
        const source = getCurrentRequest();
        const result = await this.impl.query(query, args, source);
        const row = await result.next();
        return row ? row.values() : null;
    }
    /**
     * exec executes a query without returning any rows.
     *
     * @example
     * const email = "foo@example.com";
     * const result = database.exec`DELETE FROM users WHERE email=${email}`
     */
    async exec(strings, ...params) {
        const query = buildQuery(strings, params);
        const args = buildQueryArgs(params);
        const source = getCurrentRequest();
        // Need to await the cursor to process any errors from things like
        // unique constraint violations.
        const cur = await this.impl.query(query, args, source);
        await cur.next();
    }
    /**
     * rawExec executes a query without returning any rows.
     *
     * @example
     * const query = "DELETE FROM users WHERE email=$1";
     * const email = "foo@example.com";
     * await database.rawExec(query, email);
     *
     * @param query - The raw SQL query string.
     * @param params - The parameters to be used in the query.
     * @returns A promise that resolves when the query has been executed.
     */
    async rawExec(query, ...params) {
        const args = buildQueryArgs(params);
        const source = getCurrentRequest();
        // Need to await the cursor to process any errors from things like
        // unique constraint violations.
        const cur = await this.impl.query(query, args, source);
        await cur.next();
    }
}
/**
 * Constructing a new database object will result in Encore provisioning a database with
 * that name and returning this object to represent it.
 *
 * If you want to reference an existing database, use `Database.Named(name)` as it is a
 * compile error to create duplicate databases.
 */
export class SQLDatabase extends BaseQueryExecutor {
    constructor(name, cfg) {
        super(runtime.RT.sqlDatabase(name));
    }
    /**
     * Reference an existing database by name, if the database doesn't
     * exist yet, use `new Database(name)` instead.
     */
    static named(name) {
        return new SQLDatabase(name);
    }
    /**
     * Returns the connection string for the database
     */
    get connectionString() {
        return this.impl.connString();
    }
    /**
     * Acquires a database connection from the database pool.
     *
     * When the connection is closed or is garbage-collected, it is returned to the pool.
     * @returns a new connection to the database
     */
    async acquire() {
        const impl = await this.impl.acquire();
        return new Connection(impl);
    }
    /**
     * Begins a database transaction.
     *
     * Prefer the `await using` pattern, which automatically rolls back
     * the transaction if neither `commit` nor `rollback` is called before
     * the variable goes out of scope:
     *
     * ```ts
     * await using tx = await db.begin();
     * await tx.exec`INSERT INTO ...`;
     * await tx.commit();
     * ```
     *
     * If you can't use `await using`, make sure to always call `commit`
     * or `rollback` yourself to prevent hanging transactions.
     *
     * @returns a transaction object that implements `AsyncDisposable`
     */
    async begin() {
        const source = getCurrentRequest();
        const impl = await this.impl.begin(source);
        return new Transaction(impl);
    }
}
/**
 * Represents a database transaction.
 *
 * `Transaction` implements `AsyncDisposable`, so the recommended usage is
 * the `await using` pattern — it automatically rolls back the transaction
 * if neither `commit` nor `rollback` is called before the variable goes
 * out of scope:
 *
 * ```ts
 * await using tx = await db.begin();
 * await tx.exec`INSERT INTO ...`;
 * await tx.commit();
 * ```
 *
 * If you can't use `await using`, make sure to always call `commit` or
 * `rollback` yourself to prevent hanging transactions.
 */
export class Transaction extends BaseQueryExecutor {
    done = false;
    constructor(impl) {
        super(impl);
    }
    /**
     * Commit the transaction.
     */
    async commit() {
        this.done = true;
        const source = getCurrentRequest();
        await this.impl.commit(source);
    }
    /**
     * Rollback the transaction.
     */
    async rollback() {
        this.done = true;
        const source = getCurrentRequest();
        await this.impl.rollback(source);
    }
    async [Symbol.asyncDispose]() {
        if (!this.done) {
            await this.rollback();
        }
    }
}
/**
 * Represents a dedicated connection to a database.
 */
export class Connection extends BaseQueryExecutor {
    constructor(impl) {
        super(impl);
    }
    /**
     * Returns the connection to the database pool.
     */
    async close() {
        await this.impl.close();
    }
}
function buildQuery(strings, expr) {
    let query = "";
    for (let i = 0; i < strings.length; i++) {
        query += strings[i];
        if (i < expr.length) {
            query += "$" + (i + 1);
        }
    }
    // return queryWithComment(query, driverName);
    return query;
}
function buildQueryArgs(params) {
    // Convert undefined to null.
    return new runtime.QueryArgs(params.map((p) => p ?? null));
}
//# sourceMappingURL=database.js.map