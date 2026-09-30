import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import express from "express";
import cookieParser from "cookie-parser";
import { env } from "./config.js";
import { loadSession } from "./auth/session.js";
import { apiRouter } from "./api/routes.js";
import { bootstrapAllRelays } from "./relay/service.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.join(__dirname, "..", "web");
const lockPath = path.join(__dirname, "..", ".relay.lock");

/** Impede 2x yarn dev: o 2º processo ainda conectava IRC/Kick e duplicava mensagens. */
function acquireSingletonLock(): void {
  const pid = process.pid;
  try {
    if (fs.existsSync(lockPath)) {
      const prev = Number(fs.readFileSync(lockPath, "utf8").trim());
      if (Number.isFinite(prev) && prev !== pid) {
        try {
          process.kill(prev, 0);
          console.error(
            `[lock] Já existe instância pid=${prev}. Mate o outro yarn/tsx (ou apague .relay.lock) antes de subir de novo.`,
          );
          process.exit(1);
        } catch {
          // processo morto — lock stale
        }
      }
    }
    fs.writeFileSync(lockPath, String(pid), "utf8");
  } catch (err) {
    console.error("[lock] falha ao adquirir", err);
  }

  const release = () => {
    try {
      if (fs.existsSync(lockPath)) {
        const cur = Number(fs.readFileSync(lockPath, "utf8").trim());
        if (cur === pid) fs.unlinkSync(lockPath);
      }
    } catch {
      /* ignore */
    }
  };
  process.on("exit", release);
  process.on("SIGINT", () => {
    release();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    release();
    process.exit(0);
  });
}

acquireSingletonLock();

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(loadSession);
app.use(apiRouter);
app.use(express.static(webDir));

app.get("/", (_req, res) => {
  res.sendFile(path.join(webDir, "index.html"));
});
app.get("/dashboard", (_req, res) => {
  res.sendFile(path.join(webDir, "dashboard.html"));
});
app.get("/link", (_req, res) => {
  res.sendFile(path.join(webDir, "link.html"));
});
app.get("/overlay", (_req, res) => {
  res.sendFile(path.join(webDir, "overlay.html"));
});

app.use(
  (
    err: unknown,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    console.error(err);
    res.status(500).json({ error: "Erro interno" });
  },
);

const server = app.listen(env.PORT, async () => {
  console.log(
    `chat-integration listening on ${env.APP_URL} (port ${env.PORT}) pid=${process.pid}`,
  );
  try {
    await bootstrapAllRelays();
  } catch (err) {
    console.error("bootstrap relays failed", err);
  }
});

server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(
      `[lock] Porta ${env.PORT} em uso — outra instância já está rodando. Abortando.`,
    );
    process.exit(1);
  }
  console.error(err);
  process.exit(1);
});
