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
  normal:     { label:'Normal',     emoji:'💬', sdSeconds:0,  noUsernames:false, maxMsgLen:1000, promptEnabled:false },
  vanish:     { label:'Vanish',     emoji:'🔥', sdSeconds:30, noUsernames:false, maxMsgLen:1000, promptEnabled:false },
  rapid:      { label:'Rapid',      emoji:'⚡', sdSeconds:0,  noUsernames:false, maxMsgLen:100,  promptEnabled:false },
  confession: { label:'Confession', emoji:'🎭', sdSeconds:0,  noUsernames:true,  maxMsgLen:500,  promptEnabled:true  },
  study:      { label:'Study',      emoji:'📚', sdSeconds:0,  noUsernames:false, maxMsgLen:1000, promptEnabled:true  },
};

const PROMPTS = [
  "Hot take: what's something everyone agrees on that you think is wrong?",
  "What's something you've never told anyone?",
  "What's the most underrated thing in the world right now?",
  "Unpopular opinion — go.",
  "What would you do if you knew nobody would ever find out?",
  "Describe your current mood in exactly 3 words.",
  "What's something you're secretly proud of?",
  "What's a hill you'll die on?",
];

// ── ROUTES ──
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'landing.html')));
app.get('/app', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/chat', (req, res) => res.sendFile(path.join(__dirname, 'public', 'chat.html')));
app.get('/room/:code', (req, res) => res.sendFile(path.join(__dirname, 'public', 'chat.html')));
app.get('/chat.html', (req, res) => res.redirect('/chat'));
app.use(express.static(path.join(__dirname, 'public')));

// ── HELPERS ──
function getDeviceHash(socket) {
  const ip = socket.handshake.address;
  const ua = socket.handshake.headers['user-agent'] || '';
  return crypto.createHash('sha256').update(ip + ua + 'anonchat-v3-salt').digest('hex').substring(0, 16);
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

function broadcastUserList(roomCode) {
  if (!rooms[roomCode]) return;
  io.to(roomCode).emit('user-list', rooms[roomCode].users.map(u => ({
    username: u,
    badge: rooms[roomCode].badges[u] || '👤',
    isCreator: u === rooms[roomCode].creator,
    isMuted: rooms[roomCode].mutedUsers.has(u),
    msgCount: rooms[roomCode].messageCounts[u] || 0,
  })));
}

// ── SOCKET ──
io.on('connection', (socket) => {
  const ip = socket.handshake.address;
  const deviceHash = getDeviceHash(socket);
  socket.deviceHash = deviceHash;

  const rep = getReputation(deviceHash);
  if (isTempBlocked(rep.score)) {
    socket.emit('temp-blocked', 'Temporarily blocked due to suspicious activity.');
    socket.disconnect();
    return;
  }

  // ── ROOM SETUP ──
  socket.on('generate-code', () => {
    socket.emit('code-generated', uuidv4().substring(0, 6).toUpperCase());
  });

  socket.on('check-room', ({ roomCode }) => {
    if (checkBruteForce(ip)) { addRepScore(deviceHash, 3); socket.emit('join-error', 'Too many attempts. Please wait a minute.'); return; }
    if (!rooms[roomCode]) { socket.emit('join-error', 'Room not found. Check your code.'); return; }
    if (rooms[roomCode].users.length >= MAX_USERS) { socket.emit('join-error', `Room is full.`); return; }
    if (rooms[roomCode].locked) { socket.emit('join-error', 'Room is locked by the admin.'); return; }
    if (codeAttempts[ip]) codeAttempts[ip].count = 0;
    socket.emit('room-valid', { roomType: rooms[roomCode].roomType, config: rooms[roomCode].config });
  });

  socket.on('register-in-room', ({ roomCode, username, isCreator, roomType }) => {
    if (isCreator) {
      const type = ROOM_TYPES[roomType] || ROOM_TYPES.normal;
      rooms[roomCode] = {
        users: [], expiryTimer: null, createdAt: Date.now(),
        messageHistory: [], roomType: roomType || 'normal',
        config: type, creator: username, mutedUsers: new Set(),
        locked: false, badges: {}, messageCounts: {},
        publicKeys: {},      // E2E: username → base64 public key
        currentPrompt: type.promptEnabled ? PROMPTS[Math.floor(Math.random() * PROMPTS.length)] : null,
      };
      resetExpiry(roomCode);
    }

    if (!rooms[roomCode]) { socket.emit('join-error', 'Room not found or expired.'); return; }
    if (rooms[roomCode].locked && username !== rooms[roomCode].creator) { socket.emit('join-error', 'Room is locked.'); return; }
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
      history: rooms[roomCode].messageHistory,
      roomType: rooms[roomCode].roomType,
      config: rooms[roomCode].config,
      isAdmin: username === rooms[roomCode].creator,
      prompt: rooms[roomCode].currentPrompt,
      creator: rooms[roomCode].creator,
      // Send existing public keys to this new joiner
      existingPublicKeys: rooms[roomCode].publicKeys,
    });
    resetExpiry(roomCode);
  });

  // ── E2E KEY EXCHANGE ──
  // User registers their public key with the server (server just relays, never uses)
  socket.on('register-public-key', ({ roomCode, username, publicKey }) => {
    if (!rooms[roomCode]) return;
    rooms[roomCode].publicKeys[username] = publicKey;
    // Tell everyone else about this new public key
    socket.to(roomCode).emit('peer-public-key', { username, publicKey });
    // Tell this user about all existing keys
    socket.emit('existing-public-keys', rooms[roomCode].publicKeys);
  });

  // Creator distributes encrypted room key to a specific user
  socket.on('send-encrypted-room-key', ({ roomCode, targetUsername, encryptedKey }) => {
    if (!rooms[roomCode]) return;
    const targetSocket = [...io.sockets.sockets.values()]
      .find(s => s.username === targetUsername && s.roomCode === roomCode);
    if (targetSocket) {
      targetSocket.emit('receive-encrypted-room-key', {
        encryptedKey,
        senderPublicKey: rooms[roomCode].publicKeys[socket.username],
      });
    }
  });

  // New user requests room key from creator
  socket.on('request-room-key', ({ roomCode, username }) => {
    if (!rooms[roomCode]) return;
    const creator = rooms[roomCode].creator;
    const creatorSocket = [...io.sockets.sockets.values()]
      .find(s => s.username === creator && s.roomCode === roomCode);
    if (creatorSocket) {
      creatorSocket.emit('room-key-requested', {
        requesterUsername: username,
        requesterPublicKey: rooms[roomCode].publicKeys[username],
      });
    }
  });

  // ── MESSAGING ──
  socket.on('send-message', ({ roomCode, username, message, msgId, replyTo, checksum, sdSeconds }) => {
    if (!rooms[roomCode]) return;
    const room = rooms[roomCode];
    if (room.mutedUsers.has(username)) { socket.emit('you-are-muted'); return; }

    const rep = getReputation(deviceHash);
    const now = Date.now();

    if (isShadowMuted(rep.score)) {
      socket.emit('receive-message', { username, message, time: now, msgId, replyTo: replyTo || null, checksum, sdSeconds: sdSeconds || 0 });
      return;
    }

    const cooldown = getCooldown(rep.score);
    if (now - socket.lastMessageTime < cooldown) {
      addRepScore(deviceHash, 2);
      socket.emit('rate-limited', `Slow down! Wait ${Math.ceil((cooldown - (now - socket.lastMessageTime)) / 1000)}s.`);
      return;
    }

    if (!socket.rateLimitReset || now > socket.rateLimitReset) { socket.messageCount = 0; socket.rateLimitReset = now + 5000; }
    socket.messageCount++;
    if (socket.messageCount > 10) { addRepScore(deviceHash, 5); socket.emit('rate-limited', 'Too many messages. Please wait.'); return; }

    socket.lastMessageTime = now;
    resetExpiry(roomCode);

    room.messageCounts[username] = (room.messageCounts[username] || 0) + 1;
    if (room.messageCounts[username] === 10 && room.badges[username] === '👤') { room.badges[username] = '🔥'; broadcastUserList(roomCode); }
    else if (room.messageCounts[username] === 50 && room.badges[username] === '🔥') { room.badges[username] = '⚡'; broadcastUserList(roomCode); }

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
    if (ts?.deviceHash) { addRepScore(ts.deviceHash, 15); reputationStore[ts.deviceHash].reports = (reputationStore[ts.deviceHash].reports || 0) + 1; }
    socket.emit('report-received');
  });

  // ── DISCONNECT ──
  socket.on('disconnect', () => {
    const { roomCode, username } = socket;
    if (roomCode && username && rooms[roomCode]) {
      rooms[roomCode].users = rooms[roomCode].users.filter(u => u !== username);
      delete rooms[roomCode].publicKeys[username];
      io.to(roomCode).emit('user-left', { username, time: Date.now() });
      io.to(roomCode).emit('user-count', rooms[roomCode].users.length);
      broadcastUserList(roomCode);
      if (rooms[roomCode].users.length === 0) { clearTimeout(rooms[roomCode].expiryTimer); delete rooms[roomCode]; }
    }
  });
});



const PORT = process.env.PORT || 8080;
server.listen(PORT, '0.0.0.0', () => console.log(`AnonChat running on port ${PORT}`));