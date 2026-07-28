import { SELF } from "cloudflare:test";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { describe, expect, it } from "vitest";

const authorization = `Basic ${btoa("test-user:test-password")}`;
const dav = { "Content-Type": "application/xml; charset=utf-8" };

function request(path: string, init: RequestInit = {}) {
	const headers = new Headers(init.headers);
	headers.set("Authorization", authorization);
	return SELF.fetch(new Request(`https://webdav.test${path}`, { ...init, headers }));
}

async function xml(response: Response) {
	const body = await response.text();
	expect(XMLValidator.validate(body)).toBe(true);
	const document = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true }).parse(body);
	return { body, document };
}

async function put(path: string, body = "content", headers?: HeadersInit) {
	return request(path, { method: "PUT", body, headers });
}

describe("RFC 7617 Basic authentication", () => {
	it("challenges an unauthenticated request", async () => {
		const response = await SELF.fetch("https://webdav.test/");
		expect(response.status).toBe(401);
		expect(response.headers.get("WWW-Authenticate")).toMatch(/^Basic(?:\s|$)/i);
	});
});

describe("RFC 4918 section 9 and RFC 9110 HTTP semantics", () => {
	it("advertises Class 2 WebDAV support and all required methods", async () => {
		const response = await request("/", { method: "OPTIONS" });
		expect(response.status).toBe(204);
		expect(response.headers.get("DAV")?.split(",").map((value: string) => value.trim())).toEqual(expect.arrayContaining(["1", "2"]));
		expect(response.headers.get("Allow")).toEqual(expect.stringContaining("PROPPATCH"));
		expect(response.headers.get("Allow")).toEqual(expect.stringContaining("LOCK"));
		expect(response.headers.get("Allow")).toEqual(expect.stringContaining("UNLOCK"));
	});

	it("creates, replaces, reads, heads, ranges, and deletes a resource", async () => {
		expect((await put("/document.txt", "first")).status).toBe(201);
		const created = await request("/document.txt");
		expect(created.status).toBe(200);
		expect(await created.text()).toBe("first");
		expect(created.headers.get("ETag")).toBeTruthy();
		expect(created.headers.get("Last-Modified")).toBeTruthy();

		const head = await request("/document.txt", { method: "HEAD" });
		expect(head.status).toBe(200);
		expect(await head.text()).toBe("");

		const range = await request("/document.txt", { headers: { Range: "bytes=1-3" } });
		expect(range.status).toBe(206);
		expect(range.headers.get("Content-Range")).toBe("bytes 1-3/5");
		expect(await range.text()).toBe("irs");

		expect((await put("/document.txt", "second")).status).toBe(204);
		expect((await request("/document.txt", { method: "DELETE" })).status).toBe(204);
		expect((await request("/document.txt")).status).toBe(404);
	});

	it("evaluates HTTP preconditions before applying a state-changing request", async () => {
		await put("/conditional.txt", "before");
		const etag = (await request("/conditional.txt")).headers.get("ETag");
		expect(etag).toBeTruthy();

		expect((await put("/conditional.txt", "after", { "If-Match": '"different"' })).status).toBe(412);
		expect(await (await request("/conditional.txt")).text()).toBe("before");
		expect((await put("/conditional.txt", "after", { "If-Match": etag! })).status).toBe(204);
		expect((await put("/conditional.txt", "again", { "If-None-Match": "*" })).status).toBe(412);
	});

	it("creates collections only when the target and parent allow it", async () => {
		expect((await request("/collection", { method: "MKCOL" })).status).toBe(201);
		expect((await request("/collection", { method: "MKCOL" })).status).toBe(405);
		expect((await request("/missing/child", { method: "MKCOL" })).status).toBe(409);
		expect((await request("/body", { method: "MKCOL", body: "unsupported" })).status).toBe(415);
	});
});

describe("RFC 4918 section 9.1 PROPFIND", () => {
	it("returns allprop for an empty request body", async () => {
		await put("/properties.txt", "body");
		const response = await request("/properties.txt", { method: "PROPFIND", headers: { Depth: "0" } });
		expect(response.status).toBe(207);
		expect(response.headers.get("Content-Type")).toMatch(/application\/xml/i);
		const responseXml = await xml(response);
		expect(responseXml.document.multistatus).toBeTruthy();
		expect(JSON.stringify(responseXml.document)).toContain("getetag");
		expect(JSON.stringify(responseXml.document)).toContain("getcontentlength");
	});

	it("returns property names without values for propname", async () => {
		await put("/names.txt", "body");
		const response = await request("/names.txt", {
			method: "PROPFIND",
			headers: { ...dav, Depth: "0" },
			body: '<D:propfind xmlns:D="DAV:"><D:propname/></D:propfind>',
		});
		expect(response.status).toBe(207);
		const responseXml = await xml(response);
		expect(JSON.stringify(responseXml.document)).toContain("getetag");
		expect(responseXml.body).toMatch(/<(?:[A-Za-z][\w.-]*:)?getetag\s*\/>|<(?:[A-Za-z][\w.-]*:)?getetag\s*>\s*<\/(?:[A-Za-z][\w.-]*:)?getetag\s*>/);
	});

	it("reports requested existing and missing properties in separate propstat elements", async () => {
		await put("/selected.txt", "body");
		const response = await request("/selected.txt", {
			method: "PROPFIND",
			headers: { ...dav, Depth: "0" },
			body: '<D:propfind xmlns:D="DAV:" xmlns:X="urn:test"><D:prop><D:getetag/><X:missing/></D:prop></D:propfind>',
		});
		expect(response.status).toBe(207);
		const responseXml = await xml(response);
		expect(responseXml.body).toContain("HTTP/1.1 200 OK");
		expect(responseXml.body).toContain("HTTP/1.1 404 Not Found");
	});

	it("returns every immediate member for Depth: 1", async () => {
		await request("/folder", { method: "MKCOL" });
		await put("/folder/child.txt");
		const response = await request("/folder", { method: "PROPFIND", headers: { Depth: "1" } });
		expect(response.status).toBe(207);
		expect(await response.text()).toContain("/folder/child.txt");
	});

	it("handles Depth: infinity using one of RFC 4918's permitted outcomes", async () => {
		await request("/tree", { method: "MKCOL" });
		await request("/tree/child", { method: "MKCOL" });
		const response = await request("/tree", { method: "PROPFIND", headers: { Depth: "infinity" } });
		if (response.status === 207) {
			expect((await xml(response)).body).toContain("/tree/child/");
			return;
		}
		expect(response.status).toBe(403);
		expect(await response.text()).toContain("propfind-finite-depth");
	});
});

describe("RFC 4918 section 9.2 PROPPATCH", () => {
	it("sets, returns, and removes a dead property", async () => {
		await put("/dead-property.txt");
		const set = await request("/dead-property.txt", {
			method: "PROPPATCH",
			headers: dav,
			body: '<D:propertyupdate xmlns:D="DAV:" xmlns:X="urn:test"><D:set><D:prop><X:color>blue</X:color></D:prop></D:set></D:propertyupdate>',
		});
		expect(set.status).toBe(207);

		const found = await request("/dead-property.txt", {
			method: "PROPFIND",
			headers: { ...dav, Depth: "0" },
			body: '<D:propfind xmlns:D="DAV:" xmlns:X="urn:test"><D:prop><X:color/></D:prop></D:propfind>',
		});
		expect(await found.text()).toContain("blue");

		const remove = await request("/dead-property.txt", {
			method: "PROPPATCH",
			headers: dav,
			body: '<D:propertyupdate xmlns:D="DAV:" xmlns:X="urn:test"><D:remove><D:prop><X:color/></D:prop></D:remove></D:propertyupdate>',
		});
		expect(remove.status).toBe(207);
	});

	it("applies instructions atomically when one property update fails", async () => {
		await put("/atomic.txt");
		const response = await request("/atomic.txt", {
			method: "PROPPATCH",
			headers: dav,
			body: '<D:propertyupdate xmlns:D="DAV:" xmlns:X="urn:test"><D:set><D:prop><X:kept>no</X:kept><D:getetag>forbidden</D:getetag></D:prop></D:set></D:propertyupdate>',
		});
		expect(response.status).toBe(207);
		expect(await response.text()).toContain("424 Failed Dependency");

		const check = await request("/atomic.txt", {
			method: "PROPFIND",
			headers: { ...dav, Depth: "0" },
			body: '<D:propfind xmlns:D="DAV:" xmlns:X="urn:test"><D:prop><X:kept/></D:prop></D:propfind>',
		});
		expect(await check.text()).toContain("404 Not Found");
	});
});

describe("RFC 4918 sections 9.8 and 9.9 COPY and MOVE", () => {
	it("copies and moves resources with Destination and Overwrite semantics", async () => {
		await put("/source.txt", "source");
		expect((await request("/source.txt", { method: "COPY", headers: { Destination: "https://webdav.test/copy.txt", Overwrite: "F" } })).status).toBe(201);
		expect(await (await request("/copy.txt")).text()).toBe("source");
		expect((await request("/source.txt", { method: "COPY", headers: { Destination: "https://webdav.test/copy.txt", Overwrite: "F" } })).status).toBe(412);
		expect((await request("/copy.txt", { method: "MOVE", headers: { Destination: "https://webdav.test/moved.txt" } })).status).toBe(201);
		expect((await request("/copy.txt")).status).toBe(404);
		expect(await (await request("/moved.txt")).text()).toBe("source");
	});

	it("copies collections at Depth: 0 and infinity without copying into a descendant", async () => {
		await request("/source", { method: "MKCOL" });
		await put("/source/file.txt", "child");
		expect((await request("/source", { method: "COPY", headers: { Destination: "https://webdav.test/shallow", Depth: "0" } })).status).toBe(201);
		expect((await request("/shallow/file.txt")).status).toBe(404);
		expect((await request("/source", { method: "COPY", headers: { Destination: "https://webdav.test/deep", Depth: "infinity" } })).status).toBe(201);
		expect(await (await request("/deep/file.txt")).text()).toBe("child");
		expect((await request("/source", { method: "COPY", headers: { Destination: "https://webdav.test/source/child" } })).status).toBe(403);
	});
});

describe("RFC 4918 sections 9.10 and 9.11 locking", () => {
	it("creates an exclusive lock, reports it, and requires its token for PUT", async () => {
		await put("/locked.txt", "before");
		const lock = await request("/locked.txt", {
			method: "LOCK",
			headers: { ...dav, Timeout: "Second-3600" },
			body: '<D:lockinfo xmlns:D="DAV:"><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype><D:owner>test</D:owner></D:lockinfo>',
		});
		expect(lock.status).toBe(200);
		const token = lock.headers.get("Lock-Token");
		expect(token).toMatch(/^<[^>]+>$/);
		expect(lock.headers.get("Timeout")).toMatch(/^(Second-\d+|Infinite)$/);
		expect((await xml(lock)).body).toContain("lockdiscovery");

		expect((await put("/locked.txt", "blocked")).status).toBe(423);
		expect((await put("/locked.txt", "allowed", { If: `(${token})` })).status).toBe(204);
	});

	it("refreshes and unlocks using the submitted lock token", async () => {
		await put("/refresh.txt");
		const lock = await request("/refresh.txt", {
			method: "LOCK",
			headers: dav,
			body: '<D:lockinfo xmlns:D="DAV:"><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype></D:lockinfo>',
		});
		const token = lock.headers.get("Lock-Token");
		expect(token).toBeTruthy();
		expect((await request("/refresh.txt", { method: "LOCK", headers: { If: `(${token})`, Timeout: "Second-60" } })).status).toBe(200);
		expect((await request("/refresh.txt", { method: "UNLOCK", headers: { "Lock-Token": token! } })).status).toBe(204);
		expect((await put("/refresh.txt", "unlocked")).status).toBe(204);
	});

	it("allows shared locks but rejects an incompatible exclusive lock", async () => {
		await put("/shared.txt");
		const body = '<D:lockinfo xmlns:D="DAV:"><D:lockscope><D:shared/></D:lockscope><D:locktype><D:write/></D:locktype></D:lockinfo>';
		expect((await request("/shared.txt", { method: "LOCK", headers: dav, body })).status).toBe(200);
		expect((await request("/shared.txt", { method: "LOCK", headers: dav, body })).status).toBe(200);
		expect((await request("/shared.txt", { method: "LOCK", headers: dav, body: body.replace("shared", "exclusive") })).status).toBe(423);
	});

	it("creates and exposes a lock-null resource", async () => {
		const lock = await request("/lock-null.txt", {
			method: "LOCK",
			headers: dav,
			body: '<D:lockinfo xmlns:D="DAV:"><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype></D:lockinfo>',
		});
		expect(lock.status).toBe(201);
		const token = lock.headers.get("Lock-Token");
		expect(token).toBeTruthy();
		const propfind = await request("/lock-null.txt", { method: "PROPFIND", headers: { Depth: "0" } });
		expect(propfind.status).toBe(207);
		expect(await propfind.text()).toContain("lockdiscovery");
		expect((await put("/lock-null.txt", "created", { If: `(${token})` })).status).toBe(201);
	});
});
