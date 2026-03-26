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
const ATTEMPT_WINDOW_MS = 60 * 1000;
const MAX_ATTEMPTS = 10;

// ── STORES ──
const rooms = {};
const codeAttempts = {};
const reputationStore = {};

// ── ROOM TYPES ──
const ROOM_TYPES = {
  normal:     { label: 'Normal',     emoji: '💬', sdSeconds: 0,  noUsernames: false, maxMsgLen: 1000, promptEnabled: false },
  vanish:     { label: 'Vanish',     emoji: '🔥', sdSeconds: 30, noUsernames: false, maxMsgLen: 1000, promptEnabled: false },
  rapid:      { label: 'Rapid',      emoji: '⚡', sdSeconds: 0,  noUsernames: false, maxMsgLen: 100,  promptEnabled: false },
  confession: { label: 'Confession', emoji: '🎭', sdSeconds: 0,  noUsernames: true,  maxMsgLen: 500,  promptEnabled: true  },
  study:      { label: 'Study',      emoji: '📚', sdSeconds: 0,  noUsernames: false, maxMsgLen: 1000, promptEnabled: true  },
};

const PROMPTS = [
  "Hot take: what's something everyone agrees on that you think is wrong?",
  "What's something you've never told anyone?",
  "What's the most underrated thing in the world right now?",
  "Unpopular opinion — go.",
  "What would you do if you knew nobody would ever find out?",
  "What's something you believe that most people around you don't?",
  "Describe your current mood in exactly 3 words.",
  "What's something you're secretly proud of?",
  "What's a hill you'll die on?",
  "What's your most controversial opinion about something mundane?",
];

// ── ROUTES ──
// ── ROUTES ──
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'landing.html')));
app.get('/app', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/chat', (req, res) => res.sendFile(path.join(__dirname, 'public', 'chat.html')));
// Clean room URL: /room/XXXXXX → serves chat.html
app.get('/room/:code', (req, res) => res.sendFile(path.join(__dirname, 'public', 'chat.html')));
// Legacy redirects
app.get('/chat.html', (req, res) => res.redirect('/chat'));
app.use(express.static(path.join(__dirname, 'public')));
// Legacy redirect
app.get('/chat.html', (req, res) => res.redirect('/chat'));
app.use(express.static(path.join(__dirname, 'public')));

// ── HELPERS ──
function getDeviceHash(socket) {
  const ip = socket.handshake.address;
  const ua = socket.handshake.headers['user-agent'] || '';
  return crypto.createHash('sha256').update(ip + ua + 'anonchat-v2-salt').digest('hex').substring(0, 16);
}

function getReputation(hash) {
  if (!reputationStore[hash]) reputationStore[hash] = { score: 0, lastSeen: Date.now(), reports: 0 };
  const mins = (Date.now() - reputationStore[hash].lastSeen) / 60000;
  reputationStore[hash].score = Math.max(0, reputationStore[hash].score - Math.floor(mins * 0.5));
  reputationStore[hash].lastSeen = Date.now();
  return reputationStore[hash];
}

function addRepScore(hash, amount) {
  const rep = getReputation(hash);
  rep.score = Math.min(100, rep.score + amount);
}

function getCooldown(score) {
  if (score < 10) return 500;
  if (score < 20) return 2000;
  if (score < 35) return 5000;
  return 10000;
}

function isShadowMuted(score) { return score >= 50 && score < 80; }
function isTempBlocked(score) { return score >= 80; }

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

function getRoomUserList(roomCode) {
  if (!rooms[roomCode]) return [];
  return rooms[roomCode].users.map(u => ({
    username: u,
    badge: rooms[roomCode].badges[u] || '👤',
    isCreator: u === rooms[roomCode].creator,
    isMuted: rooms[roomCode].mutedUsers.has(u),
    msgCount: rooms[roomCode].messageCounts[u] || 0,
  }));
}

function broadcastUserList(roomCode) {
  io.to(roomCode).emit('user-list', getRoomUserList(roomCode));
}

// ── SOCKET ──
io.on('connection', (socket) => {
  const ip = socket.handshake.address;
  const deviceHash = getDeviceHash(socket);
  socket.deviceHash = deviceHash;

  const rep = getReputation(deviceHash);
  if (isTempBlocked(rep.score)) {
    socket.emit('temp-blocked', 'You have been temporarily blocked due to suspicious activity.');
    socket.disconnect();
    return;
  }

  // ── ROOM SETUP ──
  socket.on('generate-code', () => {
    socket.emit('code-generated', uuidv4().substring(0, 6).toUpperCase());
  });

  socket.on('check-room', ({ roomCode }) => {
    if (checkBruteForce(ip)) {
      addRepScore(deviceHash, 3);
      socket.emit('join-error', 'Too many attempts. Please wait a minute.');
      return;
    }
    if (!rooms[roomCode]) { socket.emit('join-error', 'Room not found. Check your code.'); return; }
    if (rooms[roomCode].users.length >= MAX_USERS) { socket.emit('join-error', `Room is full. Max ${MAX_USERS} users.`); return; }
    if (rooms[roomCode].locked) { socket.emit('join-error', 'This room is locked by the admin.'); return; }
    if (codeAttempts[ip]) codeAttempts[ip].count = 0;
    socket.emit('room-valid', {
      roomType: rooms[roomCode].roomType,
      config: rooms[roomCode].config,
    });
  });

  socket.on('register-in-room', ({ roomCode, username, isCreator, roomType }) => {
    if (isCreator) {
      const type = ROOM_TYPES[roomType] || ROOM_TYPES.normal;
      rooms[roomCode] = {
        users: [],
        expiryTimer: null,
        createdAt: Date.now(),
        sessionSalt: crypto.randomBytes(16).toString('hex'),
        messageHistory: [],
        roomType: roomType || 'normal',
        config: type,
        creator: username,
        mutedUsers: new Set(),
        locked: false,
        badges: {},
        messageCounts: {},
        currentPrompt: type.promptEnabled ? PROMPTS[Math.floor(Math.random() * PROMPTS.length)] : null,
      };
      resetExpiry(roomCode);
    }

    if (!rooms[roomCode]) { socket.emit('join-error', 'Room not found or expired.'); return; }
    if (rooms[roomCode].locked && username !== rooms[roomCode].creator) { socket.emit('join-error', 'This room is locked.'); return; }
    if (!isCreator && rooms[roomCode].users.length >= MAX_USERS) { socket.emit('join-error', 'Room is full.'); return; }

    socket.join(roomCode);
    socket.roomCode = roomCode;
    socket.username = username;
    socket.messageCount = 0;
    socket.lastMessageTime = 0;
    socket.rateLimitReset = null;

    if (!rooms[roomCode].users.includes(username)) {
      rooms[roomCode].users.push(username);
      rooms[roomCode].messageCounts[username] = 0;
      rooms[roomCode].badges[username] = isCreator ? '👑' : '👤';
      io.to(roomCode).emit('user-joined', { username, time: Date.now() });
    }

    io.to(roomCode).emit('user-count', rooms[roomCode].users.length);
    broadcastUserList(roomCode);

    socket.emit('room-registered', {
      sessionSalt: rooms[roomCode].sessionSalt,
      history: rooms[roomCode].messageHistory,
      roomType: rooms[roomCode].roomType,
      config: rooms[roomCode].config,
      isAdmin: username === rooms[roomCode].creator,
      prompt: rooms[roomCode].currentPrompt,
      creator: rooms[roomCode].creator,
    });
    resetExpiry(roomCode);
  });

  // ── MESSAGING ──
  socket.on('send-message', ({ roomCode, username, message, msgId, replyTo, checksum, sdSeconds }) => {
    if (!rooms[roomCode]) return;
    const room = rooms[roomCode];
    if (room.mutedUsers.has(username)) { socket.emit('you-are-muted'); return; }

    const rep = getReputation(deviceHash);
    const now = Date.now();

    // Shadow mute
    if (isShadowMuted(rep.score)) {
      socket.emit('receive-message', { username, message, time: now, msgId, replyTo: replyTo || null, checksum, sdSeconds: sdSeconds || 0 });
      return;
    }

    // Progressive cooldown
    const cooldown = getCooldown(rep.score);
    if (now - socket.lastMessageTime < cooldown) {
      addRepScore(deviceHash, 2);
      const wait = Math.ceil((cooldown - (now - socket.lastMessageTime)) / 1000);
      socket.emit('rate-limited', `Slow down! Wait ${wait}s.`);
      return;
    }

    // Burst limit
    if (!socket.rateLimitReset || now > socket.rateLimitReset) { socket.messageCount = 0; socket.rateLimitReset = now + 5000; }
    socket.messageCount++;
    if (socket.messageCount > 10) {
      addRepScore(deviceHash, 5);
      socket.emit('rate-limited', 'Too many messages. Please wait.');
      return;
    }

    socket.lastMessageTime = now;
    resetExpiry(roomCode);

    // Update badge
    room.messageCounts[username] = (room.messageCounts[username] || 0) + 1;
    if (room.messageCounts[username] === 10 && room.badges[username] === '👤') {
      room.badges[username] = '🔥';
      broadcastUserList(roomCode);
    } else if (room.messageCounts[username] === 50 && room.badges[username] === '🔥') {
      room.badges[username] = '⚡';
      broadcastUserList(roomCode);
    }

    const effectiveSd = room.config.sdSeconds > 0 ? room.config.sdSeconds : (sdSeconds || 0);
    const msgObj = { username, message, time: now, msgId, replyTo: replyTo || null, checksum, sdSeconds: effectiveSd };
    room.messageHistory.push(msgObj);
    if (room.messageHistory.length > 100) room.messageHistory.shift();
    io.to(roomCode).emit('receive-message', msgObj);
  });

  socket.on('send-voice', ({ roomCode, username, voiceData, duration, sdSeconds }) => {
    if (!rooms[roomCode]) return;
    if (rooms[roomCode].mutedUsers.has(username)) { socket.emit('you-are-muted'); return; }
    resetExpiry(roomCode);
    const effectiveSd = rooms[roomCode].config.sdSeconds > 0 ? rooms[roomCode].config.sdSeconds : (sdSeconds || 0);
    const msgObj = { type: 'voice', username, voiceData, duration, time: Date.now(), sdSeconds: effectiveSd };
    rooms[roomCode].messageHistory.push(msgObj);
    if (rooms[roomCode].messageHistory.length > 100) rooms[roomCode].messageHistory.shift();
    io.to(roomCode).emit('receive-voice', { username, voiceData, duration, time: Date.now(), sdSeconds: effectiveSd });
  });

  socket.on('send-file', ({ roomCode, username, fileName, fileType, fileData, sdSeconds }) => {
    if (!rooms[roomCode]) return;
    if (rooms[roomCode].mutedUsers.has(username)) { socket.emit('you-are-muted'); return; }
    resetExpiry(roomCode);
    const effectiveSd = rooms[roomCode].config.sdSeconds > 0 ? rooms[roomCode].config.sdSeconds : (sdSeconds || 0);
    io.to(roomCode).emit('receive-file', { username, fileName, fileType, fileData, time: Date.now(), sdSeconds: effectiveSd });
  });

  socket.on('send-reaction', ({ roomCode, msgId, emoji, username }) => {
    if (!rooms[roomCode]) return;
    resetExpiry(roomCode);
    io.to(roomCode).emit('receive-reaction', { msgId, emoji, username });
  });

  socket.on('message-seen', ({ roomCode, msgId, username }) => {
    socket.to(roomCode).emit('message-seen', { msgId, username });
  });

  socket.on('typing', ({ roomCode, username }) => { socket.to(roomCode).emit('user-typing', username); });
  socket.on('stop-typing', ({ roomCode }) => { socket.to(roomCode).emit('user-stop-typing'); });

  // ── ADMIN ──
  socket.on('admin-mute', ({ roomCode, targetUsername }) => {
    if (!rooms[roomCode] || rooms[roomCode].creator !== socket.username) return;
    rooms[roomCode].mutedUsers.add(targetUsername);
    io.to(roomCode).emit('user-muted', targetUsername);
    broadcastUserList(roomCode);
    const ts = [...io.sockets.sockets.values()].find(s => s.username === targetUsername && s.roomCode === roomCode);
    if (ts) ts.emit('you-are-muted');
  });

  socket.on('admin-unmute', ({ roomCode, targetUsername }) => {
    if (!rooms[roomCode] || rooms[roomCode].creator !== socket.username) return;
    rooms[roomCode].mutedUsers.delete(targetUsername);
    io.to(roomCode).emit('user-unmuted', targetUsername);
    broadcastUserList(roomCode);
  });

  socket.on('admin-kick', ({ roomCode, targetUsername }) => {
    if (!rooms[roomCode] || rooms[roomCode].creator !== socket.username) return;
    const ts = [...io.sockets.sockets.values()].find(s => s.username === targetUsername && s.roomCode === roomCode);
    if (ts) { ts.emit('you-were-kicked'); ts.leave(roomCode); }
    rooms[roomCode].users = rooms[roomCode].users.filter(u => u !== targetUsername);
    io.to(roomCode).emit('user-kicked', targetUsername);
    io.to(roomCode).emit('user-count', rooms[roomCode].users.length);
    broadcastUserList(roomCode);
  });

  socket.on('admin-lock', ({ roomCode }) => {
    if (!rooms[roomCode] || rooms[roomCode].creator !== socket.username) return;
    rooms[roomCode].locked = !rooms[roomCode].locked;
    io.to(roomCode).emit('room-lock-changed', rooms[roomCode].locked);
  });

  socket.on('report-user', ({ roomCode, targetUsername }) => {
    if (!rooms[roomCode]) return;
    const ts = [...io.sockets.sockets.values()].find(s => s.username === targetUsername && s.roomCode === roomCode);
    if (ts?.deviceHash) {
      addRepScore(ts.deviceHash, 15);
      reputationStore[ts.deviceHash].reports = (reputationStore[ts.deviceHash].reports || 0) + 1;
    }
    socket.emit('report-received');
  });

  // ── DISCONNECT ──
  socket.on('disconnect', () => {
    const { roomCode, username } = socket;
    if (roomCode && username && rooms[roomCode]) {
      rooms[roomCode].users = rooms[roomCode].users.filter(u => u !== username);
      io.to(roomCode).emit('user-left', { username, time: Date.now() });
      io.to(roomCode).emit('user-count', rooms[roomCode].users.length);
      broadcastUserList(roomCode);
      if (rooms[roomCode].users.length === 0) {
        clearTimeout(rooms[roomCode].expiryTimer);
        delete rooms[roomCode];
      }
    }
  });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, '0.0.0.0', () => console.log(`Server on port ${PORT}`));