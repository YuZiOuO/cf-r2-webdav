# cf-r2-webdav

运行在 Cloudflare Workers 上的简洁完整的 WebDAV 实现。

文件系统控制面基于 Cloudflare Durable Object。

## 一致性假设

外部可观察不变量：在当前实现中，常规 WebDAV 文件系统操作应等价于普通磁盘文件系统的一次合法并发执行，不暴露部分写入、损坏的命名空间或违反资源级读后写一致性的中间状态。目录枚举不承诺跨并发修改的全局快照。

## 部署

```bash
bun install

# 交互式地登录 Cloudflare，如果你已登录，忽略这步
bunx wrangler login

# 创建 R2 bucket
bunx wrangler r2 bucket create webdav # 注意:如果需要使用其他名称，请同时修改 wrangler.jsonc 中的绑定。

# 交互式地设定 WebDAV 用户名与密码
bunx wrangler secret put WEBDAV_USERNAME
bunx wrangler secret put WEBDAV_PASSWORD

# 部署
bun run deploy # 命令会输出 Worker 的 HTTPS 地址。
```

本地开发时，变量从 `.dev.vars` 中读取：

```text
WEBDAV_USERNAME=your-username
WEBDAV_PASSWORD=your-password
```
