import { DurableObject } from "cloudflare:workers";

const MILLISECONDS_PER_SECOND = 1000;

export type Lock = {
  token: string;
  scope: "exclusive" | "shared";
  depth: "0" | "infinity";
};

export type Property = { name: string; value: string };

export type EntryState = {
  locked: boolean;
  permitted: boolean;
  properties: Property[];
};

export type Change =
  | {
      kind: "properties";
      operation: "patch";
      set: Property[];
      remove: string[];
      tokens: readonly string[];
    }
  | {
      kind: "properties";
      operation: "replace";
      properties: Property[];
      tokens: readonly string[];
    }
  | {
      kind: "lock";
      operation: "create";
      scope: Lock["scope"];
      depth: Lock["depth"];
      expiresInSeconds?: number;
    }
  | {
      kind: "lock";
      operation: "refresh";
      token: string;
      expiresInSeconds?: number;
    }
  | {
      kind: "lock";
      operation: "release";
      token: string;
    };

export class FileSystemState extends DurableObject {
  constructor(ctx: DurableObjectState, env: CloudflareBindings) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(() => {
      this.ctx.storage.sql.exec(
        `CREATE TABLE IF NOT EXISTS dead_properties (
          resource_key TEXT NOT NULL,
          name TEXT NOT NULL,
          value_xml TEXT NOT NULL,
          PRIMARY KEY (resource_key, name)
        )`,
      );
      this.ctx.storage.sql.exec(
        `CREATE TABLE IF NOT EXISTS locks (
          resource_key TEXT NOT NULL,
          token TEXT NOT NULL,
          scope TEXT NOT NULL,
          depth TEXT NOT NULL,
          expires_at INTEGER,
          PRIMARY KEY (resource_key, token)
        )`,
      );
      return Promise.resolve();
    });
  }

  private transaction<T>(callback: () => T) {
    return this.ctx.storage.transactionSync(callback);
  }

  private purgeExpiredLocks(now: number) {
    this.ctx.storage.sql.exec(
      "DELETE FROM locks WHERE expires_at IS NOT NULL AND expires_at <= ?",
      now,
    );
  }

  private readProperties(key: string) {
    return this.ctx.storage.sql
      .exec<{
        name: string;
        value_xml: string;
      }>(
        "SELECT name, value_xml FROM dead_properties WHERE resource_key = ? ORDER BY rowid",
        key,
      )
      .toArray()
      .map((property) => ({
        name: property.name,
        value: property.value_xml,
      }));
  }

  private writeProperties(key: string, properties: Property[]) {
    this.ctx.storage.sql.exec(
      "DELETE FROM dead_properties WHERE resource_key = ?",
      key,
    );
    for (const property of properties) {
      this.ctx.storage.sql.exec(
        "INSERT INTO dead_properties (resource_key, name, value_xml) VALUES (?, ?, ?)",
        key,
        property.name,
        property.value,
      );
    }
  }

  read(
    keys: string[],
    tokens: readonly string[] = [],
    descendant = false,
  ): Record<string, EntryState> {
    if (!keys.length) return {};
    return this.transaction(() => {
      const now = Date.now();
      this.purgeExpiredLocks(now);
      const placeholders = keys.map(() => "?").join(", ");
      const states = new Map<string, EntryState>(
        keys.map((key) => [
          key,
          { locked: false, permitted: true, properties: [] },
        ]),
      );
      for (const lock of this.ctx.storage.sql
        .exec<{
          resource_key: string;
          token: string;
          depth: Lock["depth"];
        }>(
          `SELECT resource_key, token, depth FROM locks
           WHERE resource_key IN (${placeholders})`,
          ...keys,
        )
        .toArray()) {
        const state = states.get(lock.resource_key);
        if (!state) continue;
        state.locked = true;
        if (
          (!descendant || lock.depth === "infinity") &&
          !tokens.includes(lock.token)
        )
          state.permitted = false;
      }
      for (const property of this.ctx.storage.sql
        .exec<{
          resource_key: string;
          name: string;
          value_xml: string;
        }>(
          `SELECT resource_key, name, value_xml FROM dead_properties
           WHERE resource_key IN (${placeholders}) ORDER BY resource_key, rowid`,
          ...keys,
        )
        .toArray()) {
        states.get(property.resource_key)?.properties.push({
          name: property.name,
          value: property.value_xml,
        });
      }
      return Object.fromEntries(states);
    });
  }

  mutate(key: string, change: Change) {
    return this.transaction(() => {
      switch (change.kind) {
        case "properties": {
          this.purgeExpiredLocks(Date.now());
          const locks = this.ctx.storage.sql
            .exec<{ token: string }>(
              "SELECT token FROM locks WHERE resource_key = ?",
              key,
            )
            .toArray();
          if (locks.some((lock) => !change.tokens.includes(lock.token)))
            return false;

          switch (change.operation) {
            case "replace":
              this.writeProperties(key, change.properties);
              return true;
            case "patch": {
              const setByName = new Map(
                change.set.map((property) => [property.name, property]),
              );
              const next = this.readProperties(key).filter(
                (property) =>
                  !change.remove.includes(property.name) &&
                  !setByName.has(property.name),
              );
              this.writeProperties(key, next.concat([...setByName.values()]));
              return true;
            }
          }
          break;
        }
        case "lock": {
          const now = Date.now();
          this.purgeExpiredLocks(now);
          switch (change.operation) {
            case "release":
              return (
                this.ctx.storage.sql.exec(
                  "DELETE FROM locks WHERE resource_key = ? AND token = ?",
                  key,
                  change.token,
                ).rowsWritten > 0
              );
            case "refresh": {
              const existing = this.ctx.storage.sql
                .exec<{
                  token: string;
                  scope: Lock["scope"];
                  depth: Lock["depth"];
                }>(
                  "SELECT token, scope, depth FROM locks WHERE resource_key = ? AND token = ?",
                  key,
                  change.token,
                )
                .toArray()[0];
              if (!existing) return null;
              const expiresAt =
                change.expiresInSeconds === undefined
                  ? null
                  : now + change.expiresInSeconds * MILLISECONDS_PER_SECOND;
              this.ctx.storage.sql.exec(
                "UPDATE locks SET expires_at = ? WHERE resource_key = ? AND token = ?",
                expiresAt,
                key,
                change.token,
              );
              return {
                token: existing.token,
                scope: existing.scope,
                depth: existing.depth,
              };
            }
            case "create": {
              const conflicts = this.ctx.storage.sql
                .exec<{ scope: Lock["scope"] }>(
                  "SELECT scope FROM locks WHERE resource_key = ?",
                  key,
                )
                .toArray();
              if (
                conflicts.some(
                  (lock) =>
                    change.scope === "exclusive" || lock.scope === "exclusive",
                )
              )
                return null;
              const lock: Lock = {
                token: `opaquelocktoken:${crypto.randomUUID()}`,
                scope: change.scope,
                depth: change.depth,
              };
              const expiresAt =
                change.expiresInSeconds === undefined
                  ? null
                  : now + change.expiresInSeconds * MILLISECONDS_PER_SECOND;
              this.ctx.storage.sql.exec(
                "INSERT INTO locks (resource_key, token, scope, depth, expires_at) VALUES (?, ?, ?, ?, ?)",
                key,
                lock.token,
                lock.scope,
                lock.depth,
                expiresAt,
              );
              return lock;
            }
          }
        }
      }
    });
  }

  remove(keys: string[]) {
    this.transaction(() => {
      for (const key of keys) {
        this.ctx.storage.sql.exec(
          "DELETE FROM dead_properties WHERE resource_key = ?",
          key,
        );
        this.ctx.storage.sql.exec(
          "DELETE FROM locks WHERE resource_key = ?",
          key,
        );
      }
    });
  }
}
