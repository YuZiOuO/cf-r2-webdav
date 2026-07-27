import { basicAuth } from "hono/basic-auth";
import { Hono } from "hono";
import XMLBuilder from "fast-xml-builder";

const DIRECTORY_MARKER = ".webdav-directory";
const DIRECTORY_SUFFIX = `/${DIRECTORY_MARKER}`;
const ALLOW = "OPTIONS, PROPFIND, GET, HEAD, PUT, DELETE, MKCOL";
const xmlBuilder = new XMLBuilder({
	attributeNamePrefix: "@_",
	ignoreAttributes: false,
	suppressEmptyNode: true,
});

async function listObjects(bucket: R2Bucket, prefix: string, delimiter?: string) {
	const objects: R2Object[] = [];
	const prefixes: string[] = [];
	let cursor: string | undefined;

	do {
		const page = await bucket.list({ prefix, delimiter, cursor });
		objects.push(...page.objects);
		prefixes.push(...page.delimitedPrefixes);
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor);

	return { objects, prefixes };
}

async function resource(bucket: R2Bucket, key: string) {
	if (!key) return { key, directory: true };

	const object = await bucket.head(key);
	if (object) return { key, directory: false, object };

	const listing = await bucket.list({ prefix: `${key}/`, limit: 1 });
	return listing.objects.length
		? { key, directory: true }
		: null;
}

const app = new Hono<{
	Bindings: CloudflareBindings & { WEBDAV_USERNAME: string; WEBDAV_PASSWORD: string };
	Variables: { key: string };
}>();

app.use("*", (c, next) =>
	basicAuth({
		username: c.env.WEBDAV_USERNAME,
		password: c.env.WEBDAV_PASSWORD,
		realm: "R2 WebDAV",
	})(c, next),
);

app.use("*", async (c, next) => {
	try {
		const key = decodeURIComponent(c.req.path).replace(/^\/+|\/+$/g, "");
		if (key.split("/").includes(DIRECTORY_MARKER)) return c.text("Not Found", 404);
		c.set("key", key);
	} catch {
		return c.text("Invalid path", 400);
	}
	await next();
});

app.options("*", (c) => c.body(null, 204, { Allow: ALLOW, DAV: "1" }));

app.on("PROPFIND", "*", async (c) => {
	const key = c.get("key");
	const target = await resource(c.env.BUCKET, key);
	if (!target) return c.text("Resource not found", 404);

	const depth = c.req.header("depth") ?? "1";
	if (depth.toLowerCase() === "infinity") {
		return c.body('<D:error xmlns:D="DAV:"><D:propfind-finite-depth/></D:error>', 403, {
			"Content-Type": "application/xml; charset=utf-8",
		});
	}
	if (depth !== "0" && depth !== "1") return c.text("Invalid Depth header", 400);

	const resources = [target];
	if (target.directory && depth === "1") {
		const listing = await listObjects(c.env.BUCKET, key ? `${key}/` : "", "/");
		for (const value of listing.prefixes) resources.push({ key: value.slice(0, -1), directory: true });
		for (const object of listing.objects) {
			if (!object.key.endsWith(DIRECTORY_SUFFIX)) resources.push({ key: object.key, directory: false, object });
		}
	}

	const responses = resources.map((item) => {
		const object = item.object;
		const name = item.key.split("/").pop() || "/";
		const href = item.key ? `/${item.key.split("/").map(encodeURIComponent).join("/")}${item.directory ? "/" : ""}` : "/";
		return {
			"D:href": href,
			"D:propstat": {
				"D:prop": {
					"D:displayname": name,
					"D:getcontentlength": item.directory ? 0 : object?.size ?? 0,
					"D:getlastmodified": (object?.uploaded ?? new Date(0)).toUTCString(),
					...(object ? { "D:getetag": object.httpEtag } : {}),
					"D:resourcetype": item.directory ? { "D:collection": "" } : "",
					...(item.directory ? {} : { "D:getcontenttype": object?.httpMetadata?.contentType ?? "application/octet-stream" }),
				},
				"D:status": "HTTP/1.1 200 OK",
			},
		};
	});
	return c.body(xmlBuilder.build({
		"?xml": { "@_version": "1.0", "@_encoding": "utf-8" },
		"D:multistatus": { "@_xmlns:D": "DAV:", "D:response": responses },
	}), 207, { Allow: ALLOW, DAV: "1", "Content-Type": "application/xml; charset=utf-8" });
});

app.get("*", async (c) => {
	const key = c.get("key");
	if (!key) return c.text("Collection", 405, { Allow: ALLOW });

	const object = await c.env.BUCKET.get(key, { range: c.req.raw.headers });
	if (!object) return c.text("Not Found", 404);
	const objectRange = object.range as { offset: number; length: number } | undefined;
	const headers = new Headers({
		"Accept-Ranges": "bytes",
		"Content-Length": String(objectRange?.length ?? object.size),
		ETag: object.httpEtag,
		"Last-Modified": object.uploaded.toUTCString(),
	});
	object.writeHttpMetadata(headers);
	if (objectRange) headers.set("Content-Range", `bytes ${objectRange.offset}-${objectRange.offset + objectRange.length - 1}/${object.size}`);
	return c.body(object.body, { status: objectRange ? 206 : 200, headers });
});

app.put("*", async (c) => {
	const key = c.get("key");
	if (!key) return c.text("Collection", 405, { Allow: ALLOW });
	if ((await resource(c.env.BUCKET, key.substring(0, key.lastIndexOf("/"))))?.directory !== true) {
		return c.text("Parent collection not found", 409);
	}
	const existing = await resource(c.env.BUCKET, key);
	if (existing?.directory) return c.text("Collection exists", 405, { Allow: ALLOW });
	await c.env.BUCKET.put(key, c.req.raw.body ?? "", { httpMetadata: c.req.raw.headers });
	return c.body(null, existing ? 204 : 201);
});

app.on("MKCOL", "*", async (c) => {
	const key = c.get("key");
	if (!key || await resource(c.env.BUCKET, key)) return c.text("Collection exists", 405, { Allow: ALLOW });
	if ((await resource(c.env.BUCKET, key.substring(0, key.lastIndexOf("/"))))?.directory !== true) {
		return c.text("Parent collection not found", 409);
	}
	if (c.req.raw.body && (await c.req.raw.arrayBuffer()).byteLength) return c.text("MKCOL body is not supported", 415);
	await c.env.BUCKET.put(`${key}${DIRECTORY_SUFFIX}`, "", { httpMetadata: { contentType: "application/x-webdav-directory" } });
	return c.body(null, 201);
});

app.delete("*", async (c) => {
	const key = c.get("key");
	if (!key) return c.text("Cannot delete root collection", 403);
	const target = await resource(c.env.BUCKET, key);
	if (!target) return c.text("Not Found", 404);
	if (target.directory) {
		const listing = await listObjects(c.env.BUCKET, `${key}/`);
		for (let index = 0; index < listing.objects.length; index += 1000) {
			await c.env.BUCKET.delete(listing.objects.slice(index, index + 1000).map((object) => object.key));
		}
	} else {
		await c.env.BUCKET.delete(key);
	}
	return c.body(null, 204);
});

app.all("*", (c) => c.text("Method Not Allowed", 405, { Allow: ALLOW }));

export default app;
