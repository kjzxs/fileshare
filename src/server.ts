import { SQL } from "bun";
import service from "./service.ts";

// 单个文件上限 10MB，总容量上限 2GB（Prisma 免费档的数据库存储）
const MAX_FILE_SIZE = 10 * 1024 * 1024;
const CAP_BYTES = 2147483648;

// ---- 数据库连接（懒加载：服务启动时不强制连库，首次访问数据库时才建连接）----

let sql: SQL | null = null;
let tableReady: Promise<void> | null = null;

function getSql(): SQL {
  if (sql) return sql;
  try {
    // 连接串来自 Composer 注入的依赖，不从 process.env 读
    const { db } = service.load();
    sql = new SQL({ url: db.url, max: 1, idleTimeout: 10, prepare: false });
    return sql;
  } catch {
    throw new Error("数据库未连接");
  }
}

async function ensureTable(): Promise<void> {
  if (!tableReady) {
    tableReady = (async () => {
      const db = getSql();
      await db`
        CREATE TABLE IF NOT EXISTS files (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          code text UNIQUE NOT NULL,
          filename text NOT NULL,
          mime text NOT NULL DEFAULT 'application/octet-stream',
          size int NOT NULL,
          data bytea NOT NULL,
          downloads int NOT NULL DEFAULT 0,
          created_at timestamptz NOT NULL DEFAULT now()
        )
      `;
    })().catch((err: unknown) => {
      // 建表失败就重置，下次访问数据库时再试；绝不能让服务启动崩掉
      tableReady = null;
      throw err;
    });
  }
  return tableReady;
}

// 启动时尽力建表一次，失败只记日志，不退出进程
void ensureTable().catch((err: unknown) => {
  console.error(
    "[文件快传] 启动时连接数据库失败，首次访问数据库时再试：",
    err instanceof Error ? err.message : err,
  );
});

// ---- 小工具 ----

const CODE_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789";

function randomCode(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => CODE_CHARS[b % CODE_CHARS.length]).join("");
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function errorPage(title: string, message: string, status = 404): Response {
  return new Response(
    `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><style>body{font-family:system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;max-width:560px;margin:15vh auto 0;padding:0 20px;color:#333;text-align:center}h1{font-size:22px}a{color:#2563eb}</style></head><body><h1>${title}</h1><p>${message}</p><p><a href="/">回文件快传首页</a></p></body></html>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}

// 中文文件名：普通 filename 只放 ASCII 安全字符，真正的名字走 RFC 5987 的 filename*
function contentDisposition(filename: string): string {
  const ascii =
    filename.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_") || "download";
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

// ---- 路由处理 ----

async function handleUpload(req: Request): Promise<Response> {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return json({ error: "上传内容不对，请重新选择文件" }, 400);
  }
  const file = form.get("file");
  if (!(file instanceof File)) {
    return json({ error: "没有收到文件，请重新选择" }, 400);
  }
  if (file.size === 0) {
    return json({ error: "不能上传空文件" }, 400);
  }
  if (file.size > MAX_FILE_SIZE) {
    return json({ error: "文件不能超过 10MB" }, 400);
  }
  const db = getSql();
  await ensureTable();
  const buffer = Buffer.from(await file.arrayBuffer());
  const filename = file.name || "未命名文件";
  const mime = file.type || "application/octet-stream";
  // 分享码 6 位随机，撞码就重抽，最多试 5 次
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = randomCode();
    try {
      const rows = (await db`
        INSERT INTO files (code, filename, mime, size, data)
        VALUES (${code}, ${filename}, ${mime}, ${buffer.length}, ${buffer})
        RETURNING code
      `) as Array<{ code: string }>;
      const url = new URL(`/f/${rows[0].code}`, req.url).toString();
      return json({ code: rows[0].code, url });
    } catch (err) {
      if (err instanceof Error && /duplicate key|unique/i.test(err.message)) {
        continue;
      }
      throw err;
    }
  }
  return json({ error: "生成分享码失败，请重试" }, 500);
}

async function handleList(): Promise<Response> {
  const db = getSql();
  await ensureTable();
  const rows = (await db`
    SELECT code, filename, mime, size, downloads, created_at
    FROM files
    ORDER BY created_at DESC
  `) as Array<{
    code: string;
    filename: string;
    mime: string;
    size: number;
    downloads: number;
    created_at: Date | string;
  }>;
  return json(
    rows.map((r) => ({
      code: r.code,
      filename: r.filename,
      mime: r.mime,
      size: r.size,
      downloads: r.downloads,
      created_at:
        r.created_at instanceof Date
          ? r.created_at.toISOString()
          : r.created_at,
    })),
  );
}

async function handleStats(): Promise<Response> {
  const db = getSql();
  await ensureTable();
  const rows = (await db`
    SELECT COUNT(*)::int AS files, COALESCE(SUM(size), 0)::int AS bytes
    FROM files
  `) as Array<{ files: number; bytes: number }>;
  return json({ files: rows[0].files, bytes: rows[0].bytes, cap: CAP_BYTES });
}

async function handleDownload(code: string): Promise<Response> {
  const db = getSql();
  await ensureTable();
  const rows = (await db`
    UPDATE files SET downloads = downloads + 1
    WHERE code = ${code}
    RETURNING filename, mime, size, data
  `) as Array<{
    filename: string;
    mime: string;
    size: number;
    data: Buffer;
  }>;
  if (rows.length === 0) {
    return errorPage("文件不存在", "这个分享链接对应的文件不存在，或者已经被删除了。");
  }
  const f = rows[0];
  return new Response(new Uint8Array(f.data), {
    headers: {
      "Content-Type": f.mime,
      "Content-Disposition": contentDisposition(f.filename),
      "Content-Length": String(f.size),
    },
  });
}

async function handleDelete(code: string): Promise<Response> {
  const db = getSql();
  await ensureTable();
  const rows = (await db`
    DELETE FROM files WHERE code = ${code} RETURNING code
  `) as Array<{ code: string }>;
  if (rows.length === 0) {
    return json({ error: "文件不存在或已被删除" }, 404);
  }
  return json({ ok: true });
}

// ---- 首页（单页应用，内联 CSS/JS，不用构建步骤）----

const HOME_PAGE = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>文件快传</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; max-width: 760px; margin: 0 auto; padding: 24px 16px 64px; color: #1f2937; background: #f9fafb; }
  h1 { font-size: 26px; margin: 0 0 4px; }
  .sub { color: #6b7280; font-size: 14px; margin: 0 0 20px; }
  .storage { background: #fff; border: 1px solid #e5e7eb; border-radius: 10px; padding: 12px 16px; margin-bottom: 16px; font-size: 14px; }
  .bar { height: 8px; background: #e5e7eb; border-radius: 4px; margin-top: 8px; overflow: hidden; }
  .bar > div { height: 100%; background: #2563eb; width: 0; }
  .drop { border: 2px dashed #93c5fd; border-radius: 12px; background: #eff6ff; padding: 36px 16px; text-align: center; cursor: pointer; margin-bottom: 8px; }
  .drop.over { border-color: #2563eb; background: #dbeafe; }
  .drop p { margin: 4px 0; }
  .drop .big { font-size: 17px; font-weight: 600; }
  .drop .small { color: #6b7280; font-size: 13px; }
  #msg { min-height: 20px; font-size: 14px; margin: 0 0 16px; color: #dc2626; }
  #msg.ok { color: #15803d; }
  .file { background: #fff; border: 1px solid #e5e7eb; border-radius: 10px; padding: 12px 16px; margin-bottom: 10px; }
  .file .name { font-weight: 600; word-break: break-all; }
  .file .meta { color: #6b7280; font-size: 13px; margin: 4px 0 8px; }
  .file .link { font-size: 13px; color: #2563eb; word-break: break-all; }
  .file .actions { margin-top: 8px; }
  button { border: 1px solid #d1d5db; background: #fff; border-radius: 6px; padding: 5px 12px; font-size: 13px; cursor: pointer; margin-right: 6px; }
  button:hover { background: #f3f4f6; }
  button.danger { color: #dc2626; border-color: #fecaca; }
  .empty { color: #9ca3af; text-align: center; padding: 24px 0; font-size: 14px; }
  .foot { color: #9ca3af; font-size: 12px; margin-top: 24px; text-align: center; }
</style>
</head>
<body>
<h1>📁 文件快传</h1>
<p class="sub">上传文件，得到一个分享链接，发给别人就能下载。单个文件不超过 10MB。</p>

<div class="storage">
  <span id="storageText">正在读取存储用量…</span>
  <div class="bar"><div id="storageBar"></div></div>
</div>

<div class="drop" id="drop">
  <p class="big">把文件拖到这里，或者点一下选择文件</p>
  <p class="small">单个文件不超过 10MB</p>
  <input type="file" id="picker" hidden>
</div>
<p id="msg"></p>

<div id="list"><p class="empty">正在加载文件列表…</p></div>

<p class="foot">跑在 Prisma Compute 免费档上 · 文件存在 Postgres 数据库里，总容量 2GB</p>

<script>
const $ = (id) => document.getElementById(id);
const drop = $("drop"), picker = $("picker"), msg = $("msg"), list = $("list");

function fmtSize(n) {
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(2) + " MB";
  return (n / 1024 / 1024 / 1024).toFixed(2) + " GB";
}
function fmtTime(iso) {
  return new Date(iso).toLocaleString("zh-CN", { hour12: false });
}
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function showMsg(text, ok) {
  msg.textContent = text;
  msg.className = ok ? "ok" : "";
}

async function loadStats() {
  try {
    const r = await fetch("/api/stats");
    if (!r.ok) throw new Error();
    const s = await r.json();
    $("storageText").textContent = "已用 " + fmtSize(s.bytes) + " / " + fmtSize(s.cap) + "（共 " + s.files + " 个文件）";
    $("storageBar").style.width = Math.min(100, (s.bytes / s.cap) * 100) + "%";
  } catch {
    $("storageText").textContent = "存储用量暂时读不到";
  }
}

async function loadFiles() {
  try {
    const r = await fetch("/api/files");
    if (!r.ok) throw new Error();
    const files = await r.json();
    if (files.length === 0) {
      list.innerHTML = '<p class="empty">还没有上传过文件，传一个试试吧。</p>';
      return;
    }
    list.innerHTML = files.map((f) => {
      const url = location.origin + "/f/" + f.code;
      return '<div class="file" data-code="' + esc(f.code) + '">' +
        '<div class="name">' + esc(f.filename) + '</div>' +
        '<div class="meta">' + fmtSize(f.size) + " · " + fmtTime(f.created_at) + " · 已下载 " + f.downloads + " 次</div>" +
        '<div class="link">' + esc(url) + '</div>' +
        '<div class="actions">' +
          '<button data-act="copy" data-url="' + esc(url) + '">复制链接</button>' +
          '<button data-act="open" data-url="' + esc(url) + '">打开下载</button>' +
          '<button class="danger" data-act="del" data-code="' + esc(f.code) + '" data-name="' + esc(f.filename) + '">删除</button>' +
        "</div></div>";
    }).join("");
  } catch {
    list.innerHTML = '<p class="empty">文件列表暂时读不到，请刷新页面重试。</p>';
  }
}

async function uploadFile(file) {
  if (file.size > 10 * 1024 * 1024) {
    showMsg("文件不能超过 10MB");
    return;
  }
  showMsg("正在上传 " + file.name + "…", true);
  const form = new FormData();
  form.append("file", file);
  try {
    const r = await fetch("/api/upload", { method: "POST", body: form });
    const data = await r.json();
    if (!r.ok) {
      showMsg(data.error || "上传失败，请重试");
      return;
    }
    showMsg("上传成功！分享链接：" + data.url, true);
    loadFiles();
    loadStats();
  } catch {
    showMsg("上传失败，网络可能有问题，请重试");
  }
}

drop.addEventListener("click", () => picker.click());
picker.addEventListener("change", () => {
  if (picker.files[0]) uploadFile(picker.files[0]);
  picker.value = "";
});
["dragenter", "dragover"].forEach((ev) => drop.addEventListener(ev, (e) => {
  e.preventDefault();
  drop.classList.add("over");
}));
["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => {
  e.preventDefault();
  drop.classList.remove("over");
}));
drop.addEventListener("drop", (e) => {
  const f = e.dataTransfer.files[0];
  if (f) uploadFile(f);
});

list.addEventListener("click", async (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;
  const act = btn.dataset.act;
  if (act === "copy") {
    try {
      await navigator.clipboard.writeText(btn.dataset.url);
      showMsg("链接已复制", true);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = btn.dataset.url;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      showMsg("链接已复制", true);
    }
  } else if (act === "open") {
    window.open(btn.dataset.url, "_blank");
  } else if (act === "del") {
    if (!confirm("确定删除「" + btn.dataset.name + "」吗？删除后别人就打不开这个分享链接了。")) return;
    const r = await fetch("/api/files/" + encodeURIComponent(btn.dataset.code), { method: "DELETE" });
    if (r.ok) {
      showMsg("已删除", true);
      loadFiles();
      loadStats();
    } else {
      showMsg("删除失败，请重试");
    }
  }
});

loadStats();
loadFiles();
</script>
</body>
</html>`;

async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  try {
    if (req.method === "GET" && path === "/") {
      return new Response(HOME_PAGE, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }
    if (req.method === "POST" && path === "/api/upload") {
      return await handleUpload(req);
    }
    if (req.method === "GET" && path === "/api/files") {
      return await handleList();
    }
    if (req.method === "GET" && path === "/api/stats") {
      return await handleStats();
    }
    if (req.method === "GET" && path.startsWith("/f/")) {
      const code = decodeURIComponent(path.slice(3));
      if (!code || code.includes("/")) {
        return errorPage("链接不对", "这个分享链接的格式不对，请检查链接是否完整。");
      }
      return await handleDownload(code);
    }
    if (req.method === "DELETE" && path.startsWith("/api/files/")) {
      const code = decodeURIComponent(path.slice("/api/files/".length));
      if (!code || code.includes("/")) {
        return json({ error: "链接不对" }, 400);
      }
      return await handleDelete(code);
    }
    return json({ error: "找不到这个地址" }, 404);
  } catch (err) {
    if (err instanceof Error && err.message === "数据库未连接") {
      console.error("[文件快传] 数据库未连接");
    } else {
      console.error("[文件快传]", err);
    }
    if (err instanceof Error && err.message === "数据库未连接") {
      if (path.startsWith("/f/")) {
        return errorPage("数据库未连接", "数据库暂时连不上，请稍后再试。", 503);
      }
      return json({ error: "数据库未连接，请稍后再试" }, 503);
    }
    if (path.startsWith("/f/")) {
      return errorPage("服务器出错", "服务器开小差了，请稍后再试。", 500);
    }
    return json({ error: "服务器出错，请稍后再试" }, 500);
  }
}

// 端口读 service.port()；在 Composer 环境外直接运行时才回落到 3000
let port = 3000;
try {
  port = service.port();
} catch {
  port = Number(process.env.PORT) || 3000;
}

Bun.serve({
  port,
  hostname: "0.0.0.0",
  fetch: handleRequest,
});

console.log(`[文件快传] 已启动，监听 0.0.0.0:${port}`);
