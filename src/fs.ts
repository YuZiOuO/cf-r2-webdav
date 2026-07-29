import path from "node:path";
import { type EntryState, type Lock, type Property } from "./fs_state";

export type Entry = {
  key: string;
  kind: "file" | "directory";
  object?: R2Object;
};

export type FileSystemErrorCode =
  | "invalid-path"
  | "not-found"
  | "already-exists"
  | "parent-not-found"
  | "not-directory"
  | "locked"
  | "conflict"
  | "inconsistent";

export class FileSystemError extends Error {
  constructor(
    readonly code: FileSystemErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "FileSystemError";
  }
}

export class AccessContext {
  private constructor(private readonly lockTokens: readonly string[]) {}

  static fromTokens(tokens: readonly string[]) {
    return new AccessContext([...new Set(tokens)]);
  }

  get tokens() {
    return this.lockTokens;
  }
}

export interface WebDavExtension {
  inspect(
    keys: string[],
  ): Promise<Record<string, Pick<EntryState, "locked" | "properties">>>;
  patchProperties(
    key: string,
    change: { set: Property[]; remove: string[] },
  ): Promise<void>;
  lock(
    key: string,
    request:
      | {
          kind: "create";
          scope: Lock["scope"];
          depth: Lock["depth"];
          expiresInSeconds?: number;
        }
      | {
          kind: "refresh";
          token: string;
          expiresInSeconds?: number;
        },
  ): Promise<Lock>;
  unlock(key: string, token: string): Promise<void>;
}

const KeyPath = {
  normalize(value: string) {
    if (typeof value !== "string" || value.includes("\0"))
      throw new FileSystemError("invalid-path", "Invalid path");

    const withoutSlashes = value.replace(/^\/+|\/+$/g, "");
    if (!withoutSlashes) return "";
    if (withoutSlashes.split("/").some((part) => part === ".."))
      throw new FileSystemError("invalid-path", "Invalid path");

    const normalized = path.posix.normalize(withoutSlashes);
    if (normalized === ".") return "";
    return normalized;
  },

  parent(key: string) {
    const parent = path.posix.dirname(key);
    return parent === "." ? "" : parent;
  },

  ancestorKeys(key: string) {
    const result = [key];
    let current = key;
    while (current) {
      current = KeyPath.parent(current);
      result.push(current);
    }
    return result;
  },

  entryKeyFromR2Key(key: string) {
    return key.endsWith("/") ? key.slice(0, -1) : key;
  },
};

export class FileSystem {
  readonly webdav: WebDavExtension;

  private readonly bucket: R2Bucket;
  private readonly access: AccessContext;

  constructor(
    private readonly env: CloudflareBindings,
    access: AccessContext,
  ) {
    this.bucket = env.BUCKET;
    this.access = access;
    this.webdav = {
      inspect: (keys) => this.inspectImpl(keys),
      patchProperties: (key, change) => this.patchPropertiesImpl(key, change),
      lock: (key, request) => this.lockImpl(key, request),
      unlock: (key, token) => this.unlockImpl(key, token),
    };
  }

  stat(rawKey: string): Promise<Entry | null> {
    return this.findEntry(KeyPath.normalize(rawKey));
  }

  async read(rawKey: string, options?: R2GetOptions) {
    const key = KeyPath.normalize(rawKey);
    const entry = await this.findEntry(key);
    if (!entry) return null;
    if (entry.kind === "directory")
      throw new FileSystemError("not-directory", "Resource is a directory");
    return this.bucket.get(key, options);
  }

  async list(rawKeyOrTarget: string | Entry): Promise<Entry[]> {
    const key =
      typeof rawKeyOrTarget === "string"
        ? KeyPath.normalize(rawKeyOrTarget)
        : rawKeyOrTarget.key;
    const directory =
      typeof rawKeyOrTarget === "string"
        ? await this.findEntry(key)
        : rawKeyOrTarget;
    if (!directory)
      throw new FileSystemError("not-found", "Directory not found");
    if (directory.kind !== "directory")
      throw new FileSystemError("not-directory", "Resource is not a directory");

    const entries = new Map<string, Entry>();
    let cursor: string | undefined;
    do {
      const listing = await this.bucket.list({
        prefix: key ? `${key}/` : "",
        delimiter: "/",
        cursor,
      });
      for (const prefix of listing.delimitedPrefixes) {
        const childKey = KeyPath.entryKeyFromR2Key(prefix);
        entries.set(childKey, { key: childKey, kind: "directory" });
      }
      for (const object of listing.objects) {
        const childKey = KeyPath.entryKeyFromR2Key(object.key);
        if (childKey === key) continue;
        const current = entries.get(childKey);
        entries.set(childKey, {
          key: childKey,
          kind: current?.kind ?? "file",
          object,
        });
      }
      cursor = listing.truncated ? listing.cursor : undefined;
    } while (cursor);

    return [...entries.values()].sort((left, right) =>
      left.key.localeCompare(right.key),
    );
  }

  async write(
    rawKey: string,
    body: Parameters<R2Bucket["put"]>[1],
    options?: R2PutOptions,
  ): Promise<Entry> {
    const key = KeyPath.normalize(rawKey);
    if (!key) throw new FileSystemError("invalid-path", "Cannot write root");
    await this.assertParentDirectoryExists(key);
    const existing = await this.findEntry(key);
    if (existing?.kind === "directory")
      throw new FileSystemError("already-exists", "Directory already exists");
    const hasLock = await this.assertNoLockConflict(key);
    if (this.access.tokens.length && !hasLock)
      throw new FileSystemError("conflict", "Lock condition does not match");
    const object = await this.bucket.put(key, body, options);
    if (!object)
      throw new FileSystemError("conflict", "Conditional write failed");
    return { key, kind: "file", object };
  }

  async mkdir(rawKey: string): Promise<Entry> {
    const key = KeyPath.normalize(rawKey);
    if (!key)
      throw new FileSystemError("already-exists", "Root directory exists");
    await this.assertParentDirectoryExists(key);
    if (await this.findEntry(key))
      throw new FileSystemError("already-exists", "Resource already exists");
    await this.assertNoLockConflict(key);
    const object = await this.bucket.put(`${key}/`, "", {
      onlyIf: { etagDoesNotMatch: "*" },
    });
    if (!object)
      throw new FileSystemError("already-exists", "Resource already exists");
    return { key, kind: "directory", object };
  }

  async remove(rawKey: string): Promise<void> {
    const key = KeyPath.normalize(rawKey);
    if (!key)
      throw new FileSystemError("invalid-path", "Cannot delete root directory");
    const target = await this.findEntry(key);
    if (!target) throw new FileSystemError("not-found", "Resource not found");

    const entryKeys =
      target.kind === "directory"
        ? await this.collectEntryKeysInSubtree(key)
        : [key];
    for (const entryKey of entryKeys) await this.assertNoLockConflict(entryKey);

    try {
      if (target.kind === "directory") {
        await this.deleteR2ObjectsWithPrefix(`${key}/`);
      } else {
        await this.bucket.delete(key);
      }
      await this.removeEntryState(entryKeys);
    } catch (error) {
      throw new FileSystemError(
        "inconsistent",
        "Delete completed only partially",
        {
          cause: error,
        },
      );
    }
  }

  async copy(
    rawSource: string,
    rawDestination: string,
    options: { recursive: boolean; overwrite: boolean },
  ): Promise<Entry> {
    return this.copyOrMove(
      KeyPath.normalize(rawSource),
      KeyPath.normalize(rawDestination),
      options.recursive,
      options.overwrite,
      false,
    );
  }

  async move(
    rawSource: string,
    rawDestination: string,
    options: { overwrite: boolean },
  ): Promise<Entry> {
    return this.copyOrMove(
      KeyPath.normalize(rawSource),
      KeyPath.normalize(rawDestination),
      true,
      options.overwrite,
      true,
    );
  }

  // R2 state

  private async findEntry(key: string): Promise<Entry | null> {
    if (!key) return { key: "", kind: "directory" };
    const object = await this.bucket.head(key);
    if (object) return { key, kind: "file", object };

    const listing = await this.bucket.list({ prefix: `${key}/`, limit: 1 });
    const first = listing.objects[0];
    if (!first) return null;
    return {
      key,
      kind: "directory",
      ...(first.key === `${key}/` ? { object: first } : {}),
    };
  }

  // Access and lock checks

  private async assertParentDirectoryExists(key: string) {
    const parent = await this.findEntry(KeyPath.parent(key));
    if (!parent)
      throw new FileSystemError(
        "parent-not-found",
        "Parent directory not found",
      );
    if (parent.kind !== "directory")
      throw new FileSystemError("not-directory", "Parent is not a directory");
  }

  private async assertNoLockConflict(key: string, checkTarget = true) {
    const resources = KeyPath.ancestorKeys(key);
    const start = checkTarget ? 0 : 1;
    let hasLock = false;
    for (let index = start; index < resources.length; index++) {
      const ancestorKey = resources[index];
      const state = await this.env.FileSystemState.getByName(
        KeyPath.parent(ancestorKey) || "/",
      ).read([ancestorKey], this.access.tokens, index > 0);
      hasLock ||= state[ancestorKey].locked;
      if (!state[ancestorKey].permitted)
        throw new FileSystemError("locked", "Resource is locked");
    }
    return hasLock;
  }

  // WebDAV metadata and locks

  private async inspectImpl(rawKeys: string[]) {
    const keys = rawKeys.map((key) => KeyPath.normalize(key));
    const result: Record<
      string,
      Pick<EntryState, "locked" | "properties">
    > = {};
    const groups = new Map<string, string[]>();
    for (const key of keys) {
      const partitionKey = KeyPath.parent(key) || "/";
      const group = groups.get(partitionKey) ?? [];
      group.push(key);
      groups.set(partitionKey, group);
    }
    await Promise.all(
      [...groups].map(async ([partitionKey, group]) => {
        Object.assign(
          result,
          await this.env.FileSystemState.getByName(partitionKey).read(group),
        );
      }),
    );
    return result;
  }

  private async patchPropertiesImpl(
    rawKey: string,
    change: { set: Property[]; remove: string[] },
  ) {
    const key = KeyPath.normalize(rawKey);
    if (!(await this.findEntry(key)))
      throw new FileSystemError("not-found", "Resource not found");
    await this.assertNoLockConflict(key, false);
    const stateStore = this.env.FileSystemState.getByName(
      KeyPath.parent(key) || "/",
    );
    const changed = await stateStore.mutate(key, {
      kind: "properties",
      operation: "patch",
      set: change.set,
      remove: change.remove,
      tokens: this.access.tokens,
    });
    if (changed !== true)
      throw new FileSystemError("locked", "Resource is locked");
  }

  private async lockImpl(
    rawKey: string,
    request: Parameters<WebDavExtension["lock"]>[1],
  ) {
    const key = KeyPath.normalize(rawKey);
    if (request.kind === "create") {
      const target = await this.findEntry(key);
      if (!target) await this.assertParentDirectoryExists(key);
    }
    if (request.kind === "refresh") {
      for (const candidateKey of KeyPath.ancestorKeys(key)) {
        const lock = await this.env.FileSystemState.getByName(
          KeyPath.parent(candidateKey) || "/",
        ).mutate(candidateKey, {
          kind: "lock",
          operation: "refresh",
          token: request.token,
          expiresInSeconds: request.expiresInSeconds,
        });
        if (lock && typeof lock !== "boolean") return lock;
      }
      throw new FileSystemError("locked", "Unable to refresh lock");
    }

    const lock = await this.env.FileSystemState.getByName(
      KeyPath.parent(key) || "/",
    ).mutate(key, {
      kind: "lock",
      operation: "create",
      scope: request.scope,
      depth: request.depth,
      expiresInSeconds: request.expiresInSeconds,
    });
    if (!lock || typeof lock === "boolean")
      throw new FileSystemError("locked", "Unable to acquire lock");
    return lock;
  }

  private async unlockImpl(rawKey: string, token: string) {
    const key = KeyPath.normalize(rawKey);
    const stateStore = this.env.FileSystemState.getByName(
      KeyPath.parent(key) || "/",
    );
    const released = await stateStore.mutate(key, {
      kind: "lock",
      operation: "release",
      token,
    });
    if (released !== true)
      throw new FileSystemError("conflict", "Lock token does not match");
    if (!(await this.findEntry(key))) {
      try {
        await this.bucket.put(key, "");
      } catch (error) {
        throw new FileSystemError(
          "inconsistent",
          "Lock-null resource could not be materialized",
          { cause: error },
        );
      }
    }
  }

  // Composite operations

  private async copyOrMove(
    sourceKey: string,
    destinationKey: string,
    recursive: boolean,
    overwrite: boolean,
    moving: boolean,
  ): Promise<Entry> {
    const copyR2Object = async (sourceKey: string, destinationKey: string) => {
      const object = await this.bucket.get(sourceKey);
      if (!object)
        throw new FileSystemError(
          "inconsistent",
          "Source disappeared during copy",
        );
      await this.bucket.put(destinationKey, object.body, {
        httpMetadata: object.httpMetadata,
        customMetadata: object.customMetadata,
        storageClass: object.storageClass,
      });
    };

    if (!sourceKey || !destinationKey || sourceKey === destinationKey)
      throw new FileSystemError(
        "invalid-path",
        "Invalid source or destination",
      );
    const source = await this.findEntry(sourceKey);
    if (!source) throw new FileSystemError("not-found", "Source not found");
    if (
      source.kind === "directory" &&
      destinationKey.startsWith(`${sourceKey}/`)
    )
      throw new FileSystemError("invalid-path", "Destination is inside source");
    const copyDirectoryContents = recursive || moving;
    await this.assertParentDirectoryExists(destinationKey);

    const existing = await this.findEntry(destinationKey);
    if (existing && !overwrite)
      throw new FileSystemError("already-exists", "Destination already exists");

    const destinationSubtreeKeys = existing
      ? existing.kind === "directory"
        ? await this.collectEntryKeysInSubtree(destinationKey)
        : [destinationKey]
      : [destinationKey];
    for (const entryKey of destinationSubtreeKeys)
      await this.assertNoLockConflict(entryKey);

    const sourceSubtreeKeys =
      source.kind === "directory" && copyDirectoryContents
        ? await this.collectEntryKeysInSubtree(sourceKey)
        : [sourceKey];
    if (moving) {
      for (const entryKey of sourceSubtreeKeys)
        await this.assertNoLockConflict(entryKey);
    }

    try {
      if (existing) {
        if (existing.kind === "directory")
          await this.deleteR2ObjectsWithPrefix(`${destinationKey}/`);
        else await this.bucket.delete(destinationKey);
        await this.removeEntryState(destinationSubtreeKeys);
      }

      if (source.kind === "file") {
        await copyR2Object(sourceKey, destinationKey);
      } else if (copyDirectoryContents) {
        const sourceObjects = await this.listR2ObjectsWithPrefix(
          `${sourceKey}/`,
        );
        let copiedMarker = false;
        for (const object of sourceObjects) {
          const suffix = object.key.slice(sourceKey.length + 1);
          await copyR2Object(object.key, `${destinationKey}/${suffix}`);
          if (object.key === `${sourceKey}/`) copiedMarker = true;
        }
        if (!copiedMarker) await this.bucket.put(`${destinationKey}/`, "");
      } else {
        await this.bucket.put(`${destinationKey}/`, "");
      }

      const sourceMetadata = await this.inspectImpl(sourceSubtreeKeys);
      for (const sourceEntryKey of sourceSubtreeKeys) {
        const suffix =
          sourceEntryKey === sourceKey
            ? ""
            : sourceEntryKey.slice(sourceKey.length + 1);
        const destinationEntryKey = suffix
          ? `${destinationKey}/${suffix}`
          : destinationKey;
        const state = sourceMetadata[sourceEntryKey];
        const stateStore = this.env.FileSystemState.getByName(
          KeyPath.parent(destinationEntryKey) || "/",
        );
        const changed = await stateStore.mutate(destinationEntryKey, {
          kind: "properties",
          operation: "replace",
          properties: state.properties,
          tokens: this.access.tokens,
        });
        if (changed !== true)
          throw new FileSystemError("locked", "Destination is locked");
      }

      if (moving) {
        if (source.kind === "directory")
          await this.deleteR2ObjectsWithPrefix(`${sourceKey}/`);
        else await this.bucket.delete(sourceKey);
        await this.removeEntryState(sourceSubtreeKeys);
      }
    } catch (error) {
      if (error instanceof FileSystemError) throw error;
      throw new FileSystemError(
        "inconsistent",
        "Copy or move completed only partially",
        { cause: error },
      );
    }

    const result = await this.findEntry(destinationKey);
    if (!result)
      throw new FileSystemError("inconsistent", "Destination was not created");
    return result;
  }

  // R2 tree helpers

  private async listR2ObjectsWithPrefix(prefix: string) {
    const objects: R2Object[] = [];
    let cursor: string | undefined;
    do {
      const listing = await this.bucket.list({ prefix, cursor });
      objects.push(...listing.objects);
      cursor = listing.truncated ? listing.cursor : undefined;
    } while (cursor);
    return objects;
  }

  private async collectEntryKeysInSubtree(rootKey: string) {
    const keys = new Set<string>([rootKey]);
    for (const object of await this.listR2ObjectsWithPrefix(`${rootKey}/`)) {
      let current = KeyPath.entryKeyFromR2Key(object.key);
      while (current !== rootKey) {
        keys.add(current);
        current = KeyPath.parent(current);
      }
    }
    return [...keys];
  }

  private async deleteR2ObjectsWithPrefix(prefix: string) {
    for (;;) {
      const listing = await this.bucket.list({ prefix });
      if (!listing.objects.length) return;
      await this.bucket.delete(listing.objects.map((object) => object.key));
    }
  }

  private async removeEntryState(keys: string[]) {
    const groups = new Map<string, string[]>();
    for (const key of keys) {
      const partitionKey = KeyPath.parent(key) || "/";
      const group = groups.get(partitionKey) ?? [];
      group.push(key);
      groups.set(partitionKey, group);
    }
    await Promise.all(
      [...groups].map(([partitionKey, group]) =>
        this.env.FileSystemState.getByName(partitionKey).remove(group),
      ),
    );
  }
}
