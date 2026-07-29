# cf-webdav

[简体中文](README.zh_CN.md)

`cf-webdav` is a WebDAV implementation for Cloudflare Workers built around
filesystem semantics.

File contents are stored in Cloudflare R2, while coordination and metadata are
managed by Cloudflare Durable Objects.

## Standards and Compatibility

Implements the core WebDAV Class 1 and Class 2 semantics from
[RFC 4918](https://www.rfc-editor.org/rfc/rfc4918).

Compatibility is validated with the [Apache Litmus](https://github.com/notroj/litmus)
WebDAV compatibility test suite. Passing Litmus does not imply complete
conformance with RFC 4918.

## Deployment

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/YuZiOuO/cf-webdav)

### Manual Deployment

```bash
bun install

# Log in to Cloudflare if needed
bunx wrangler login

# Create the R2 bucket. If you use a different name, update the binding in
# wrangler.jsonc as well.
bunx wrangler r2 bucket create webdav

# Deploy the Worker. The command prints its HTTPS URL.
bun run deploy

# Set the WebDAV username and password interactively
bunx wrangler secret put WEBDAV_USERNAME
bunx wrangler secret put WEBDAV_PASSWORD
```

For local development, set these variables in `.dev.vars`:

```text
WEBDAV_USERNAME=your-username
WEBDAV_PASSWORD=your-password
```

## Consistency Assumptions

From an external perspective, ordinary WebDAV filesystem operations should be
equivalent to one valid concurrent execution on a conventional filesystem.
The implementation does not expose partial writes, a corrupted namespace, or
intermediate states that violate resource-level read-after-write consistency.
Directory listings are not guaranteed to provide a globally consistent
snapshot while concurrent modifications are in progress.
