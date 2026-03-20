const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 50e6 });

const rooms = {};

// ── ROUTES (must come BEFORE static middleware) ──
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'landing.html'));
});
app.get('/chat', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'chat.html'));
});
app.get('/app', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Static files (after routes)
app.use(express.static(path.join(__dirname, 'public')));

// ── SOCKET.IO ──
io.on('connection', (socket) => {

  socket.on('create-room', () => {
    const roomCode = uuidv4().substring(0, 6).toUpperCase();
    socket.emit('room-created', roomCode);
  });

  socket.on('check-room', ({ roomCode }) => {
    if (rooms[roomCode]) {
      socket.emit('room-valid');
    } else {
      socket.emit('join-error', 'Room not found. Check the code and try again.');
    }
  });

  socket.on('register-in-room', ({ roomCode, username, isCreator }) => {
    if (isCreator && !rooms[roomCode]) {
      rooms[roomCode] = { users: [] };
    }
    if (rooms[roomCode]) {
      socket.join(roomCode);
      socket.roomCode = roomCode;
      socket.username = username;
      if (!rooms[roomCode].users.includes(username)) {
        rooms[roomCode].users.push(username);
        io.to(roomCode).emit('user-joined', `${username} joined the room`);
      }
      io.to(roomCode).emit('user-count', rooms[roomCode].users.length);
      socket.emit('room-registered');
    } else {
      socket.emit('join-error', 'Room not found or expired.');
    }
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
    if (socket.roomCode && socket.username && rooms[socket.roomCode]) {
      rooms[socket.roomCode].users = rooms[socket.roomCode].users.filter(u => u !== socket.username);
      io.to(socket.roomCode).emit('user-left', `${socket.username} left the room`);
      io.to(socket.roomCode).emit('user-count', rooms[socket.roomCode].users.length);
      if (rooms[socket.roomCode].users.length === 0) delete rooms[socket.roomCode];
    }
  });

});

const PORT = process.env.PORT || 8080;
server.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));