const { Server } = require('socket.io');

let io = null;

// Initialize Socket.IO
exports.initializeSocket = (server) => {
  io = new Server(server, {
    cors: {
      origin: (origin, callback) => {
        if (!origin) return callback(null, true);
        const allowed = [
          'http://localhost:3000',
          'https://app.waabizx.com',
          'https://www.waabizx.com',
          'https://waabizx.com',
          'https://wabizx.techwhizzc.com',
          'https://techwhizzc.com',
          'https://www.techwhizzc.com',
          process.env.FRONTEND_URL,
        ].filter(Boolean);
        const normalized = String(origin).replace(/\/$/, '');
        if (allowed.some((o) => String(o).replace(/\/$/, '') === normalized)) {
          return callback(null, true);
        }
        if (/\.waabizx\.com$/i.test(normalized) || /\.techwhizzc\.com$/i.test(normalized)) {
          return callback(null, true);
        }
        return callback(null, false);
      },
      methods: ['GET', 'POST'],
      credentials: true,
    },
  });

  io.on('connection', (socket) => {
    console.log('Client connected:', socket.id);

    // Join user room (legacy inbox UI)
    socket.on('join-user', (userId) => {
      socket.join(`user-${userId}`);
      console.log(`User ${userId} joined their room (user-${userId})`);
    });

    // Join contact room for real-time chat (legacy contact-based rooms)
    socket.on('join-contact', (contactId) => {
      socket.join(`contact-${contactId}`);
      console.log(`Socket ${socket.id} joined contact room: contact-${contactId}`);
    });

    // Generic room join – used for AiSensy-style agent/manager rooms
    // Examples:
    //   socket.emit("join", `agent_${agentId}`);
    //   socket.emit("join", "manager");
    socket.on('join', (room) => {
      if (!room) return;
      socket.join(room);
      console.log(`Socket ${socket.id} joined room: ${room}`);
    });

    // Leave contact room
    socket.on('leave-contact', (contactId) => {
      socket.leave(`contact-${contactId}`);
      console.log(`Socket ${socket.id} left contact room: ${contactId}`);
    });

    // Typing indicator
    socket.on('typing-start', (data) => {
      socket.to(`contact-${data.contactId}`).emit('typing', {
        contactId: data.contactId,
        isTyping: true,
        userId: data.userId
      });
    });

    socket.on('typing-stop', (data) => {
      socket.to(`contact-${data.contactId}`).emit('typing', {
        contactId: data.contactId,
        isTyping: false,
        userId: data.userId
      });
    });

    // Online status
    socket.on('user-online', (userId) => {
      socket.broadcast.emit('user-status', {
        userId,
        isOnline: true
      });
    });

    socket.on('disconnect', () => {
      console.log('Client disconnected:', socket.id);
    });
  });

  return io;
};

// Emit message to specific user
exports.emitToUser = (userId, event, data) => {
  if (io) {
    io.to(`user-${userId}`).emit(event, data);
  }
};

// Emit message to contact room
exports.emitToContact = (contactId, event, data) => {
  if (io) {
    io.to(`contact-${contactId}`).emit(event, data);
  }
};

// Emit to all connected clients
exports.emitToAll = (event, data) => {
  if (io) {
    io.emit(event, data);
  }
};

// Emit to specific agent room (AiSensy Live Chat)
exports.emitToAgent = (agentId, event, data) => {
  if (io && agentId != null) {
    io.to(`agent_${agentId}`).emit(event, data);
  }
};

// Emit to manager room (requesting queue)
exports.emitToManager = (event, data) => {
  if (io) {
    io.to("manager").emit(event, data);
  }
};

// Get Socket.IO instance
exports.getIO = () => {
  return io;
};
