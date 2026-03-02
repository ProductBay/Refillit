const { WebSocketServer } = require("ws");
const { verifyAccessToken } = require("../utils/jwt");

const clients = new Map();

const emitToUser = (userId, payload) => {
  const sockets = clients.get(userId) || [];
  for (const socket of sockets) {
    if (socket.readyState === socket.OPEN) {
      socket.send(JSON.stringify(payload));
    }
  }
};

const createChatServer = (server) => {
  const wss = new WebSocketServer({ server, path: "/ws/chat" });
  wss.on("connection", (socket, req) => {
    try {
      const url = new URL(req.url, "http://localhost");
      const token = url.searchParams.get("token");
      const payload = verifyAccessToken(token || "");
      const userId = payload.id;
      const list = clients.get(userId) || [];
      list.push(socket);
      clients.set(userId, list);

      socket.on("close", () => {
        const next = (clients.get(userId) || []).filter((entry) => entry !== socket);
        clients.set(userId, next);
      });
    } catch (_error) {
      socket.close(1008, "Invalid token");
    }
  });
  return wss;
};

module.exports = {
  createChatServer,
  emitToUser,
};
