import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);

// CORS configuration for Render and multi-origin requests
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
  pingTimeout: 60000,
  pingInterval: 25000,
});

const PORT = Number(process.env.PORT) || 3000;

// Matchmaking queues
const waitingVideoQueue = [];
const waitingTextQueue = [];
const activePairs = new Map(); // socketId -> { partnerId, roomId, mode }

let realConnections = 0;

function getSimulatedOnlineCount() {
  const base = 1520;
  const variation = Math.floor(Math.sin(Date.now() / 15000) * 180) + Math.floor(Math.random() * 25);
  const count = base + variation + realConnections;
  return Math.max(1000, Math.min(2000, count));
}

function broadcastStats() {
  const totalOnline = getSimulatedOnlineCount();
  const inQueue = waitingVideoQueue.length + waitingTextQueue.length;
  io.emit('stats:update', {
    onlineUsers: totalOnline,
    waitingInQueue: inQueue,
    activeChats: Math.floor(activePairs.size / 2),
  });
}

function removeFromQueues(socketId) {
  const vIndex = waitingVideoQueue.findIndex((u) => u.socketId === socketId);
  if (vIndex !== -1) waitingVideoQueue.splice(vIndex, 1);

  const tIndex = waitingTextQueue.findIndex((u) => u.socketId === socketId);
  if (tIndex !== -1) waitingTextQueue.splice(tIndex, 1);
}

function cleanupUserPairing(socketId, notifyPartner = true) {
  const pairInfo = activePairs.get(socketId);
  if (!pairInfo) return;

  const { partnerId, roomId } = pairInfo;
  activePairs.delete(socketId);
  activePairs.delete(partnerId);

  const partnerSocket = io.sockets.sockets.get(partnerId);
  if (partnerSocket) {
    partnerSocket.leave(roomId);
    if (notifyPartner) {
      partnerSocket.emit('partner:disconnected', {
        message: 'Stranger has disconnected or left the chat.',
      });
    }
  }

  const selfSocket = io.sockets.sockets.get(socketId);
  if (selfSocket) {
    selfSocket.leave(roomId);
  }

  broadcastStats();
}

function handlePairing(socket, mode, interests = []) {
  cleanupUserPairing(socket.id, false);
  removeFromQueues(socket.id);

  const targetQueue = mode === 'video' ? waitingVideoQueue : waitingTextQueue;

  while (targetQueue.length > 0) {
    const candidate = targetQueue.shift();
    if (!candidate) break;

    const partnerSocket = io.sockets.sockets.get(candidate.socketId);
    if (partnerSocket && partnerSocket.connected && partnerSocket.id !== socket.id) {
      const roomId = `room_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

      socket.join(roomId);
      partnerSocket.join(roomId);

      activePairs.set(socket.id, { partnerId: partnerSocket.id, roomId, mode });
      activePairs.set(partnerSocket.id, { partnerId: socket.id, roomId, mode });

      console.log(`[MATCH] Paired ${socket.id} <-> ${partnerSocket.id} in ${roomId} (${mode})`);

      socket.emit('match:found', {
        roomId,
        partnerId: partnerSocket.id,
        isInitiator: true,
        mode,
      });

      partnerSocket.emit('match:found', {
        roomId,
        partnerId: socket.id,
        isInitiator: false,
        mode,
      });

      broadcastStats();
      return;
    }
  }

  targetQueue.push({
    socketId: socket.id,
    mode,
    interests,
    joinedAt: Date.now(),
  });

  socket.emit('match:waiting', { mode, position: targetQueue.length });
  console.log(`[QUEUE] User ${socket.id} waiting for ${mode}. Queue size: ${targetQueue.length}`);
  broadcastStats();
}

io.on('connection', (socket) => {
  realConnections++;
  console.log(`[CONNECT] User connected: ${socket.id}`);
  broadcastStats();

  socket.on('chat:find', (data) => {
    const mode = data?.mode === 'video' ? 'video' : 'text';
    handlePairing(socket, mode, data?.interests || []);
  });

  socket.on('signal:offer', (payload) => {
    io.to(payload.to).emit('signal:offer', {
      from: socket.id,
      sdp: payload.sdp,
    });
  });

  socket.on('signal:answer', (payload) => {
    io.to(payload.to).emit('signal:answer', {
      from: socket.id,
      sdp: payload.sdp,
    });
  });

  socket.on('signal:candidate', (payload) => {
    io.to(payload.to).emit('signal:candidate', {
      from: socket.id,
      candidate: payload.candidate,
    });
  });

  socket.on('chat:message', (payload) => {
    const pair = activePairs.get(socket.id);
    if (pair && payload?.text) {
      const text = String(payload.text).slice(0, 1000);
      io.to(pair.partnerId).emit('chat:message', {
        sender: 'stranger',
        text,
        timestamp: Date.now(),
      });
    }
  });

  socket.on('chat:typing', (payload) => {
    const pair = activePairs.get(socket.id);
    if (pair) {
      io.to(pair.partnerId).emit('chat:typing', {
        isTyping: !!payload?.isTyping,
      });
    }
  });

  socket.on('chat:skip', (data) => {
    const currentPair = activePairs.get(socket.id);
    const mode = data?.nextMode || currentPair?.mode || 'video';
    cleanupUserPairing(socket.id, true);
    handlePairing(socket, mode);
  });

  socket.on('chat:stop', () => {
    removeFromQueues(socket.id);
    cleanupUserPairing(socket.id, true);
    socket.emit('chat:stopped');
  });

  socket.on('chat:report', (data) => {
    const currentPair = activePairs.get(socket.id);
    console.warn(`[REPORT] User ${socket.id} reported partner ${currentPair?.partnerId}: ${data?.reason}`);
    cleanupUserPairing(socket.id, true);
    socket.emit('report:acknowledged', { message: 'Stranger reported and disconnected successfully.' });
  });

  socket.on('disconnect', () => {
    realConnections = Math.max(0, realConnections - 1);
    removeFromQueues(socket.id);
    cleanupUserPairing(socket.id, true);
    broadcastStats();
  });
});

app.use(express.json());

// API health check
app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'GupShup TV Signaling Server',
    onlineUsers: getSimulatedOnlineCount(),
    timestamp: new Date().toISOString(),
  });
});

// Serve frontend assets (supports both built dist or standalone public static files)
const distPath = path.join(__dirname, 'dist');
const publicPath = path.join(__dirname, 'public');

app.use(express.static(distPath));
app.use(express.static(publicPath));
app.use(express.static(__dirname));

app.get('*', (_req, res) => {
  if (process.env.NODE_ENV === 'production') {
    res.sendFile(path.join(distPath, 'index.html'));
  } else {
    res.sendFile(path.join(__dirname, 'index.html'));
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🔥 GupShup TV Server running on port ${PORT}`);
});
