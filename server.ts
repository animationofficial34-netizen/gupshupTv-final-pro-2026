import express from 'express';
import http from 'http';
import { Server, Socket } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);

// CORS configuration for Render and local development
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
interface QueuedUser {
  socketId: string;
  mode: 'video' | 'text';
  interests?: string[];
  joinedAt: number;
}

const waitingVideoQueue: QueuedUser[] = [];
const waitingTextQueue: QueuedUser[] = [];

// Track active pairings: socketId -> partnerSocketId
const activePairs = new Map<string, { partnerId: string; roomId: string; mode: 'video' | 'text' }>();

let realConnections = 0;

function getSimulatedOnlineCount(): number {
  // Fluctuates naturally between 1200 and 1850 based on time
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

function removeFromQueues(socketId: string) {
  const vIndex = waitingVideoQueue.findIndex((u) => u.socketId === socketId);
  if (vIndex !== -1) waitingVideoQueue.splice(vIndex, 1);

  const tIndex = waitingTextQueue.findIndex((u) => u.socketId === socketId);
  if (tIndex !== -1) waitingTextQueue.splice(tIndex, 1);
}

function handlePairing(socket: Socket, mode: 'video' | 'text', interests: string[] = []) {
  // If already paired, clean up first
  cleanupUserPairing(socket.id, false);
  removeFromQueues(socket.id);

  const targetQueue = mode === 'video' ? waitingVideoQueue : waitingTextQueue;

  // Filter out any stale sockets or self
  while (targetQueue.length > 0) {
    const candidate = targetQueue.shift();
    if (!candidate) break;

    const partnerSocket = io.sockets.sockets.get(candidate.socketId);
    if (partnerSocket && partnerSocket.connected && partnerSocket.id !== socket.id) {
      // Found a valid match!
      const roomId = `room_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

      socket.join(roomId);
      partnerSocket.join(roomId);

      activePairs.set(socket.id, { partnerId: partnerSocket.id, roomId, mode });
      activePairs.set(partnerSocket.id, { partnerId: socket.id, roomId, mode });

      console.log(`[MATCH] Paired ${socket.id} <-> ${partnerSocket.id} in ${roomId} (${mode})`);

      // Socket A is the initiator (creates WebRTC offer), Socket B waits for offer
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

  // No partner found yet, put user in queue
  targetQueue.push({
    socketId: socket.id,
    mode,
    interests,
    joinedAt: Date.now(),
  });

  socket.emit('match:waiting', { mode, position: targetQueue.length });
  console.log(`[QUEUE] User ${socket.id} joined waiting queue (${mode}). Queue size: ${targetQueue.length}`);
  broadcastStats();
}

function cleanupUserPairing(socketId: string, notifyPartner = true) {
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

// Socket.io Connection Handlers
io.on('connection', (socket: Socket) => {
  realConnections++;
  console.log(`[CONNECT] User connected: ${socket.id}. Real active: ${realConnections}`);
  broadcastStats();

  // Find stranger in selected mode
  socket.on('chat:find', (data: { mode: 'video' | 'text'; interests?: string[] }) => {
    const mode = data?.mode === 'video' ? 'video' : 'text';
    handlePairing(socket, mode, data?.interests || []);
  });

  // WebRTC Signaling: Offer
  socket.on('signal:offer', (payload: { to: string; sdp: any }) => {
    io.to(payload.to).emit('signal:offer', {
      from: socket.id,
      sdp: payload.sdp,
    });
  });

  // WebRTC Signaling: Answer
  socket.on('signal:answer', (payload: { to: string; sdp: any }) => {
    io.to(payload.to).emit('signal:answer', {
      from: socket.id,
      sdp: payload.sdp,
    });
  });

  // WebRTC Signaling: ICE Candidate
  socket.on('signal:candidate', (payload: { to: string; candidate: any }) => {
    io.to(payload.to).emit('signal:candidate', {
      from: socket.id,
      candidate: payload.candidate,
    });
  });

  // Chat message
  socket.on('chat:message', (payload: { text: string }) => {
    const pair = activePairs.get(socket.id);
    if (pair && payload?.text) {
      // Sanitize length
      const text = String(payload.text).slice(0, 1000);
      io.to(pair.partnerId).emit('chat:message', {
        sender: 'stranger',
        text,
        timestamp: Date.now(),
      });
    }
  });

  // Typing indicator
  socket.on('chat:typing', (payload: { isTyping: boolean }) => {
    const pair = activePairs.get(socket.id);
    if (pair) {
      io.to(pair.partnerId).emit('chat:typing', {
        isTyping: !!payload?.isTyping,
      });
    }
  });

  // User explicitly skips / leaves current partner
  socket.on('chat:skip', (data?: { nextMode?: 'video' | 'text' }) => {
    console.log(`[SKIP] User ${socket.id} skipped current chat`);
    const currentPair = activePairs.get(socket.id);
    const mode = data?.nextMode || currentPair?.mode || 'video';
    cleanupUserPairing(socket.id, true);
    // Find next stranger
    handlePairing(socket, mode);
  });

  // User stops chat completely
  socket.on('chat:stop', () => {
    console.log(`[STOP] User ${socket.id} stopped chat`);
    removeFromQueues(socket.id);
    cleanupUserPairing(socket.id, true);
    socket.emit('chat:stopped');
  });

  // Report stranger
  socket.on('chat:report', (data: { reason: string }) => {
    const currentPair = activePairs.get(socket.id);
    console.warn(`[REPORT] User ${socket.id} reported partner ${currentPair?.partnerId}: ${data?.reason}`);
    // Immediately disconnect the pairing
    cleanupUserPairing(socket.id, true);
    socket.emit('report:acknowledged', { message: 'Stranger reported and disconnected successfully.' });
  });

  // Disconnection
  socket.on('disconnect', () => {
    realConnections = Math.max(0, realConnections - 1);
    console.log(`[DISCONNECT] User disconnected: ${socket.id}`);
    removeFromQueues(socket.id);
    cleanupUserPairing(socket.id, true);
    broadcastStats();
  });
});

// App server bootstrap
async function startServer() {
  app.use(express.json());

  // Health check endpoint for Render / Cloud Run
  app.get('/api/health', (_req, res) => {
    res.json({
      status: 'ok',
      service: 'GupShup TV Signaling Server',
      onlineUsers: getSimulatedOnlineCount(),
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    });
  });

  // Vite integration: Dev middleware vs Static dist
  if (process.env.NODE_ENV === 'production') {
    app.use(express.static(path.join(__dirname, 'dist')));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(__dirname, 'dist', 'index.html'));
    });
  } else {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`=========================================`);
    console.log(`🔥 GupShup TV Server running on port ${PORT}`);
    console.log(`🚀 Ready for WebRTC video & text connections`);
    console.log(`=========================================`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start GupShup TV server:', err);
  process.exit(1);
});
