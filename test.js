const express = require("express");
const app = express();
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");

const server = http.createServer(app);

app.use(cors());
app.use(express.json());

// Custom ID generation function
const generateCustomId = () => {
  return Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
};

// Enhanced user and room management
const rooms = new Map(); // roomID -> {users: Map, elements: [], teacherSocketId: null}
const userSockets = new Map(); // userID -> socketID

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

io.on("connection", (socket) => {
  socket.on("join-room", (userData) => {
    const { roomID, userID, role } = userData;
    
    // Create room if not exists
    if (!rooms.has(roomID)) {
      rooms.set(roomID, {
        users: new Map(),
        elements: [],
        teacherSocketId: null
      });
    }

    const room = rooms.get(roomID);
    
    // Store user in room
    room.users.set(userID, { 
      role, 
      socketId: socket.id 
    });

    // Track user's socket
    userSockets.set(userID, socket.id);

    // If teacher joins, set teacher socket
    if (role === 'teacher') {
      room.teacherSocketId = socket.id;
    }

    // Join socket room
    socket.join(roomID);

    // Send initial room state
    socket.emit("room-joined", {
      roomID,
      userID,
      role,
      elements: room.elements,
      isTeacher: role === 'teacher'
    });

    // Broadcast user joined
    io.to(roomID).emit("user-joined", { userID, role });
  });

  socket.on("element-update", (data) => {
    const { roomID, elementData } = data;
    const room = rooms.get(roomID);
    
    // Find user's role
    const user = Array.from(room.users.values())
      .find(u => u.socketId === socket.id);

    // Only allow updates if user is a teacher or if student edits are allowed
    if (user.role === 'teacher' || elementData.allowStudentEdit) {
      // Update elements in room
      const index = room.elements.findIndex(el => el.id === elementData.id);
      if (index === -1) {
        room.elements.push(elementData);
      } else {
        room.elements[index] = elementData;
      }

      // Broadcast to all users in room except sender
      socket.to(roomID).emit("element-update", elementData);
    }
  });

  socket.on("whiteboard-clear", (roomID) => {
    const room = rooms.get(roomID);
    const user = Array.from(room.users.values())
      .find(u => u.socketId === socket.id);

    // Only teacher can clear
    if (user.role === 'teacher') {
      room.elements = [];
      io.to(roomID).emit("whiteboard-clear");
    }
  });

  socket.on("disconnect", () => {
    // Find and remove user from rooms
    for (const [roomID, room] of rooms.entries()) {
      for (const [userID, userData] of room.users.entries()) {
        if (userData.socketId === socket.id) {
          room.users.delete(userID);
          userSockets.delete(userID);

          // Reset teacher socket if teacher disconnects
          if (userData.role === 'teacher') {
            room.teacherSocketId = null;
          }

          // Broadcast user left
          io.to(roomID).emit("user-left", { userID, role: userData.role });
          break;
        }
      }
    }
  });
});

// Endpoint to generate room ID
app.get("/generate-room", (req, res) => {
  const roomID = generateCustomId();
  res.json({ roomID });
});

// Endpoint to validate room
app.post("/validate-room", (req, res) => {
  const { roomID, userID, role } = req.body;
  
  // Additional validation logic can be added here
  res.json({ 
    valid: true, 
    roomID, 
    userID: userID || generateCustomId(), 
    role 
  });
});

const PORT = process.env.PORT || 3003;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});