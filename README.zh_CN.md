# cf-webdav

[English](README.md)

运行在 Cloudflare Workers 上的、以文件系统语义为上层抽象的 WebDAV 实现。
文件内容存储在 Cloudflare R2，控制面基于 Cloudflare Durable Object。

## 标准与兼容性

实现 [RFC 4918](https://www.rfc-editor.org/rfc/rfc4918) 定义的 WebDAV
Class 1 和 Class 2 核心语义。

通过 [Apache Litmus](https://github.com/notroj/litmus) WebDAV 兼容性测试套件
进行验证。Litmus 测试覆盖不代表完整通过 RFC 4918 的所有要求。

## 部署

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/YuZiOuO/cf-webdav)

### 手动部署？

```bash
bun install

# 交互式地登录 Cloudflare，如果你已登录，忽略这步
bunx wrangler login

# 创建 R2 bucket
bunx wrangler r2 bucket create webdav # 注意:如果需要使用其他名称，请同时修改 wrangler.jsonc 中的绑定。

# 部署
bun run deploy # 命令会输出 Worker 的 HTTPS 地址。

# 交互式地设定 WebDAV 用户名与密码
# 执行后马上生效
bunx wrangler secret put WEBDAV_USERNAME
bunx wrangler secret put WEBDAV_PASSWORD
```

本地开发时，变量从 `.dev.vars` 中读取：

```text
WEBDAV_USERNAME=your-username
WEBDAV_PASSWORD=your-password
```

## 一致性假设

外部可观察不变量：在当前实现中，常规 WebDAV 文件系统操作应等价于普通磁盘文件系统的一次合法并发执行，不暴露部分写入、损坏的命名空间或违反资源级读后写一致性的中间状态。目录枚举不承诺跨并发修改的全局快照。
