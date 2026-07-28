# cf-r2-webdav

一个运行在 Cloudflare Workers 上、使用 R2 作为存储后端的最小 WebDAV 服务。

使用 R2 binding 直接流式传输文件，不需要额外服务器。

## 支持范围

| 方法 | 行为 |
| --- | --- |
| `OPTIONS` | 声明 WebDAV 能力 |
| `PROPFIND` | 列出资源，支持 `Depth: 0` 与 `Depth: 1` |
| `GET` / `HEAD` | 下载文件，支持 R2 原生 Range 请求 |
| `PUT` | 创建或覆盖文件 |
| `MKCOL` | 创建 collection |
| `DELETE` | 删除文件或 collection 及其内容 |
| `COPY` | 复制文件或 collection |
| `MOVE` | 移动或重命名文件、collection |

不支持 `PROPPATCH`、`LOCK`、`UNLOCK`。`COPY` 支持 `Depth: 0` 与 `Depth: infinity`，不支持 `Depth: 1`；`MOVE` 只支持完整移动。这不是完整的 RFC 4918 实现。

R2 没有目录实体。`MKCOL /photos` 会写入零字节对象 `photos/`，用来保留空 collection；该对象不会出现在 WebDAV 目录列表中。

## 部署

```bash
bun install

# 交互式地登录 Cloudflare，如果你已登录，忽略这步
bunx wrangler login

# 创建 R2 bucket
bunx wrangler r2 bucket create webdav

# 交互式地设定 WebDAV 用户名与密码
bunx wrangler secret put WEBDAV_USERNAME
bunx wrangler secret put WEBDAV_PASSWORD

# 部署
bun run deploy # 命令会输出 Worker 的 HTTPS 地址。
```

默认 binding 使用名为 `webdav` 的 R2 bucket。若要使用其他名称，修改 `wrangler.jsonc` 中 `r2_buckets.bucket_name`，再创建同名 bucket。

本地开发时，变量从 `.dev.vars` 中读取：

```text
WEBDAV_USERNAME=your-username
WEBDAV_PASSWORD=your-password
```

## Windows 测试

Windows 原生 WebDAV 客户端应使用 HTTPS 地址。部署 Worker 后，可在资源管理器中添加网络位置，输入 Worker URL，并使用配置的 Basic Auth 用户名和密码。

Windows 挂载兼容性尚待实际验证。测试时至少覆盖列目录、上传、下载、创建空目录和删除目录。
