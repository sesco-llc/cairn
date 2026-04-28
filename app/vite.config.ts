import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import type { Connect, Plugin } from "vite";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REVIEWS_ROOT = path.resolve(HERE, "..", ".cairn");

function reviewsServer(): Plugin {
  const handler: Connect.NextHandleFunction = (req, res, next) => {
    if (!req.url || !req.url.startsWith("/_data/")) return next();
    const rel = decodeURIComponent(req.url.slice("/_data/".length).split("?")[0] ?? "");

    if (rel.includes("..")) {
      res.statusCode = 400;
      res.end("bad path");
      return;
    }

    let absPath: string;
    if (rel === "index.json") {
      absPath = path.join(REVIEWS_ROOT, "index.json");
    } else if (rel.startsWith("reviews/")) {
      absPath = path.join(REVIEWS_ROOT, rel);
    } else {
      res.statusCode = 404;
      res.end("not found");
      return;
    }

    fs.readFile(absPath, (err, buf) => {
      if (err) {
        res.statusCode = 404;
        res.end("not found");
        return;
      }
      const ext = path.extname(absPath);
      res.setHeader(
        "Content-Type",
        ext === ".json" ? "application/json" : "text/plain; charset=utf-8",
      );
      res.setHeader("Cache-Control", "no-store");
      res.end(buf);
    });
  };

  return {
    name: "cairn-app-reviews",
    configureServer(server) {
      server.middlewares.use(handler);
    },
    configurePreviewServer(server) {
      server.middlewares.use(handler);
    },
  };
}

export default defineConfig({
  plugins: [react(), reviewsServer()],
  server: { port: 5173, strictPort: false },
});
