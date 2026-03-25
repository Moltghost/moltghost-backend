import "dotenv/config";
import express from "express";
import cors from "cors";
import { createServer } from "http";
import { attachWebSocketServer } from "./ws/wsServer";

import authRouter from "./routes/auth";
import modelsRouter from "./routes/models";
import runpodRouter from "./routes/runpod";
import deploymentsRouter from "./routes/deployments";
import usersRouter from "./routes/users";
import adminRouter from "./routes/admin";

const app = express();
const port = parseInt(process.env.PORT ?? "3001", 10);

// ── Middleware ─────────────────────────────────────────────────────────────────
app.use(
  cors({
    origin: process.env.FRONTEND_URL ?? "http://localhost:3000",
    credentials: true,
  }),
);
app.use(express.json());

// Disable ETag to prevent 304 responses for polling APIs
app.set("etag", false);

// ── Routes ─────────────────────────────────────────────────────────────────────
app.use("/api/auth", authRouter);
app.use("/api/models", modelsRouter);
app.use("/api/runpod", runpodRouter);
app.use("/api/deployments", deploymentsRouter);
app.use("/api/users", usersRouter);
app.use("/api/admin", adminRouter);

app.get("/health", (_req, res) => {
  res.json({ status: "ok", ts: new Date().toISOString() });
});

// ── HTTP + WebSocket server ────────────────────────────────────────────────────
const httpServer = createServer(app);
attachWebSocketServer(httpServer);

httpServer.listen(port, () => {
  console.log(`🚀 MoltGhost backend running on http://localhost:${port}`);
  console.log(`🔌 WebSocket server on ws://localhost:${port}/ws`);
});
