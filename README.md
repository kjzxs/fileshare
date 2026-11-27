# 文件快传

上传文件，得到一个分享链接，发给别人就能下载。跑在 Prisma Compute 免费档上，文件存在 Prisma Postgres 数据库里。

## 能做什么

- 上传文件（单个不超过 10MB），自动生成 6 位分享码
- 打开 `https://你的域名/f/分享码` 就能下载原文件，下载次数会 +1
- 首页能看到全部文件：名字、大小、上传时间、下载次数、分享链接，还能复制链接、删除文件
- 顶部显示已用存储 / 2GB

## 免费档限制（Prisma 官方免费档）

- Compute：每月 1M 请求、360 GB-hours 内存、4 vCPU-hours、10GB 出站流量，超了不扣钱，到量就停
- 数据库：每月 200k 操作、2GB 存储、50 个数据库，**没有备份**
- 因为免费档的对象存储是否包含还没核实，文件内容直接存在 Postgres 的 `BYTEA` 字段里，所以总容量就是 2GB，不适合传大文件

## 怎么部署

```bash
bun install
bun run build
npx prisma deploy
```

第一次部署会在 `us-east-1` 创建同名项目，部署完成后命令行会打印公开地址。

本地跑起来看看效果：

```bash
npx prisma dev
```

## 技术说明

- 一个服务 `web`，Bun 跑 `src/server.ts`，端口读 `service.port()`，监听 `0.0.0.0`
- 数据库用 Bun 内置的 `SQL` 客户端，连接串来自 Composer 注入的 `db.url`，不读环境变量
- 表 `files`：id、code（6 位分享码，唯一）、filename、mime、size、data（BYTEA）、downloads、created_at，服务启动时自动建表
