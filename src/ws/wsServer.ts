import { EventEmitter } from "events";
import { WebSocketServer, WebSocket } from "ws";
import { IncomingMessage } from "http";
import { Server } from "http";
import { PrivyClient } from "@privy-io/node";
import { db } from "../db";
import { deployments } from "../db/schema";
import { eq } from "drizzle-orm";

export const deploymentEmitter = new EventEmitter();

let _privy: PrivyClient | null = null;
function getPrivy() {
  if (!_privy) {
    _privy = new PrivyClient({
      appId: process.env.PRIVY_APP_ID!,
      appSecret: process.env.PRIVY_APP_SECRET!,
    });
  }
  return _privy;
}

interface AuthedSocket extends WebSocket {
  privyId?: string;
  subscribedDeploymentId?: string;
  isAlive?: boolean;
}

/**
 * Attach a WebSocket server to the existing HTTP server.
 * Clients connect to ws://<host>/ws
 */
export function attachWebSocketServer(httpServer: Server): WebSocketServer {
  const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

  wss.on("connection", async (ws: AuthedSocket, req: IncomingMessage) => {
    ws.isAlive = true;

    // ── Auth handshake ────────────────────────────────────────────────────
    // Expect token in query string: /ws?token=<privy-jwt>
    const url = new URL(req.url!, `http://${req.headers.host}`);
    const token = url.searchParams.get("token");

    if (!token) {
      ws.close(4001, "Missing token");
      return;
    }

    try {
      const claims = await getPrivy().utils().auth().verifyAuthToken(token);
      ws.privyId = claims.user_id;
    } catch {
      ws.close(4001, "Invalid token");
      return;
    }

    ws.send(JSON.stringify({ type: "connected", privyId: ws.privyId }));

    // ── Message handling ──────────────────────────────────────────────────
    ws.on("message", async (raw) => {
      let msg: { type: string; deploymentId?: string };

      try {
        msg = JSON.parse(raw.toString());
      } catch {
        ws.send(JSON.stringify({ type: "error", message: "Invalid JSON" }));
        return;
      }

      if (msg.type === "subscribe" && msg.deploymentId) {
        // Verify ownership before subscribing
        const [deployment] = await db
          .select()
          .from(deployments)
          .where(eq(deployments.id, msg.deploymentId));

        if (!deployment || deployment.userId !== ws.privyId) {
          ws.send(
            JSON.stringify({ type: "error", message: "Deployment not found" }),
          );
          return;
        }

        ws.subscribedDeploymentId = msg.deploymentId;
        ws.send(
          JSON.stringify({
            type: "subscribed",
            deploymentId: msg.deploymentId,
          }),
        );
      }

      if (msg.type === "unsubscribe") {
        ws.subscribedDeploymentId = undefined;
        ws.send(JSON.stringify({ type: "unsubscribed" }));
      }

      if (msg.type === "ping") {
        ws.send(JSON.stringify({ type: "pong" }));
      }
    });

    ws.on("pong", () => {
      ws.isAlive = true;
    });

    ws.on("close", () => {
      ws.subscribedDeploymentId = undefined;
    });
  });

  // ── Broadcast deployment events to subscribed clients ──────────────────
  deploymentEmitter.on("status", (deploymentId: string, status: string) => {
    wss.clients.forEach((client) => {
      const sock = client as AuthedSocket;
      if (
        sock.readyState === WebSocket.OPEN &&
        sock.subscribedDeploymentId === deploymentId
      ) {
        sock.send(JSON.stringify({ type: "status", deploymentId, status }));
      }
    });
  });

  deploymentEmitter.on(
    "log",
    (deploymentId: string, level: string, message: string) => {
      wss.clients.forEach((client) => {
        const sock = client as AuthedSocket;
        if (
          sock.readyState === WebSocket.OPEN &&
          sock.subscribedDeploymentId === deploymentId
        ) {
          sock.send(
            JSON.stringify({ type: "log", deploymentId, level, message }),
          );
        }
      });
    },
  );

  // ── Heartbeat interval ────────────────────────────────────────────────────
  const heartbeat = setInterval(() => {
    wss.clients.forEach((client) => {
      const sock = client as AuthedSocket;
      if (!sock.isAlive) {
        sock.terminate();
        return;
      }
      sock.isAlive = false;
      sock.ping();
    });
  }, 30_000);

  wss.on("close", () => clearInterval(heartbeat));

  return wss;
}
