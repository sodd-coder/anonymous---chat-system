const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 50e6,
  pingTimeout: 60000,
  pingInterval: 25000,
  reconnection: true
});

const rooms = {};
const MAX_USERS = 20;
const ROOM_EXPIRY_MS = 30 * 60 * 1000;
const RATE_LIMIT_MS = 500;
const RATE_LIMIT_MAX = 10;
const codeAttempts = {};
const MAX_ATTEMPTS = 10;
const ATTEMPT_WINDOW_MS = 60 * 1000;

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'landing.html')));
app.get('/app', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/chat.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'chat.html')));
app.use(express.static(path.join(__dirname, 'public')));

function resetExpiry(roomCode) {
  if (!rooms[roomCode]) return;
  clearTimeout(rooms[roomCode].expiryTimer);
  rooms[roomCode].expiryTimer = setTimeout(() => {
    if (rooms[roomCode]) {
      io.to(roomCode).emit('room-expired');
      io.socketsLeave(roomCode);
      delete rooms[roomCode];
    }
  }, ROOM_EXPIRY_MS);
}

function checkBruteForce(ip) {
  const now = Date.now();
  if (!codeAttempts[ip]) codeAttempts[ip] = { count: 0, resetAt: now + ATTEMPT_WINDOW_MS };
  if (now > codeAttempts[ip].resetAt) codeAttempts[ip] = { count: 0, resetAt: now + ATTEMPT_WINDOW_MS };
  codeAttempts[ip].count++;
  return codeAttempts[ip].count > MAX_ATTEMPTS;
}

io.on('connection', (socket) => {
  const ip = socket.handshake.address;

  socket.on('generate-code', () => {
    socket.emit('code-generated', uuidv4().substring(0, 6).toUpperCase());
  });

  socket.on('check-room', ({ roomCode }) => {
    if (checkBruteForce(ip)) { socket.emit('join-error', 'Too many attempts. Please wait a minute.'); return; }
    if (!rooms[roomCode]) { socket.emit('join-error', 'Room not found. Check your code.'); return; }
    if (rooms[roomCode].users.length >= MAX_USERS) { socket.emit('join-error', `Room is full. Max ${MAX_USERS} users.`); return; }
    if (codeAttempts[ip]) codeAttempts[ip].count = 0;
    socket.emit('room-valid');
  });

  socket.on('register-in-room', ({ roomCode, username, isCreator }) => {
    if (isCreator) {
      rooms[roomCode] = {
        users: [],
        expiryTimer: null,
        createdAt: Date.now(),
        sessionSalt: crypto.randomBytes(16).toString('hex'),
        messageHistory: []
      };
      resetExpiry(roomCode);
    }
    if (!rooms[roomCode]) { socket.emit('join-error', 'Room not found or expired.'); return; }
    if (!isCreator && rooms[roomCode].users.length >= MAX_USERS) { socket.emit('join-error', 'Room is full.'); return; }

    socket.join(roomCode);
    socket.roomCode = roomCode;
    socket.username = username;
    socket.messageCount = 0;
    socket.lastMessageTime = 0;
    socket.rateLimitReset = null;

    if (!rooms[roomCode].users.includes(username)) {
      rooms[roomCode].users.push(username);
      io.to(roomCode).emit('user-joined', { username, time: Date.now() });
    }

    io.to(roomCode).emit('user-count', rooms[roomCode].users.length);
    socket.emit('room-registered', {
      sessionSalt: rooms[roomCode].sessionSalt,
      history: rooms[roomCode].messageHistory
    });
    resetExpiry(roomCode);
  });

  socket.on('send-message', ({ roomCode, username, message, msgId, replyTo, checksum }) => {
    const now = Date.now();
    if (now - socket.lastMessageTime < RATE_LIMIT_MS) { socket.emit('rate-limited', 'Slow down!'); return; }
    if (!socket.rateLimitReset || now > socket.rateLimitReset) { socket.messageCount = 0; socket.rateLimitReset = now + 5000; }
    socket.messageCount++;
    if (socket.messageCount > RATE_LIMIT_MAX) { socket.emit('rate-limited', 'Too many messages. Please wait.'); return; }
    socket.lastMessageTime = now;
    resetExpiry(roomCode);

    const msgObj = { username, message, time: now, msgId, replyTo: replyTo || null, checksum };
    if (rooms[roomCode]) {
      rooms[roomCode].messageHistory.push(msgObj);
      if (rooms[roomCode].messageHistory.length > 100) rooms[roomCode].messageHistory.shift();
    }
    io.to(roomCode).emit('receive-message', msgObj);
  });

  socket.on('message-seen', ({ roomCode, msgId, username }) => {
    socket.to(roomCode).emit('message-seen', { msgId, username });
  });

  socket.on('send-reaction', ({ roomCode, msgId, emoji, username }) => {
    if (!rooms[roomCode]) return;
    resetExpiry(roomCode);
    io.to(roomCode).emit('receive-reaction', { msgId, emoji, username });
  });

  socket.on('send-file', ({ roomCode, username, fileName, fileType, fileData }) => {
    resetExpiry(roomCode);
    io.to(roomCode).emit('receive-file', { username, fileName, fileType, fileData, time: Date.now() });
  });

  socket.on('typing', ({ roomCode, username }) => { socket.to(roomCode).emit('user-typing', username); });
  socket.on('stop-typing', ({ roomCode }) => { socket.to(roomCode).emit('user-stop-typing'); });

  socket.on('disconnect', () => {
    const { roomCode, username } = socket;
    if (roomCode && username && rooms[roomCode]) {
      rooms[roomCode].users = rooms[roomCode].users.filter(u => u !== username);
      io.to(roomCode).emit('user-left', { username, time: Date.now() });
      io.to(roomCode).emit('user-count', rooms[roomCode].users.length);
      if (rooms[roomCode].users.length === 0) { clearTimeout(rooms[roomCode].expiryTimer); delete rooms[roomCode]; }
    }
  });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));