import { basicAuth } from "hono/basic-auth";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import XMLBuilder from "fast-xml-builder";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import fresh from "fresh";
import {
  AccessContext,
  FileSystem,
  FileSystemError,
  type Entry,
} from "./fs";
import { type Lock, type Property } from "./fs_state";
import { parseProppatch, parsePropfind, toXmlPropertyMap } from "./xml";

export { FileSystemState } from "./fs_state";

const ALLOW =
  "OPTIONS, PROPFIND, PROPPATCH, GET, HEAD, PUT, DELETE, MKCOL, COPY, MOVE, LOCK, UNLOCK";
const xmlBuilder = new XMLBuilder({ ignoreAttributes: false });
const xmlParser = new XMLParser({
  ignoreAttributes: false,
  parseTagValue: false,
});

const app = new Hono<{
  Bindings: CloudflareBindings & {
    WEBDAV_USERNAME: string;
    WEBDAV_PASSWORD: string;
  };
  Variables: { key: string; filesystem: FileSystem };
}>();

app.onError((error, c) => {
  if (error instanceof FileSystemError) {
    switch (error.code) {
      case "invalid-path":
        return c.text(error.message, 400);
      case "not-found":
        return c.text(error.message, 404);
      case "already-exists":
        return c.text(error.message, 405);
      case "parent-not-found":
        return c.text(error.message, 409);
      case "not-directory":
        return c.text(error.message, 405);
      case "locked":
        return c.text(error.message, 423);
      case "conflict":
        return c.text(error.message, 412);
      case "inconsistent":
        return c.text(error.message, 500);
    }
  }
  if (error instanceof HTTPException) {
    return error.getResponse();
  }
  console.error(error);
  return c.text("Internal Server Error", 500);
});

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
    c.set(
      "filesystem",
      new FileSystem(
        c.env,
        AccessContext.fromTokens(
          c.req
            .header("if")
            ?.match(/<([^>]+)>/g)
            ?.map((value) => value.slice(1, -1)) ?? [],
        ),
      ),
    );
  } catch {
    return c.text("Invalid path", 400);
  }
  await next();
});

app.options("*", (c) => c.body(null, 204, { Allow: ALLOW, DAV: "1, 2" }));

app.on("PROPFIND", "*", async (c) => {
  const filesystem = c.get("filesystem");
  const key = c.get("key");
  let target = await filesystem.stat(key);
  if (!target && (await filesystem.webdav.inspect([key]))[key]?.locked)
    target = { key, kind: "file" };
  if (!target) return c.text("Resource not found", 404);

  const depth = c.req.header("depth") ?? "infinity";
  if (depth.toLowerCase() === "infinity") {
    return c.body(
      '<D:error xmlns:D="DAV:"><D:propfind-finite-depth/></D:error>',
      403,
      { "Content-Type": "application/xml; charset=utf-8" },
    );
  }
  if (depth !== "0" && depth !== "1")
    return c.text("Invalid Depth header", 400);

  const resources: Entry[] = [target];
  if (target.kind === "directory" && depth === "1")
    resources.push(...(await filesystem.list(target)));

  const metadata = await filesystem.webdav.inspect(
    resources.map((resource) => resource.key),
  );
  const requestText = c.req.raw.body ? await c.req.text() : "";
  if (
    requestText &&
    (/\bxmlns:[\w.-]+\s*=\s*(["'])\s*\1/.test(requestText) ||
      XMLValidator.validate(requestText) !== true)
  )
    return c.text("Invalid XML", 400);
  const { requested, propname } = requestText
    ? parsePropfind(requestText)
    : { requested: [], propname: false };
  const responses = resources.map((item) => {
    const object = item.object;
    const name = item.key.split("/").pop() || "/";
    const href = item.key
      ? `/${item.key.split("/").map(encodeURIComponent).join("/")}${item.kind === "directory" ? "/" : ""}`
      : "/";
    const live: Record<string, unknown> = {
      "D:displayname": name,
      "D:resourcetype": item.kind === "directory" ? { "D:collection": "" } : "",
      "D:supportedlock": {
        "D:lockentry": {
          "D:lockscope": { "D:exclusive": "" },
          "D:locktype": { "D:write": "" },
        },
      },
    };
    if (object) {
      live["D:getlastmodified"] = object.uploaded.toUTCString();
      live["D:getetag"] = object.httpEtag;
    }
    if (object && item.kind === "file") {
      live["D:getcontentlength"] = object.size;
      live["D:getcontenttype"] =
        object.httpMetadata?.contentType ?? "application/octet-stream";
    }
    const itemMetadata = metadata[item.key] ?? {
      locked: false,
      properties: [],
    };
    if (itemMetadata.locked) live["D:lockdiscovery"] = "";
    const properties = Object.fromEntries(
      itemMetadata.properties.map((property) => [
        property.name,
        property.value,
      ]),
    );
    const available = { ...properties, ...live };
    let names = Object.keys(available);
    if (requested.length && !propname) names = requested;
    const found = Object.fromEntries(
      names
        .filter((property) => Object.hasOwn(available, property))
        .map((property) => [property, propname ? "" : available[property]]),
    );
    const missing = Object.fromEntries(
      names
        .filter((property) => !Object.hasOwn(available, property))
        .map((property) => [property, ""]),
    );
    return {
      "D:href": href,
      "D:propstat": [
        {
          "D:prop": toXmlPropertyMap(found),
          "D:status": "HTTP/1.1 200 OK",
        },
        ...(Object.keys(missing).length
          ? [
              {
                "D:prop": toXmlPropertyMap(missing),
                "D:status": "HTTP/1.1 404 Not Found",
              },
            ]
          : []),
      ],
    };
  });
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

app.on("PROPPATCH", "*", async (c) => {
  const filesystem = c.get("filesystem");
  const key = c.get("key");
  if (!(await filesystem.stat(key))) return c.text("Not Found", 404);
  const requestText = await c.req.text();
  if (XMLValidator.validate(requestText) !== true)
    return c.text("Invalid XML", 400);
  const set = new Map<string, Property>();
  const remove = new Set<string>();
  for (const { operation, properties } of parseProppatch(requestText)) {
    if (operation === "set") {
      for (const property of properties) {
        remove.delete(property.name);
        set.set(property.name, property);
      }
    } else {
      for (const property of properties) {
        set.delete(property.name);
        remove.add(property.name);
      }
    }
  }
  const changedProperties = Object.fromEntries([
    ...[...set].map(([name, property]) => [name, property.value]),
    ...[...remove].map((name) => [name, ""]),
  ]);
  const protectedProperties = Object.keys(changedProperties).filter(
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
                "D:prop": toXmlPropertyMap(
                  Object.fromEntries(
                    protectedProperties.map((property) => [property, ""]),
                  ),
                ),
                "D:status": "HTTP/1.1 403 Forbidden",
              },
              {
                "D:prop": toXmlPropertyMap(
                  Object.fromEntries(
                    Object.keys(changedProperties)
                      .filter(
                        (property) => !protectedProperties.includes(property),
                      )
                      .map((property) => [property, ""]),
                  ),
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
  await filesystem.webdav.patchProperties(key, {
    set: [...set.values()],
    remove: [...remove],
  });
  return c.body(
    xmlBuilder.build({
      "?xml": { "@_version": "1.0", "@_encoding": "utf-8" },
      "D:multistatus": {
        "@_xmlns:D": "DAV:",
        "D:response": {
          "D:href": c.req.path,
          "D:propstat": {
            "D:prop": toXmlPropertyMap(changedProperties),
            "D:status": "HTTP/1.1 200 OK",
          },
        },
      },
    }),
    207,
    { "Content-Type": "application/xml; charset=utf-8" },
  );
});

app.get("*", async (c) => {
  const filesystem = c.get("filesystem");
  const key = c.get("key");
  if (!key) return c.text("Collection", 405, { Allow: ALLOW });
  const target = await filesystem.stat(key);
  if (!target) {
    if ((await filesystem.webdav.inspect([key]))[key]?.locked)
      return c.body(null, 204, { "Content-Length": "0" });
    return c.text("Not Found", 404);
  }
  if (target.kind === "directory")
    return c.text("Collection", 405, { Allow: ALLOW });
  const metadata = target.object;
  if (!metadata) return c.text("Not Found", 404);

  const range = c.req.method === "GET" ? c.req.header("range") : undefined;
  const ifMatch = c.req.header("if-match");
  if (
    ifMatch &&
    ifMatch.trim() !== "*" &&
    !ifMatch
      .split(",")
      .some((candidate) => candidate.trim() === metadata.httpEtag)
  )
    return c.body(null, 412);
  const ifUnmodifiedSince = c.req.header("if-unmodified-since");
  if (
    ifUnmodifiedSince &&
    Math.floor(metadata.uploaded.getTime() / 1000) >
      Math.floor(new Date(ifUnmodifiedSince).getTime() / 1000)
  )
    return c.body(null, 412, { ETag: metadata.httpEtag });
  if (
    fresh(
      {
        "if-none-match": c.req.header("if-none-match") ?? "",
        "if-modified-since": c.req.header("if-modified-since") ?? "",
        "cache-control": c.req.header("cache-control") ?? "",
      },
      {
        etag: metadata.httpEtag,
        "last-modified": metadata.uploaded.toUTCString(),
      },
    )
  )
    return c.body(null, 304, { ETag: metadata.httpEtag });

  const object = await filesystem.read(
    key,
    range ? { range: c.req.raw.headers } : undefined,
  );
  if (!object) return c.text("Not Found", 404);
  const requestedRange = c.req.header("range")?.match(/^bytes=(\d+)-/);
  if (requestedRange && Number(requestedRange[1]) >= object.size)
    return c.body(null, 416, { "Content-Range": `bytes */${object.size}` });
  const objectRange = range
    ? (object.range as { offset: number; length: number })
    : undefined;
  if (objectRange && objectRange.offset >= object.size)
    return c.body(null, 416, { "Content-Range": `bytes */${object.size}` });
  const headers = new Headers({
    "Accept-Ranges": "bytes",
    "Content-Length": String(objectRange?.length ?? object.size),
    ETag: metadata.httpEtag,
    "Last-Modified": metadata.uploaded.toUTCString(),
  });
  object.writeHttpMetadata(headers);
  if (objectRange)
    headers.set(
      "Content-Range",
      `bytes ${objectRange.offset}-${objectRange.offset + objectRange.length - 1}/${object.size}`,
    );
  if (c.req.method === "HEAD")
    return c.body(null, { status: objectRange ? 206 : 200, headers });
  return c.body(object.body, { status: objectRange ? 206 : 200, headers });
});

app.put("*", async (c) => {
  const filesystem = c.get("filesystem");
  const key = c.get("key");
  if (!key) return c.text("Collection", 405, { Allow: ALLOW });
  const existing = await filesystem.stat(key);
  if (existing?.kind === "directory")
    return c.text("Collection exists", 405, { Allow: ALLOW });
  const ifHeader = c.req.header("if");
  if (ifHeader) {
    const existingEtag = existing?.object?.httpEtag;
    const matchesIfList = (list: string) =>
      [...list.matchAll(/(Not\s+)?\[([^\]]+)\]/gi)].every(
        ([, negated, value]) =>
          negated ? value !== existingEtag : value === existingEtag,
      );
    const matchesIfHeader = (ifHeader.match(/\([^)]*\)/g) ?? []).some(
      matchesIfList,
    );
    if (!matchesIfHeader) return c.body(null, 412);
  }

  let object: Entry;
  try {
    object = await filesystem.write(key, c.req.raw.body ?? "", {
      httpMetadata: c.req.raw.headers,
      onlyIf: c.req.raw.headers,
    });
  } catch (error) {
    if (ifHeader && error instanceof FileSystemError && error.code === "locked")
      return c.body(null, 412);
    throw error;
  }
  return c.body(null, existing ? 204 : 201, {
    ...(existing ? {} : { Location: c.req.url }),
    ETag: object.object!.httpEtag,
    "Last-Modified": object.object!.uploaded.toUTCString(),
  });
});

app.on("MKCOL", "*", async (c) => {
  const key = c.get("key");
  if (!key) return c.text("Collection exists", 405, { Allow: ALLOW });
  if (c.req.raw.body && (await c.req.raw.arrayBuffer()).byteLength)
    return c.text("MKCOL body is not supported", 415);
  const object = await c.get("filesystem").mkdir(key);
  return c.body(null, 201, {
    Location: c.req.url,
    ETag: object.object!.httpEtag,
  });
});

app.delete("*", async (c) => {
  const key = c.get("key");
  if (!key) return c.text("Cannot delete root collection", 403);
  await c.get("filesystem").remove(key);
  return c.body(null, 204);
});

app.on(["COPY", "MOVE"], "*", async (c) => {
  const filesystem = c.get("filesystem");
  const sourceKey = c.get("key");
  const destination = c.req.header("destination");
  if (!sourceKey || !destination)
    return c.text("Invalid Destination header", 400);
  const requestUrl = new URL(c.req.url);
  let destinationUrl: URL;
  try {
    destinationUrl = new URL(destination, requestUrl);
    if (destinationUrl.origin !== requestUrl.origin)
      return c.text("Cross-origin destinations are not supported", 502);
  } catch {
    return c.text("Invalid Destination header", 400);
  }
  let destinationKey: string;
  try {
    destinationKey = decodeURIComponent(destinationUrl.pathname).replace(
      /^\/+|\/+$/g,
      "",
    );
  } catch {
    return c.text("Invalid Destination header", 400);
  }
  if (!destinationKey) return c.text("Invalid destination", 403);
  const source = await filesystem.stat(sourceKey);
  if (!source) return c.text("Not Found", 404);
  const depth = (c.req.header("depth") ?? "infinity").toLowerCase();
  const isMove = c.req.method === "MOVE";
  if (
    source.kind === "directory" &&
    depth !== "infinity" &&
    (depth !== "0" || isMove)
  )
    return c.text("Invalid Depth header", 400);
  const overwriteHeader = (c.req.header("overwrite") ?? "T").toUpperCase();
  if (overwriteHeader !== "T" && overwriteHeader !== "F")
    return c.text("Invalid Overwrite header", 400);
  const existing = await filesystem.stat(destinationKey);
  const overwrite = overwriteHeader === "T";
  if (existing && !overwrite) return c.text("Destination exists", 412);
  if (isMove) {
    await filesystem.move(sourceKey, destinationKey, { overwrite });
  } else {
    await filesystem.copy(sourceKey, destinationKey, {
      recursive: source.kind === "directory" && depth !== "0",
      overwrite,
    });
  }
  return c.body(
    null,
    existing ? 204 : 201,
    existing ? undefined : { Location: destinationUrl.toString() },
  );
});

app.on("LOCK", "*", async (c) => {
  const filesystem = c.get("filesystem");
  const key = c.get("key");
  const target = await filesystem.stat(key);
  const timeoutHeader =
    c.req.header("timeout")?.split(",")[0].trim() ?? "Infinite";
  let seconds: number | undefined;
  if (timeoutHeader !== "Infinite") {
    const match = /^Second-(\d+)$/.exec(timeoutHeader);
    if (!match) return c.text("Invalid Timeout header", 400);
    seconds = Number(match[1]);
  }
  const depthHeader = (c.req.header("depth") ?? "infinity").toLowerCase();
  if (depthHeader !== "0" && depthHeader !== "infinity")
    return c.text("Invalid Depth header", 400);
  const body = c.req.raw.body ? await c.req.text() : "";
  const token = c.req.header("if")?.match(/<([^>]+)>/)?.[1];
  if (!body && !token) return c.text("Lock body is required", 400);
  if (body && XMLValidator.validate(body) !== true)
    return c.text("Invalid XML", 400);
  const lockinfo = body && xmlParser.parse(body);
  const lockscope =
    lockinfo?.["D:lockinfo"]?.["D:lockscope"] ?? lockinfo?.lockinfo?.lockscope;
  let scope: Lock["scope"] = "exclusive";
  if (lockscope?.["D:shared"] !== undefined || lockscope?.shared !== undefined)
    scope = "shared";
  const owner =
    lockinfo?.["D:lockinfo"]?.["D:owner"] ?? lockinfo?.lockinfo?.owner;
  const lock = await filesystem.webdav.lock(
    key,
    token
      ? {
          kind: "refresh",
          token,
          ...(seconds === undefined ? {} : { expiresInSeconds: seconds }),
        }
      : {
          kind: "create",
          scope,
          depth: depthHeader,
          ...(seconds === undefined ? {} : { expiresInSeconds: seconds }),
        },
  );
  return c.body(
    xmlBuilder.build({
      "?xml": { "@_version": "1.0", "@_encoding": "utf-8" },
      "D:prop": {
        "@_xmlns:D": "DAV:",
        "D:lockdiscovery": {
          "D:activelock": {
            "D:lockscope": { [`D:${lock.scope}`]: "" },
            "D:locktype": { "D:write": "" },
            "D:depth": lock.depth,
            "D:timeout": timeoutHeader,
            ...(owner === undefined ? {} : { "D:owner": owner }),
            "D:locktoken": { "D:href": lock.token },
          },
        },
      },
    }),
    target ? 200 : 201,
    {
      "Content-Type": "application/xml; charset=utf-8",
      ...(token ? {} : { "Lock-Token": `<${lock.token}>` }),
      Timeout: timeoutHeader,
    },
  );
});

app.on("UNLOCK", "*", async (c) => {
  const token = c.req.header("lock-token")?.match(/^<([^>]+)>$/)?.[1];
  if (!token) return c.text("Lock token does not match", 400);
  await c.get("filesystem").webdav.unlock(c.get("key"), token);
  return c.body(null, 204);
});

app.all("*", (c) => c.text("Method Not Allowed", 405, { Allow: ALLOW }));

export default app;
