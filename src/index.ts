import { basicAuth } from "hono/basic-auth";
import { Hono } from "hono";
import { DurableObject } from "cloudflare:workers";
import XMLBuilder from "fast-xml-builder";
import { XMLParser } from "fast-xml-parser";

const ALLOW =
  "OPTIONS, PROPFIND, PROPPATCH, GET, HEAD, PUT, DELETE, MKCOL, COPY, MOVE, LOCK, UNLOCK";
const xmlBuilder = new XMLBuilder({ ignoreAttributes: false });

type Property = { name: string; value: string };
type Lock = {
  key: string;
  token: string;
  scope: "exclusive" | "shared";
  timeout: string;
  expires?: number;
};

export class WebDavMetadata extends DurableObject {
  async properties(key: string) {
    return (await this.ctx.storage.get<Property[]>(`properties:${key}`)) ?? [];
  }

  async patch(key: string, set: Property[], remove: string[]) {
    const properties = await this.properties(key);
    const next = properties.filter(
      (property) =>
        !remove.includes(property.name) &&
        !set.some((value) => value.name === property.name),
    );
    next.push(...set);
    await this.ctx.storage.put(`properties:${key}`, next);
  }

  async lock(
    key: string,
    scope: Lock["scope"],
    timeout: string,
    token?: string,
  ) {
    const locks = ((await this.ctx.storage.get<Lock[]>("locks")) ?? []).filter(
      (lock) => !lock.expires || lock.expires > Date.now(),
    );
    if (token) {
      const lock = locks.find(
        (value) => value.key === key && value.token === token,
      );
      if (!lock) return null;
      lock.timeout = timeout;
      lock.expires =
        timeout === "Infinite"
          ? undefined
          : Date.now() + Number(timeout.slice(7)) * 1000;
      await this.ctx.storage.put("locks", locks);
      return lock;
    }
    if (
      locks.some(
        (lock) =>
          lock.key === key &&
          (scope === "exclusive" || lock.scope === "exclusive"),
      )
    )
      return null;
    const lock = {
      key,
      token: `opaquelocktoken:${crypto.randomUUID()}`,
      scope,
      timeout,
      expires:
        timeout === "Infinite"
          ? undefined
          : Date.now() + Number(timeout.slice(7)) * 1000,
    };
    locks.push(lock);
    await this.ctx.storage.put("locks", locks);
    return lock;
  }

  async permits(key: string, ifHeader?: string) {
    const locks = ((await this.ctx.storage.get<Lock[]>("locks")) ?? []).filter(
      (lock) => !lock.expires || lock.expires > Date.now(),
    );
    await this.ctx.storage.put("locks", locks);
    return !locks.some(
      (lock) => lock.key === key && !ifHeader?.includes(lock.token),
    );
  }

  async unlock(key: string, token: string) {
    const locks = (await this.ctx.storage.get<Lock[]>("locks")) ?? [];
    if (!locks.some((lock) => lock.key === key && lock.token === token))
      return false;
    await this.ctx.storage.put(
      "locks",
      locks.filter((lock) => lock.key !== key || lock.token !== token),
    );
    return true;
  }

  async hasLock(key: string) {
    return ((await this.ctx.storage.get<Lock[]>("locks")) ?? []).some(
      (lock) =>
        lock.key === key && (!lock.expires || lock.expires > Date.now()),
    );
  }
}

async function deleteR2ObjectsWithPrefix(bucket: R2Bucket, prefix: string) {
  while (true) {
    const listing = await bucket.list({ prefix });
    if (!listing.objects.length) return;
    await bucket.delete(listing.objects.map((object) => object.key));
  }
}

async function copyR2Object(
  bucket: R2Bucket,
  sourceKey: string,
  destinationKey: string,
) {
  const object = await bucket.get(sourceKey);
  if (!object) return;
  await bucket.put(destinationKey, object.body, {
    httpMetadata: object.httpMetadata,
    customMetadata: object.customMetadata,
    storageClass: object.storageClass,
  });
}

async function findR2ObjectOrDirectory(bucket: R2Bucket, key: string) {
  if (!key) return { key, directory: true };

  const object = await bucket.head(key);
  if (object) return { key, directory: false, object };

  const listing = await bucket.list({ prefix: `${key}/`, limit: 1 });
  const [first] = listing.objects;
  if (!first) return null;
  return first.key === `${key}/`
    ? { key, directory: true, object: first }
    : { key, directory: true };
}

const app = new Hono<{
  Bindings: CloudflareBindings & {
    WEBDAV_USERNAME: string;
    WEBDAV_PASSWORD: string;
  };
  Variables: { key: string };
}>();

app.use("*", (c, next) =>
  basicAuth({
    username: c.env.WEBDAV_USERNAME,
    password: c.env.WEBDAV_PASSWORD,
  })(c, next),
);

app.use("*", async (c, next) => {
  try {
    const key = decodeURIComponent(c.req.path).replace(/^\/+|\/+$/g, "");
    c.set("key", key);
  } catch {
    return c.text("Invalid path", 400);
  }
  await next();
});

app.options("*", (c) => c.body(null, 204, { Allow: ALLOW, DAV: "1, 2" }));

app.on("PROPFIND", "*", async (c) => {
  const key = c.get("key");
  let target = await findR2ObjectOrDirectory(c.env.BUCKET, key);
  if (!target && (await c.env.METADATA.getByName("webdav").hasLock(key)))
    target = { key, directory: false };
  if (!target) return c.text("Resource not found", 404);

  const depth = c.req.header("depth") ?? "1";
  if (depth.toLowerCase() === "infinity") {
    return c.body(
      '<D:error xmlns:D="DAV:"><D:propfind-finite-depth/></D:error>',
      403,
      {
        "Content-Type": "application/xml; charset=utf-8",
      },
    );
  }
  if (depth !== "0" && depth !== "1")
    return c.text("Invalid Depth header", 400);

  const resources = [target];
  if (target.directory && depth === "1") {
    let cursor: string | undefined;
    do {
      const listing = await c.env.BUCKET.list({
        prefix: key ? `${key}/` : "",
        delimiter: "/",
        cursor,
      });
      for (const value of listing.delimitedPrefixes)
        resources.push({ key: value.slice(0, -1), directory: true });
      for (const object of listing.objects) {
        if (object.key !== `${key}/`)
          resources.push({ key: object.key, directory: false, object });
      }
      cursor = listing.truncated ? listing.cursor : undefined;
    } while (cursor);
  }

  const requestBody = c.req.raw.body
    ? new XMLParser().parse(await c.req.text())
    : undefined;
  const propfind = requestBody?.["D:propfind"] ?? requestBody?.propfind;
  const requested = Object.keys(propfind?.["D:prop"] ?? propfind?.prop ?? {});
  const propname = Boolean(
    propfind && ("D:propname" in propfind || "propname" in propfind),
  );
  const responses = await Promise.all(
    resources.map(async (item) => {
      const object = item.object;
      const name = item.key.split("/").pop() || "/";
      const href = item.key
        ? `/${item.key.split("/").map(encodeURIComponent).join("/")}${item.directory ? "/" : ""}`
        : "/";
      const live = {
        "D:displayname": name,
        ...(object
          ? {
              "D:getlastmodified": object.uploaded.toUTCString(),
              "D:getetag": object.httpEtag,
            }
          : {}),
        "D:resourcetype": item.directory ? { "D:collection": "" } : "",
        ...(object && !item.directory
          ? {
              "D:getcontentlength": object.size,
              "D:getcontenttype":
                object.httpMetadata?.contentType ?? "application/octet-stream",
            }
          : {}),
        "D:supportedlock": {
          "D:lockentry": {
            "D:lockscope": { "D:exclusive": "" },
            "D:locktype": { "D:write": "" },
          },
        },
        ...((await c.env.METADATA.getByName("webdav").hasLock(item.key))
          ? { "D:lockdiscovery": "" }
          : {}),
      };
      const dead = await c.env.METADATA.getByName("webdav").properties(
        item.key,
      );
      const properties = Object.fromEntries(
        dead.map((property) => [property.name, property.value]),
      );
      const names = propname
        ? [...Object.keys(live), ...dead.map((property) => property.name)]
        : requested.length
          ? requested
          : [...Object.keys(live), ...dead.map((property) => property.name)];
      const found = Object.fromEntries(
        names
          .filter((property) => property in live || property in properties)
          .map((property) => [
            property,
            propname
              ? ""
              : property in live
                ? live[property as keyof typeof live]
                : properties[property],
          ]),
      );
      const missing = Object.fromEntries(
        names
          .filter(
            (property) => !(property in live) && !(property in properties),
          )
          .map((property) => [property, ""]),
      );
      return {
        "D:href": href,
        "D:propstat": [
          { "D:prop": found, "D:status": "HTTP/1.1 200 OK" },
          ...(Object.keys(missing).length
            ? [{ "D:prop": missing, "D:status": "HTTP/1.1 404 Not Found" }]
            : []),
        ],
      };
    }),
  );
  return c.body(
    xmlBuilder.build({
      "?xml": { "@_version": "1.0", "@_encoding": "utf-8" },
      "D:multistatus": {
        "@_xmlns:D": "DAV:",
        "@_xmlns:X": "urn:test",
        "D:response": responses,
      },
    }),
    207,
    { "Content-Type": "application/xml; charset=utf-8" },
  );
});

app.get("*", async (c) => {
  const key = c.get("key");
  if (!key) return c.text("Collection", 405, { Allow: ALLOW });

  const range = c.req.header("range");
  const object = await c.env.BUCKET.get(
    key,
    range ? { range: c.req.raw.headers } : undefined,
  );
  if (!object) {
    if (await findR2ObjectOrDirectory(c.env.BUCKET, key))
      return c.text("Collection", 405, { Allow: ALLOW });
    return c.text("Not Found", 404);
  }
  const objectRange = range
    ? (object.range as { offset: number; length: number })
    : undefined;
  const headers = new Headers({
    "Accept-Ranges": "bytes",
    "Content-Length": String(objectRange?.length ?? object.size),
    ETag: object.httpEtag,
    "Last-Modified": object.uploaded.toUTCString(),
  });
  object.writeHttpMetadata(headers);
  if (objectRange)
    headers.set(
      "Content-Range",
      `bytes ${objectRange.offset}-${objectRange.offset + objectRange.length - 1}/${object.size}`,
    );
  return c.body(object.body, { status: objectRange ? 206 : 200, headers });
});

app.put("*", async (c) => {
  const key = c.get("key");
  if (!key) return c.text("Collection", 405, { Allow: ALLOW });
  if (
    (
      await findR2ObjectOrDirectory(
        c.env.BUCKET,
        key.substring(0, key.lastIndexOf("/")),
      )
    )?.directory !== true
  ) {
    return c.text("Parent collection not found", 409);
  }
  const existing = await findR2ObjectOrDirectory(c.env.BUCKET, key);
  if (existing?.directory)
    return c.text("Collection exists", 405, { Allow: ALLOW });
  if (
    c.req.header("if-match") &&
    c.req.header("if-match") !== "*" &&
    c.req.header("if-match") !== existing?.object?.httpEtag
  )
    return c.body(null, 412);
  if (c.req.header("if-none-match") === "*" && existing)
    return c.body(null, 412);
  if (
    !(await c.env.METADATA.getByName("webdav").permits(key, c.req.header("if")))
  )
    return c.text("Locked", 423);
  const object = await c.env.BUCKET.put(key, c.req.raw.body ?? "", {
    httpMetadata: c.req.raw.headers,
  });
  return c.body(null, existing ? 204 : 201, {
    ...(existing ? {} : { Location: c.req.url }),
    ETag: object.httpEtag,
    "Last-Modified": object.uploaded.toUTCString(),
  });
});

app.on("MKCOL", "*", async (c) => {
  const key = c.get("key");
  if (!key || (await findR2ObjectOrDirectory(c.env.BUCKET, key)))
    return c.text("Collection exists", 405, { Allow: ALLOW });
  if (
    (
      await findR2ObjectOrDirectory(
        c.env.BUCKET,
        key.substring(0, key.lastIndexOf("/")),
      )
    )?.directory !== true
  ) {
    return c.text("Parent collection not found", 409);
  }
  if (c.req.raw.body && (await c.req.raw.arrayBuffer()).byteLength)
    return c.text("MKCOL body is not supported", 415);
  await c.env.BUCKET.put(`${key}/`, "");
  return c.body(null, 201, { Location: c.req.url });
});

app.on("PROPPATCH", "*", async (c) => {
  const key = c.get("key");
  if (!(await findR2ObjectOrDirectory(c.env.BUCKET, key)))
    return c.text("Not Found", 404);
  if (
    !(await c.env.METADATA.getByName("webdav").permits(key, c.req.header("if")))
  )
    return c.text("Locked", 423);
  const body = new XMLParser().parse(await c.req.text());
  const update = body["D:propertyupdate"] ?? body.propertyupdate;
  const set = update?.["D:set"]?.["D:prop"] ?? update?.set?.prop ?? {};
  const remove = update?.["D:remove"]?.["D:prop"] ?? update?.remove?.prop ?? {};
  const protectedProperties = Object.keys(set).filter(
    (property) =>
      property.startsWith("D:") &&
      [
        "D:getetag",
        "D:getcontentlength",
        "D:getlastmodified",
        "D:resourcetype",
      ].includes(property),
  );
  if (protectedProperties.length) {
    return c.body(
      xmlBuilder.build({
        "?xml": { "@_version": "1.0", "@_encoding": "utf-8" },
        "D:multistatus": {
          "@_xmlns:D": "DAV:",
          "D:response": {
            "D:href": c.req.path,
            "D:propstat": [
              {
                "D:prop": Object.fromEntries(
                  protectedProperties.map((property) => [property, ""]),
                ),
                "D:status": "HTTP/1.1 403 Forbidden",
              },
              {
                "D:prop": Object.fromEntries(
                  Object.keys(set)
                    .filter(
                      (property) => !protectedProperties.includes(property),
                    )
                    .map((property) => [property, ""]),
                ),
                "D:status": "HTTP/1.1 424 Failed Dependency",
              },
            ],
          },
        },
      }),
      207,
      { "Content-Type": "application/xml; charset=utf-8" },
    );
  }
  await c.env.METADATA.getByName("webdav").patch(
    key,
    Object.entries(set).map(([name, value]) => ({
      name,
      value: String(value),
    })),
    Object.keys(remove),
  );
  return c.body(
    xmlBuilder.build({
      "?xml": { "@_version": "1.0", "@_encoding": "utf-8" },
      "D:multistatus": {
        "@_xmlns:D": "DAV:",
        "D:response": {
          "D:href": c.req.path,
          "D:propstat": {
            "D:prop": { ...set, ...remove },
            "D:status": "HTTP/1.1 200 OK",
          },
        },
      },
    }),
    207,
    { "Content-Type": "application/xml; charset=utf-8" },
  );
});

app.on("LOCK", "*", async (c) => {
  const key = c.get("key");
  const target = await findR2ObjectOrDirectory(c.env.BUCKET, key);
  const timeout = c.req.header("timeout")?.split(",")[0].trim() ?? "Infinite";
  if (timeout !== "Infinite" && !/^Second-\d+$/.test(timeout))
    return c.text("Invalid Timeout header", 400);
  const body = c.req.raw.body ? await c.req.text() : "";
  const token = c.req.header("if")?.match(/<([^>]+)>/)?.[1];
  const lockinfo = body && new XMLParser().parse(body);
  const scope =
    lockinfo &&
    (lockinfo["D:lockinfo"]?.["D:lockscope"]?.["D:shared"] ??
      lockinfo.lockinfo?.lockscope?.shared) !== undefined
      ? "shared"
      : "exclusive";
  const lock = await c.env.METADATA.getByName("webdav").lock(
    key,
    scope,
    timeout,
    token,
  );
  if (!lock) return c.text("Locked", 423);
  return c.body(
    xmlBuilder.build({
      "?xml": { "@_version": "1.0", "@_encoding": "utf-8" },
      "D:prop": {
        "@_xmlns:D": "DAV:",
        "D:lockdiscovery": {
          "D:activelock": {
            "D:lockscope": { [`D:${lock.scope}`]: "" },
            "D:locktype": { "D:write": "" },
            "D:depth": "0",
            "D:timeout": lock.timeout,
            "D:locktoken": { "D:href": lock.token },
          },
        },
      },
    }),
    target ? 200 : 201,
    {
      "Content-Type": "application/xml; charset=utf-8",
      "Lock-Token": `<${lock.token}>`,
      Timeout: lock.timeout,
    },
  );
});

app.on("UNLOCK", "*", async (c) => {
  const token = c.req.header("lock-token")?.match(/^<([^>]+)>$/)?.[1];
  if (
    !token ||
    !(await c.env.METADATA.getByName("webdav").unlock(c.get("key"), token))
  )
    return c.text("Lock token does not match", 409);
  return c.body(null, 204);
});

app.on(["COPY", "MOVE"], "*", async (c) => {
  const sourceKey = c.get("key");
  const destination = c.req.header("destination");
  if (!sourceKey || !destination)
    return c.text("Invalid Destination header", 400);

  let destinationKey: string;
  try {
    const url = new URL(destination, c.req.url);
    if (url.origin !== new URL(c.req.url).origin)
      return c.text("Cross-origin destinations are not supported", 502);
    destinationKey = decodeURIComponent(url.pathname).replace(/^\/+|\/+$/g, "");
  } catch {
    return c.text("Invalid Destination header", 400);
  }
  if (!destinationKey) return c.text("Invalid destination", 403);

  const source = await findR2ObjectOrDirectory(c.env.BUCKET, sourceKey);
  if (!source) return c.text("Not Found", 404);
  if (
    sourceKey === destinationKey ||
    (source.directory && destinationKey.startsWith(`${sourceKey}/`))
  ) {
    return c.text("Invalid destination", 403);
  }
  if (
    (
      await findR2ObjectOrDirectory(
        c.env.BUCKET,
        destinationKey.substring(0, destinationKey.lastIndexOf("/")),
      )
    )?.directory !== true
  ) {
    return c.text("Parent collection not found", 409);
  }

  const depth = (c.req.header("depth") ?? "infinity").toLowerCase();
  if (
    source.directory &&
    ((depth !== "0" && depth !== "infinity") ||
      (c.req.method === "MOVE" && depth !== "infinity"))
  ) {
    return c.text("Invalid Depth header", 400);
  }

  const existing = await findR2ObjectOrDirectory(c.env.BUCKET, destinationKey);
  const overwrite = (c.req.header("overwrite") ?? "T").toUpperCase();
  if (overwrite !== "T" && overwrite !== "F")
    return c.text("Invalid Overwrite header", 400);
  if (existing && overwrite === "F") return c.text("Destination exists", 412);
  if (existing) {
    if (existing.directory)
      await deleteR2ObjectsWithPrefix(c.env.BUCKET, `${destinationKey}/`);
    else await c.env.BUCKET.delete(destinationKey);
  }

  if (source.directory && depth === "0") {
    await c.env.BUCKET.put(`${destinationKey}/`, "");
  } else if (source.directory) {
    let cursor: string | undefined;
    do {
      const listing = await c.env.BUCKET.list({
        prefix: `${sourceKey}/`,
        cursor,
      });
      for (const object of listing.objects) {
        await copyR2Object(
          c.env.BUCKET,
          object.key,
          `${destinationKey}/${object.key.slice(sourceKey.length + 1)}`,
        );
      }
      cursor = listing.truncated ? listing.cursor : undefined;
    } while (cursor);
  } else {
    await copyR2Object(c.env.BUCKET, sourceKey, destinationKey);
  }

  if (c.req.method === "MOVE") {
    if (source.directory)
      await deleteR2ObjectsWithPrefix(c.env.BUCKET, `${sourceKey}/`);
    else await c.env.BUCKET.delete(sourceKey);
  }
  return c.body(
    null,
    existing ? 204 : 201,
    existing
      ? undefined
      : { Location: new URL(destination, c.req.url).toString() },
  );
});

app.delete("*", async (c) => {
  const key = c.get("key");
  if (!key) return c.text("Cannot delete root collection", 403);
  const target = await findR2ObjectOrDirectory(c.env.BUCKET, key);
  if (!target) return c.text("Not Found", 404);
  if (target.directory) {
    await deleteR2ObjectsWithPrefix(c.env.BUCKET, `${key}/`);
  } else {
    await c.env.BUCKET.delete(key);
  }
  return c.body(null, 204);
});

app.all("*", (c) => c.text("Method Not Allowed", 405, { Allow: ALLOW }));

export default app;
