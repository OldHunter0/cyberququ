// 大屏 / 回放用的本地 HTTP：
//   GET  /state            当前快照（JSON）
//   GET  /events           SSE：snapshot（全量）+ fx（台词、逐刀、解说、打气……）
//   GET  /logs             有日志的对局列表；/logs/:g 该局的文件列表；/logs/:g/:file 单个文件
//   POST /admin/start      立即开局（大厅里 ≥2 只）
//   POST /admin/new        结束后开下一局
//   POST /admin/config?realLimit=2&bots=6   运行中调整真人名额 / 模拟用户数
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { cfg } from "./config.ts";

const clients = new Set<http.ServerResponse>();

export function broadcast(event: string, data: unknown) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data, (_, v) => (typeof v === "bigint" ? v.toString() : v))}\n\n`;
  for (const c of clients) c.write(msg);
}

export type Admin = {
  start(): void;
  next(): void;
  config(q: { realLimit?: number; botCount?: number }): unknown;
};

export function startServer(getSnapshot: () => unknown, admin: Admin) {
  const server = http.createServer((req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "content-type, x-admin-token");
    if (req.method === "OPTIONS") return res.end();
    const url = new URL(req.url ?? "/", "http://x");
    const json = (body: unknown, code = 200) => {
      res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(body, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
    };

    if (url.pathname === "/state") return json(getSnapshot());

    if (url.pathname === "/events") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      res.write(`event: snapshot\ndata: ${JSON.stringify(getSnapshot(), (_, v) => (typeof v === "bigint" ? v.toString() : v))}\n\n`);
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }

    if (url.pathname.startsWith("/logs")) {
      const parts = url.pathname.split("/").filter(Boolean).slice(1).map((p) => p.replace(/[^\w.-]/g, ""));
      const target = path.join(cfg.logsDir, ...parts);
      if (!target.startsWith(cfg.logsDir) || !fs.existsSync(target)) return json({ error: "not found" }, 404);
      if (fs.statSync(target).isDirectory()) {
        const names = fs.readdirSync(target).filter((n) => !n.startsWith("."));
        return json(names.sort((a, b) => a.localeCompare(b, undefined, { numeric: true })));
      }
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      return fs.createReadStream(target).pipe(res);
    }

    if (req.method === "POST" && url.pathname.startsWith("/admin/")) {
      if (cfg.adminToken && req.headers["x-admin-token"] !== cfg.adminToken) return json({ error: "forbidden" }, 403);
      if (url.pathname === "/admin/start") admin.start();
      else if (url.pathname === "/admin/new") admin.next();
      else if (url.pathname === "/admin/config") {
        const num = (k: string) => (url.searchParams.has(k) ? Number(url.searchParams.get(k)) : undefined);
        return json(admin.config({ realLimit: num("realLimit"), botCount: num("bots") }));
      } else return json({ error: "unknown" }, 404);
      return json({ ok: true });
    }

    json({ error: "not found" }, 404);
  });
  server.listen(cfg.port, () => console.log(`[server] http://localhost:${cfg.port}  (/state /events /logs)`));
  setInterval(() => {
    for (const c of clients) c.write(": ping\n\n");
  }, 15_000);
}
