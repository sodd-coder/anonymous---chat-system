const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 50e6 });

app.use(express.static('public'));

app.get('/', (req, res) => {
  res.sendFile(__dirname + '/public/landing.html');
});

const rooms = {};

io.on('connection', (socket) => {

  // Create room (called from index.html)
  socket.on('create-room', () => {
    const roomCode = uuidv4().substring(0, 6).toUpperCase();
    rooms[roomCode] = { users: [] };
    socket.emit('room-created', roomCode);
  });

  // Join room (called from index.html for joiners)
  socket.on('join-room', ({ roomCode, username }) => {
    if (rooms[roomCode]) {
      socket.join(roomCode);
      rooms[roomCode].users.push(username);
      socket.roomCode = roomCode;
      socket.username = username;
      io.to(roomCode).emit('user-joined', `${username} joined the room`);
      io.to(roomCode).emit('user-count', rooms[roomCode].users.length);
      socket.emit('join-success', roomCode);
    } else {
      socket.emit('join-error', 'Room not found. Check the code and try again.');
    }
  });

  // ── FIX: Re-register socket when chat page loads (no duplicate join event)
  socket.on('register-in-room', ({ roomCode, username }) => {
    if (rooms[roomCode]) {
      socket.join(roomCode);
      // Only add user if not already in the list
      if (!rooms[roomCode].users.includes(username)) {
        rooms[roomCode].users.push(username);
        io.to(roomCode).emit('user-joined', `${username} joined the room`);
      }
      socket.roomCode = roomCode;
      socket.username = username;
      io.to(roomCode).emit('user-count', rooms[roomCode].users.length);
      socket.emit('room-registered');
    } else {
      socket.emit('join-error', 'Room expired or not found.');
    }
  });

  // Messages
  socket.on('send-message', ({ roomCode, username, message }) => {
    io.to(roomCode).emit('receive-message', { username, message });
  });

  // Files
  socket.on('send-file', ({ roomCode, username, fileName, fileType, fileData }) => {
    io.to(roomCode).emit('receive-file', { username, fileName, fileType, fileData });
  });

  // Typing
  socket.on('typing', ({ roomCode, username }) => {
    socket.to(roomCode).emit('user-typing', username);
  });
  socket.on('stop-typing', ({ roomCode }) => {
    socket.to(roomCode).emit('user-stop-typing');
  });

  // Disconnect
  socket.on('disconnect', () => {
    if (socket.roomCode && socket.username) {
      io.to(socket.roomCode).emit('user-left', `${socket.username} left the room`);
      if (rooms[socket.roomCode]) {
        rooms[socket.roomCode].users = rooms[socket.roomCode].users.filter(u => u !== socket.username);
        io.to(socket.roomCode).emit('user-count', rooms[socket.roomCode].users.length);
        if (rooms[socket.roomCode].users.length === 0) delete rooms[socket.roomCode];
      }
    }
  });

});

const PORT = process.env.PORT || 8080;
server.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));