const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 50e6 });

const rooms = {};

// ── ROUTES ──
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'landing.html')));
app.get('/app', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/chat.html', (req, res) => res.sendFile(path.join(__dirname, 'public', 'chat.html')));
app.use(express.static(path.join(__dirname, 'public')));

// ── SOCKET ──
io.on('connection', (socket) => {

  // Step 1 (index.html): generate a code only — no room yet
  socket.on('generate-code', () => {
    const code = uuidv4().substring(0, 6).toUpperCase();
    socket.emit('code-generated', code);
  });

  // Step 1b (index.html): check room exists before joiner redirects
  socket.on('check-room', ({ roomCode }) => {
    if (rooms[roomCode]) {
      socket.emit('room-valid');
    } else {
      socket.emit('join-error', 'Room not found. Check your code.');
    }
  });

  // Step 2 (chat.html): actually create or join the room
  socket.on('register-in-room', ({ roomCode, username, isCreator }) => {
    if (isCreator) {
      // Always create room fresh for creator
      rooms[roomCode] = { users: [] };
    }
    if (!rooms[roomCode]) {
      socket.emit('join-error', 'Room not found or expired.');
      return;
    }
    socket.join(roomCode);
    socket.roomCode = roomCode;
    socket.username = username;
    if (!rooms[roomCode].users.includes(username)) {
      rooms[roomCode].users.push(username);
      io.to(roomCode).emit('user-joined', `${username} joined the room`);
    }
    io.to(roomCode).emit('user-count', rooms[roomCode].users.length);
    socket.emit('room-registered');
  });

  socket.on('send-message', ({ roomCode, username, message }) => {
    io.to(roomCode).emit('receive-message', { username, message });
  });

  socket.on('send-file', ({ roomCode, username, fileName, fileType, fileData }) => {
    io.to(roomCode).emit('receive-file', { username, fileName, fileType, fileData });
  });

  socket.on('typing', ({ roomCode, username }) => {
    socket.to(roomCode).emit('user-typing', username);
  });

  socket.on('stop-typing', ({ roomCode }) => {
    socket.to(roomCode).emit('user-stop-typing');
  });

  socket.on('disconnect', () => {
    const { roomCode, username } = socket;
    if (roomCode && username && rooms[roomCode]) {
      rooms[roomCode].users = rooms[roomCode].users.filter(u => u !== username);
      io.to(roomCode).emit('user-left', `${username} left the room`);
      io.to(roomCode).emit('user-count', rooms[roomCode].users.length);
      if (rooms[roomCode].users.length === 0) delete rooms[roomCode];
    }
  });

});

const PORT = process.env.PORT || 8080;
server.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));