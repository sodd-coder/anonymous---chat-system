const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

const rooms = {};

io.on('connection', (socket) => {

  socket.on('create-room', () => {
    const roomCode = uuidv4().substring(0, 6).toUpperCase();
    rooms[roomCode] = { users: [] };
    socket.emit('room-created', roomCode);
  });

  socket.on('join-room', ({ roomCode, username }) => {
    if (rooms[roomCode]) {
      socket.join(roomCode);
      rooms[roomCode].users.push(username);
      socket.roomCode = roomCode;
      socket.username = username;
      io.to(roomCode).emit('user-joined', `${username} has joined the room`);
      io.to(roomCode).emit('user-count', rooms[roomCode].users.length);
      socket.emit('join-success', roomCode);
    } else {
      socket.emit('join-error', 'Room not found. Check the code and try again.');
    }
  });

  socket.on('send-message', ({ roomCode, username, message }) => {
    console.log(`[ENCRYPTED MESSAGE from ${username}]: ${message}`);
    io.to(roomCode).emit('receive-message', { username, message });
  });

  // Typing indicator
  socket.on('typing', ({ roomCode, username }) => {
    socket.to(roomCode).emit('user-typing', username);
  });

  socket.on('stop-typing', ({ roomCode }) => {
    socket.to(roomCode).emit('user-stop-typing');
  });

  socket.on('disconnect', () => {
    if (socket.roomCode && socket.username) {
      io.to(socket.roomCode).emit('user-left', `${socket.username} has left the room`);
      if (rooms[socket.roomCode]) {
        rooms[socket.roomCode].users = rooms[socket.roomCode].users.filter(
          u => u !== socket.username
        );
        io.to(socket.roomCode).emit('user-count', rooms[socket.roomCode].users.length);
        if (rooms[socket.roomCode].users.length === 0) {
          delete rooms[socket.roomCode];
        }
      }
    }
  });

});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});