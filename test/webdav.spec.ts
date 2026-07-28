import { SELF } from "cloudflare:test";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { describe, expect, it } from "vitest";

const authorization = `Basic ${btoa("test-user:test-password")}`;
const dav = { "Content-Type": "application/xml; charset=utf-8" };

function request(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("Authorization", authorization);
  return SELF.fetch(
    new Request(`https://webdav.test${path}`, { ...init, headers }),
  );
}

async function xml(response: Response) {
  const body = await response.text();
  expect(XMLValidator.validate(body)).toBe(true);
  const document = new XMLParser({ removeNSPrefix: true }).parse(body);
  return { body, document };
}

async function put(path: string, body = "content", headers?: HeadersInit) {
  return request(path, { method: "PUT", body, headers });
}

describe("RFC 7617 Basic authentication", () => {
  it("challenges an unauthenticated request", async () => {
    const response = await SELF.fetch("https://webdav.test/");
    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toMatch(
      /^Basic\s+realm=/i,
    );
  });

  it("rejects invalid credentials with another challenge", async () => {
    const response = await SELF.fetch("https://webdav.test/", {
      headers: { Authorization: `Basic ${btoa("test-user:wrong-password")}` },
    });
    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toMatch(
      /^Basic\s+realm=/i,
    );
  });
});

describe("RFC 4918 section 9 and RFC 9110 HTTP semantics", () => {
  it("advertises Class 2 WebDAV support and all required methods", async () => {
    const response = await request("/", { method: "OPTIONS" });
    expect(response.status).toBe(204);
    expect(
      response.headers
        .get("DAV")
        ?.split(",")
        .map((value: string) => value.trim()),
    ).toEqual(expect.arrayContaining(["1", "2"]));
    expect(response.headers.get("Allow")?.split(", ")).toEqual(
      expect.arrayContaining([
        "OPTIONS",
        "PROPFIND",
        "PROPPATCH",
        "GET",
        "HEAD",
        "PUT",
        "DELETE",
        "MKCOL",
        "COPY",
        "MOVE",
        "LOCK",
        "UNLOCK",
      ]),
    );
  });

  it("returns Allow when a method is not allowed", async () => {
    const response = await request("/", { method: "TRACE" });
    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toContain("PROPFIND");
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

    const range = await request("/document.txt", {
      headers: { Range: "bytes=1-3" },
    });
    expect(range.status).toBe(206);
    expect(range.headers.get("Content-Range")).toBe("bytes 1-3/5");
    expect(await range.text()).toBe("irs");

    expect((await put("/document.txt", "second")).status).toBe(204);
    expect((await request("/document.txt", { method: "DELETE" })).status).toBe(
      204,
    );
    expect((await request("/document.txt")).status).toBe(404);
  });

  it("evaluates HTTP preconditions before applying a state-changing request", async () => {
    await put("/conditional.txt", "before");
    const etag = (await request("/conditional.txt")).headers.get("ETag");
    expect(etag).toBeTruthy();

    expect(
      (await put("/conditional.txt", "after", { "If-Match": '"different"' }))
        .status,
    ).toBe(412);
    expect(await (await request("/conditional.txt")).text()).toBe("before");
    expect(
      (await put("/conditional.txt", "after", { "If-Match": etag! })).status,
    ).toBe(204);
    expect(
      (await put("/conditional.txt", "again", { "If-None-Match": "*" })).status,
    ).toBe(412);
  });

  it("evaluates representation validators on GET and creates conditionally", async () => {
    await put("/get-conditional.txt", "before");
    const current = await request("/get-conditional.txt");
    const etag = current.headers.get("ETag");
    const modified = current.headers.get("Last-Modified");
    expect(etag).toBeTruthy();
    expect(modified).toBeTruthy();

    expect(
      (
        await request("/get-conditional.txt", {
          headers: { "If-None-Match": etag! },
        })
      ).status,
    ).toBe(304);
    expect(
      (
        await request("/get-conditional.txt", {
          headers: { "If-Match": '"different"' },
        })
      ).status,
    ).toBe(412);
    expect(
      (
        await request("/get-conditional.txt", {
          headers: { "If-Modified-Since": modified! },
        })
      ).status,
    ).toBe(304);
    expect(
      (
        await request("/get-conditional.txt", {
          headers: { "If-Unmodified-Since": "Thu, 01 Jan 1970 00:00:00 GMT" },
        })
      ).status,
    ).toBe(412);
    expect(
      (
        await put("/missing-conditional.txt", "created", {
          "If-Match": "*",
        })
      ).status,
    ).toBe(412);
    expect(
      (
        await put("/new-conditional.txt", "created", {
          "If-None-Match": "*",
        })
      ).status,
    ).toBe(201);
  });

  it("supports suffix and open-ended ranges and handles unsatisfied ranges", async () => {
    await put("/range-forms.txt", "0123456789");
    const suffix = await request("/range-forms.txt", {
      headers: { Range: "bytes=-3" },
    });
    expect(suffix.status).toBe(206);
    expect(await suffix.text()).toBe("789");

    const openEnded = await request("/range-forms.txt", {
      headers: { Range: "bytes=7-" },
    });
    expect(openEnded.status).toBe(206);
    expect(await openEnded.text()).toBe("789");

    const unsatisfied = await request("/range-forms.txt", {
      headers: { Range: "bytes=99-" },
    });
    expect([200, 416]).toContain(unsatisfied.status);
    if (unsatisfied.status === 416)
      expect(unsatisfied.headers.get("Content-Range")).toBe("bytes */10");
  });

  it("keeps HEAD metadata equivalent to GET without sending content", async () => {
    await put("/head-metadata.txt", "body", { "Content-Type": "text/plain" });
    const get = await request("/head-metadata.txt");
    const head = await request("/head-metadata.txt", { method: "HEAD" });
    expect(head.status).toBe(get.status);
    expect(await head.text()).toBe("");
    for (const header of [
      "Accept-Ranges",
      "Content-Length",
      "Content-Type",
      "ETag",
      "Last-Modified",
    ])
      expect(head.headers.get(header)).toBe(get.headers.get(header));

    const rangedHead = await request("/head-metadata.txt", {
      method: "HEAD",
      headers: { Range: "bytes=0-1" },
    });
    expect(rangedHead.status).not.toBe(206);
    expect(await rangedHead.text()).toBe("");
  });

  it("creates collections only when the target and parent allow it", async () => {
    expect((await request("/collection", { method: "MKCOL" })).status).toBe(
      201,
    );
    expect((await request("/collection", { method: "MKCOL" })).status).toBe(
      405,
    );
    expect((await request("/missing/child", { method: "MKCOL" })).status).toBe(
      409,
    );
    expect(
      (await request("/body", { method: "MKCOL", body: "unsupported" })).status,
    ).toBe(415);
  });

  it("creates empty collections and zero-length resources with metadata", async () => {
    const collection = await request("/empty-collection/", {
      method: "MKCOL",
    });
    expect(collection.status).toBe(201);
    expect(collection.headers.get("Location")).toContain("/empty-collection/");
    const listing = await request("/empty-collection/", {
      method: "PROPFIND",
      headers: { Depth: "1" },
    });
    expect(listing.status).toBe(207);
    const listingXml = await xml(listing);
    expect(listingXml.body).not.toContain("empty-collection/child");

    const file = await put("/empty-resource.txt", "");
    expect(file.status).toBe(201);
    const response = await request("/empty-resource.txt");
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Length")).toBe("0");
    expect(await response.text()).toBe("");
  });
});

describe("RFC 4918 section 9.1 PROPFIND", () => {
  it("returns allprop for an empty request body", async () => {
    await put("/properties.txt", "body");
    const response = await request("/properties.txt", {
      method: "PROPFIND",
      headers: { Depth: "0" },
    });
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
    expect(responseXml.body).toMatch(
      /<(?:[A-Za-z][\w.-]*:)?getetag\s*\/>|<(?:[A-Za-z][\w.-]*:)?getetag\s*>\s*<\/(?:[A-Za-z][\w.-]*:)?getetag\s*>/,
    );
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
    const response = await request("/folder", {
      method: "PROPFIND",
      headers: { Depth: "1" },
    });
    expect(response.status).toBe(207);
    expect(await response.text()).toContain("/folder/child.txt");
  });

  it("handles Depth: infinity using one of RFC 4918's permitted outcomes", async () => {
    await request("/tree", { method: "MKCOL" });
    await request("/tree/child", { method: "MKCOL" });
    const response = await request("/tree", {
      method: "PROPFIND",
      headers: { Depth: "infinity" },
    });
    if (response.status === 207) {
      expect((await xml(response)).body).toContain("/tree/child/");
      return;
    }
    expect(response.status).toBe(403);
    expect(await response.text()).toContain("propfind-finite-depth");
  });

  it("supports allprop include, XML media types, and rejects malformed XML", async () => {
    await put("/propfind-include.txt");
    await request("/propfind-include.txt", {
      method: "PROPPATCH",
      headers: dav,
      body: '<D:propertyupdate xmlns:D="DAV:" xmlns:X="urn:test"><D:set><D:prop><X:color>blue</X:color></D:prop></D:set></D:propertyupdate>',
    });

    const included = await request("/propfind-include.txt", {
      method: "PROPFIND",
      headers: { ...dav, Depth: "0" },
      body: '<D:propfind xmlns:D="DAV:" xmlns:X="urn:test"><D:allprop><D:include><X:color/></D:include></D:allprop></D:propfind>',
    });
    expect(included.status).toBe(207);
    expect(await included.text()).toContain("blue");

    const textXml = await request("/propfind-include.txt", {
      method: "PROPFIND",
      headers: { "Content-Type": "text/xml", Depth: "0" },
      body: '<D:propfind xmlns:D="DAV:"><D:propname/></D:propfind>',
    });
    expect(textXml.status).toBe(207);

    const malformed = await request("/propfind-include.txt", {
      method: "PROPFIND",
      headers: { ...dav, Depth: "0" },
      body: '<D:propfind xmlns:D="DAV:">',
    });
    expect(malformed.status).toBe(400);
  });

  it("returns collection members, required live properties, and encoded hrefs", async () => {
    await request("/encoded%20folder", { method: "MKCOL" });
    await put("/encoded%20folder/file%20%26.txt", "body", {
      "Content-Type": "text/plain",
    });
    const response = await request("/encoded%20folder", {
      method: "PROPFIND",
      headers: { ...dav, Depth: "1" },
      body: '<D:propfind xmlns:D="DAV:"><D:prop><D:resourcetype/><D:supportedlock/><D:getetag/><D:getlastmodified/><D:getcontentlength/><D:getcontenttype/></D:prop></D:propfind>',
    });
    expect(response.status).toBe(207);
    const responseXml = await xml(response);
    expect(responseXml.body).toContain("/encoded%20folder/");
    expect(responseXml.body).toContain("/encoded%20folder/file%20%26.txt");
    expect(responseXml.body).toContain("collection");
    expect(responseXml.body).toContain("supportedlock");
    expect(responseXml.body).toContain("getetag");
    expect(responseXml.body).toContain("getlastmodified");
    expect(responseXml.body).toContain("getcontentlength");
    expect(responseXml.body).toContain("getcontenttype");
    expect(responseXml.document.multistatus.response).toHaveLength(2);
  });

  it("treats a missing Depth as an infinite-depth request or rejects it explicitly", async () => {
    await request("/default-depth", { method: "MKCOL" });
    await request("/default-depth/nested", { method: "MKCOL" });
    await put("/default-depth/nested/file.txt");
    const response = await request("/default-depth", { method: "PROPFIND" });
    if (response.status === 207) {
      expect(await response.text()).toContain("/default-depth/nested/file.txt");
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

  it("processes instructions in document order and does not fail removing a missing property", async () => {
    await put("/property-order.txt");
    const setAfterRemove = await request("/property-order.txt", {
      method: "PROPPATCH",
      headers: dav,
      body: '<D:propertyupdate xmlns:D="DAV:" xmlns:X="urn:test"><D:remove><D:prop><X:order/></D:prop></D:remove><D:set><D:prop><X:order>kept</X:order></D:prop></D:set></D:propertyupdate>',
    });
    expect(setAfterRemove.status).toBe(207);
    expect(
      await (
        await request("/property-order.txt", {
          method: "PROPFIND",
          headers: { ...dav, Depth: "0" },
          body: '<D:propfind xmlns:D="DAV:" xmlns:X="urn:test"><D:prop><X:order/></D:prop></D:propfind>',
        })
      ).text(),
    ).toContain("kept");

    const removeAfterSet = await request("/property-order.txt", {
      method: "PROPPATCH",
      headers: { "Content-Type": "text/xml" },
      body: '<D:propertyupdate xmlns:D="DAV:" xmlns:X="urn:test"><D:set><D:prop><X:order>removed</X:order></D:prop></D:set><D:remove><D:prop><X:order/></D:prop></D:remove></D:propertyupdate>',
    });
    expect(removeAfterSet.status).toBe(207);
    expect(
      await (
        await request("/property-order.txt", {
          method: "PROPFIND",
          headers: { ...dav, Depth: "0" },
          body: '<D:propfind xmlns:D="DAV:" xmlns:X="urn:test"><D:prop><X:order/></D:prop></D:propfind>',
        })
      ).text(),
    ).toContain("404 Not Found");
  });

  it("rejects malformed XML and protected property changes", async () => {
    await put("/proppatch-errors.txt");
    const malformed = await request("/proppatch-errors.txt", {
      method: "PROPPATCH",
      headers: dav,
      body: "<D:propertyupdate>",
    });
    expect(malformed.status).toBe(400);

    const protectedProperty = await request("/proppatch-errors.txt", {
      method: "PROPPATCH",
      headers: dav,
      body: '<D:propertyupdate xmlns:D="DAV:"><D:remove><D:prop><D:getetag/></D:prop></D:remove></D:propertyupdate>',
    });
    expect(protectedProperty.status).toBe(207);
    expect(await protectedProperty.text()).toContain("403 Forbidden");
  });
});

describe("RFC 4918 sections 9.8 and 9.9 COPY and MOVE", () => {
  it("copies and moves resources with Destination and Overwrite semantics", async () => {
    await put("/source.txt", "source");
    expect(
      (
        await request("/source.txt", {
          method: "COPY",
          headers: {
            Destination: "https://webdav.test/copy.txt",
            Overwrite: "F",
          },
        })
      ).status,
    ).toBe(201);
    expect(await (await request("/copy.txt")).text()).toBe("source");
    expect(
      (
        await request("/source.txt", {
          method: "COPY",
          headers: {
            Destination: "https://webdav.test/copy.txt",
            Overwrite: "F",
          },
        })
      ).status,
    ).toBe(412);
    expect(
      (
        await request("/copy.txt", {
          method: "MOVE",
          headers: { Destination: "https://webdav.test/moved.txt" },
        })
      ).status,
    ).toBe(201);
    expect((await request("/copy.txt")).status).toBe(404);
    expect(await (await request("/moved.txt")).text()).toBe("source");
  });

  it("copies collections at Depth: 0 and infinity without copying into a descendant", async () => {
    await request("/source", { method: "MKCOL" });
    await put("/source/file.txt", "child");
    expect(
      (
        await request("/source", {
          method: "COPY",
          headers: { Destination: "https://webdav.test/shallow", Depth: "0" },
        })
      ).status,
    ).toBe(201);
    expect((await request("/shallow/file.txt")).status).toBe(404);
    expect(
      (
        await request("/source", {
          method: "COPY",
          headers: {
            Destination: "https://webdav.test/deep",
            Depth: "infinity",
          },
        })
      ).status,
    ).toBe(201);
    expect(await (await request("/deep/file.txt")).text()).toBe("child");
    expect(
      (
        await request("/source", {
          method: "COPY",
          headers: { Destination: "https://webdav.test/source/child" },
        })
      ).status,
    ).toBe(403);
  });

  it("requires a valid destination and replaces an existing collection without merging", async () => {
    await put("/copy-contract-source.txt", "source");
    expect(
      (await request("/copy-contract-source.txt", { method: "COPY" })).status,
    ).toBe(400);
    expect(
      (
        await request("/copy-contract-source.txt", {
          method: "COPY",
          headers: { Destination: "/copy-contract-source.txt" },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request("/copy-contract-source.txt", {
          method: "COPY",
          headers: { Destination: "/missing-parent/copy.txt" },
        })
      ).status,
    ).toBe(409);

    await put("/copy-contract-destination.txt", "old");
    const overwritten = await request("/copy-contract-source.txt", {
      method: "COPY",
      headers: { Destination: "/copy-contract-destination.txt" },
    });
    expect(overwritten.status).toBe(204);
    expect(await (await request("/copy-contract-destination.txt")).text()).toBe(
      "source",
    );

    await request("/copy-contract-source", { method: "MKCOL" });
    await put("/copy-contract-source/keep.txt", "keep");
    await request("/copy-contract-destination", { method: "MKCOL" });
    await put("/copy-contract-destination/remove.txt", "remove");
    const collectionCopy = await request("/copy-contract-source", {
      method: "COPY",
      headers: { Destination: "/copy-contract-destination" },
    });
    expect(collectionCopy.status).toBe(204);
    expect(
      (await request("/copy-contract-destination/remove.txt")).status,
    ).toBe(404);
    expect(
      await (await request("/copy-contract-destination/keep.txt")).text(),
    ).toBe("keep");
  });

  it("preserves dead properties and separates source and destination state", async () => {
    await put("/copy-properties-source.txt", "source");
    await request("/copy-properties-source.txt", {
      method: "PROPPATCH",
      headers: dav,
      body: '<D:propertyupdate xmlns:D="DAV:" xmlns:X="urn:test"><D:set><D:prop><X:color>blue</X:color></D:prop></D:set></D:propertyupdate>',
    });
    expect(
      (
        await request("/copy-properties-source.txt", {
          method: "COPY",
          headers: { Destination: "/copy-properties-destination.txt" },
        })
      ).status,
    ).toBe(201);
    const copiedProperty = await request("/copy-properties-destination.txt", {
      method: "PROPFIND",
      headers: { ...dav, Depth: "0" },
      body: '<D:propfind xmlns:D="DAV:" xmlns:X="urn:test"><D:prop><X:color/></D:prop></D:propfind>',
    });
    expect(await copiedProperty.text()).toContain("blue");

    await put("/copy-properties-source.txt", "changed");
    expect(
      await (await request("/copy-properties-destination.txt")).text(),
    ).toBe("source");

    expect(
      (
        await request("/copy-properties-source.txt", {
          method: "MOVE",
          headers: { Destination: "/move-properties-destination.txt" },
        })
      ).status,
    ).toBe(201);
    expect((await request("/copy-properties-source.txt")).status).toBe(404);
    expect(
      await (
        await request("/move-properties-destination.txt", {
          method: "PROPFIND",
          headers: { ...dav, Depth: "0" },
          body: '<D:propfind xmlns:D="DAV:" xmlns:X="urn:test"><D:prop><X:color/></D:prop></D:propfind>',
        })
      ).text(),
    ).toContain("blue");
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
    const lockXml = await xml(lock);
    expect(lockXml.body).toContain("lockdiscovery");
    expect(lockXml.body).toContain("<D:owner>test</D:owner>");
    expect(lockXml.body).toContain("<D:depth>infinity</D:depth>");

    expect((await put("/locked.txt", "blocked")).status).toBe(423);
    expect(
      (await put("/locked.txt", "allowed", { If: `(${token})` })).status,
    ).toBe(204);
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
    expect(
      (
        await request("/refresh.txt", {
          method: "LOCK",
          headers: { If: `(${token})`, Timeout: "Second-60" },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await request("/refresh.txt", {
          method: "UNLOCK",
        })
      ).status,
    ).toBe(400);
    const refreshed = await request("/refresh.txt", {
      method: "LOCK",
      headers: { If: `(${token})`, Timeout: "Second-60" },
    });
    expect(refreshed.status).toBe(200);
    expect(refreshed.headers.get("Lock-Token")).toBeNull();
    expect(
      (
        await request("/refresh.txt", {
          method: "UNLOCK",
          headers: { "Lock-Token": token! },
        })
      ).status,
    ).toBe(204);
    expect((await put("/refresh.txt", "unlocked")).status).toBe(204);
  });

  it("allows shared locks but rejects an incompatible exclusive lock", async () => {
    await put("/shared.txt");
    const body =
      '<D:lockinfo xmlns:D="DAV:"><D:lockscope><D:shared/></D:lockscope><D:locktype><D:write/></D:locktype></D:lockinfo>';
    expect(
      (await request("/shared.txt", { method: "LOCK", headers: dav, body }))
        .status,
    ).toBe(200);
    expect(
      (await request("/shared.txt", { method: "LOCK", headers: dav, body }))
        .status,
    ).toBe(200);
    expect(
      (
        await request("/shared.txt", {
          method: "LOCK",
          headers: dav,
          body: body.replace("shared", "exclusive"),
        })
      ).status,
    ).toBe(423);
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
    const propfind = await request("/lock-null.txt", {
      method: "PROPFIND",
      headers: { Depth: "0" },
    });
    expect(propfind.status).toBe(207);
    expect(await propfind.text()).toContain("lockdiscovery");
    expect(
      (await put("/lock-null.txt", "created", { If: `(${token})` })).status,
    ).toBe(201);
  });

  it("requires lock bodies and creates an empty unmapped resource", async () => {
    expect(
      (await request("/lock-body-required.txt", { method: "LOCK" })).status,
    ).toBe(400);
    expect(
      (
        await request("/missing-lock-parent/child.txt", {
          method: "LOCK",
          headers: dav,
          body: '<D:lockinfo xmlns:D="DAV:"><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype></D:lockinfo>',
        })
      ).status,
    ).toBe(409);

    const lock = await request("/empty-lock-null.txt", {
      method: "LOCK",
      headers: dav,
      body: '<D:lockinfo xmlns:D="DAV:"><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype></D:lockinfo>',
    });
    expect(lock.status).toBe(201);
    const token = lock.headers.get("Lock-Token");
    expect(token).toBeTruthy();
    const get = await request("/empty-lock-null.txt");
    expect([200, 204]).toContain(get.status);
    if (get.status === 200) expect(get.headers.get("Content-Length")).toBe("0");
    expect(
      (
        await request("/empty-lock-null.txt", {
          method: "UNLOCK",
          headers: { "Lock-Token": token! },
        })
      ).status,
    ).toBe(204);
    const afterUnlock = await request("/empty-lock-null.txt");
    expect([200, 204]).toContain(afterUnlock.status);
  });

  it("applies an infinity lock to collection members and requires its token for DELETE", async () => {
    await request("/locked-tree", { method: "MKCOL" });
    await put("/locked-tree/file.txt", "content");
    const lock = await request("/locked-tree", {
      method: "LOCK",
      headers: { ...dav, Depth: "infinity" },
      body: '<D:lockinfo xmlns:D="DAV:"><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype></D:lockinfo>',
    });
    expect(lock.status).toBe(200);
    const token = lock.headers.get("Lock-Token");
    expect(token).toBeTruthy();
    expect((await xml(lock)).body).toContain("<D:depth>infinity</D:depth>");

    expect((await put("/locked-tree/file.txt", "blocked")).status).toBe(423);
    expect(
      (await put("/locked-tree/file.txt", "allowed", { If: `(${token})` }))
        .status,
    ).toBe(204);
    expect((await request("/locked-tree", { method: "DELETE" })).status).toBe(
      423,
    );
    expect(
      (
        await request("/locked-tree", {
          method: "DELETE",
          headers: { If: `(${token})` },
        })
      ).status,
    ).toBe(204);
    expect((await request("/locked-tree/file.txt")).status).toBe(404);
  });

  it("rejects unsupported lock depths", async () => {
    await put("/invalid-lock-depth.txt");
    const response = await request("/invalid-lock-depth.txt", {
      method: "LOCK",
      headers: { ...dav, Depth: "1" },
      body: '<D:lockinfo xmlns:D="DAV:"><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype></D:lockinfo>',
    });
    expect(response.status).toBe(400);
  });
});
