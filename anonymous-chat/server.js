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
  pingInterval: 25000
});

// ── CONSTANTS ──
const MAX_USERS = 20;
const ROOM_EXPIRY_MS = 30 * 60 * 1000;

// ── STORES ──
const rooms = {};

// ── ROOM TYPES ──
const ROOM_TYPES = {
  normal:     { label:'Normal', sdSeconds:0 },
  vanish:     { label:'Vanish', sdSeconds:30 },
  rapid:      { label:'Rapid', sdSeconds:0 },
  confession: { label:'Confession', sdSeconds:0 },
  study:      { label:'Study', sdSeconds:0 },
};

// ── ROUTES ──
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'landing.html')));
app.get('/app', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/chat', (req, res) => res.sendFile(path.join(__dirname, 'public', 'chat.html')));
app.get('/room/:code', (req, res) => res.sendFile(path.join(__dirname, 'public', 'chat.html')));
app.use(express.static(path.join(__dirname, 'public')));

// ── HELPERS ──
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

// ── SOCKET ──
io.on('connection', (socket) => {

  // Generate room code
  socket.on('generate-code', () => {
    socket.emit('code-generated', uuidv4().substring(0, 6).toUpperCase());
  });

  // Check room existence
  socket.on('check-room', ({ roomCode }) => {
    if (!rooms[roomCode]) {
      socket.emit('join-error', 'Room not found.');
      return;
    }

    if (rooms[roomCode].users.length >= MAX_USERS) {
      socket.emit('join-error', 'Room is full.');
      return;
    }

    if (rooms[roomCode].locked) {
      socket.emit('join-error', 'Room is locked.');
      return;
    }

    socket.emit('room-valid', {
      roomType: rooms[roomCode].roomType,
      config: rooms[roomCode].config
    });
  });

  // ── MAIN FIXED LOGIC ──
  socket.on('register-in-room', ({ roomCode, username, isCreator, roomType }) => {

    // ✅ FIX 1: ONLY create room if it does not exist
    if (isCreator && !rooms[roomCode]) {
      const type = ROOM_TYPES[roomType] || ROOM_TYPES.normal;

      rooms[roomCode] = {
        users: [],
        expiryTimer: null,
        createdAt: Date.now(),
        roomType: roomType || 'normal',
        config: type,
        creator: username,
        locked: false,
        messageCounts: {},
      };

      resetExpiry(roomCode);
    }

    // ❌ If still no room → reject
    if (!rooms[roomCode]) {
      socket.emit('join-error', 'Room not found or expired.');
      return;
    }

    // ✅ FIX 2: SERVER-SIDE CREATOR CHECK
    const actuallyCreator =
      username === rooms[roomCode].creator || isCreator;

    if (rooms[roomCode].locked && !actuallyCreator) {
      socket.emit('join-error', 'Room is locked.');
      return;
    }

    if (!actuallyCreator && rooms[roomCode].users.length >= MAX_USERS) {
      socket.emit('join-error', 'Room is full.');
      return;
    }

    // Join socket
    socket.join(roomCode);
    socket.roomCode = roomCode;
    socket.username = username;

    // Add user if not exists
    if (!rooms[roomCode].users.includes(username)) {
      rooms[roomCode].users.push(username);
      rooms[roomCode].messageCounts[username] = 0;

      io.to(roomCode).emit('user-joined', {
        username,
        time: Date.now()
      });
    }

    // Send room data
    socket.emit('room-registered', {
      roomType: rooms[roomCode].roomType,
      config: rooms[roomCode].config,
      isAdmin: username === rooms[roomCode].creator,
      creator: rooms[roomCode].creator
    });

    // Broadcast user list
    io.to(roomCode).emit('user-list', rooms[roomCode].users);
    io.to(roomCode).emit('user-count', rooms[roomCode].users.length);

    resetExpiry(roomCode);
  });

  // ── DISCONNECT ──
  socket.on('disconnect', () => {
    const { roomCode, username } = socket;

    if (!roomCode || !rooms[roomCode]) return;

    rooms[roomCode].users =
      rooms[roomCode].users.filter(u => u !== username);

    io.to(roomCode).emit('user-left', username);
    io.to(roomCode).emit('user-count', rooms[roomCode].users.length);

    if (rooms[roomCode].users.length === 0) {
      clearTimeout(rooms[roomCode].expiryTimer);
      delete rooms[roomCode];
    }
  });

});

server.listen(3000, () => {
  console.log("Server running on http://localhost:3000");
});