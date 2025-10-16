const express = require("express");
const app = express();
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");
const pako = require("pako");

const { GoogleGenerativeAI } = require("@google/generative-ai");

const server = http.createServer(app);

app.use(
  cors({
    origin: [
      "http://localhost:3000",
      "http://localhost:3001", 
      "https://gyaan-setu-whiteboard.vercel.app/",
    
    ],
  })
);
app.use(express.json());

let users = new Map();
let socketMap = new Map();

// Change from global elements array to room-specific storage
let rooms = {};

const compress = (data) => {
  const json = JSON.stringify(data);
  return pako.deflate(json);
};

// Helper function to check if file is media
const isMediaFile = (fileType) => {
  const mediaTypes = ["image/", "video/", "audio/", "application/pdf"];
  return mediaTypes.some((type) => fileType.toLowerCase().startsWith(type));
};

// Helper function to check if file is URL/text based
const isUrlOrTextFile = (fileType, fileName) => {
  const textTypes = [
    "text/",
    "application/json",
    "application/xml",
    "application/javascript",
  ];

  const textExtensions = [
    ".txt",
    ".json",
    ".xml",
    ".js",
    ".css",
    ".html",
    ".url",
  ];

  return (
    textTypes.some((type) => fileType.toLowerCase().startsWith(type)) ||
    textExtensions.some((ext) => fileName.toLowerCase().endsWith(ext))
  );
};

const io = new Server(server, {
  cors: {
    origin: [
      "http://localhost:3000",
      "http://localhost:3001"],
    methods: ["GET", "POST"],
  },
});

io.on("connection", (socket) => {
  socket.on("join-room", ({ roomID, UserID }) => {
    socket.join(roomID);
    socket.userID = UserID;
    socket.roomID = roomID; // Store roomID in socket for cleanup

    // Initialize room if it doesn't exist
    if (!rooms[roomID]) {
      rooms[roomID] = {
        elements: [],
        users: [],
      };
    }

    // Add user to room
    rooms[roomID].users.push({ userID: UserID, socketId: socket.id });

    // Send current whiteboard state to the joining user
    const roomElements = rooms[roomID].elements || [];
    socket.emit("whiteboard-state", { elements: roomElements });

    console.log(
      `User ${UserID} joined room ${roomID}. Room now has ${rooms[roomID].elements.length} elements.`
    );
  });

  socket.on("element-update", ({ elementData, roomID }) => {
    console.log("Server received element:", elementData.type, elementData.id);
    if (elementData.type === "image") {
      console.log(
        "Image details:",
        elementData.src,
        elementData.width,
        elementData.height
      );
    }

    updateElementInRoom(elementData, roomID);
    socket.broadcast.to(roomID).emit("element-update", elementData);
  });

  // Add the correct element removal handler
  socket.on("element-removal", ({ elementId, roomID }) => {
    console.log(`Removing element ${elementId} from room ${roomID}`);

    if (!rooms[roomID]) {
      rooms[roomID] = { elements: [], users: [] };
    }

    // Remove from server storage
    const initialLength = rooms[roomID].elements.length;
    rooms[roomID].elements = rooms[roomID].elements.filter(
      (element) => element.id !== elementId
    );
    const finalLength = rooms[roomID].elements.length;

    console.log(
      `Element removal: ${initialLength} -> ${finalLength} elements in room ${roomID}`
    );

    // Broadcast to ALL clients in room (including sender)
    io.to(roomID).emit("element-removal", { elementId });
  });

  socket.on("student-sleeping", ({ userID, roomID }) => {
    socket.broadcast.to(roomID).emit("student-sleeping", userID);
  });

  socket.on("message", ({ roomID, compressedMessage }) => {
    console.log(compressedMessage);
    socket.broadcast.to(roomID).emit("message", compressedMessage);
  });

  socket.on("website-closed", ({ roomID, userID }) => {
    console.log(`User ${userID} closed website sharing in room: ${roomID}`);
    io.to(roomID).emit("website-closed", { userID, roomID });
  });

  socket.on("share-website", ({ websiteUrl, roomID, userID }) => {
    console.log(
      `User ${userID} is sharing website: ${websiteUrl} in room: ${roomID}`
    );

    try {
      new URL(websiteUrl);
      socket.to(roomID).emit("website-shared", { websiteUrl, userID });
      // socket.emit("website-shared", { websiteUrl, userID });
    } catch (error) {
      console.error("Invalid URL format on server:", error);
      socket.emit("website-share-error", { error: "Invalid URL format" });
    }
  });

  socket.on("whiteboard-clear", (roomID) => {
    // Clear elements for the specific room
    if (rooms[roomID]) {
      rooms[roomID].elements = [];
      console.log(`Cleared all elements from room ${roomID}`);
    }

    socket.broadcast.to(roomID).emit("whiteboard-clear");
  });

  socket.on("cursor-position", ({ cursorData, roomID }) => {
    socket.broadcast.to(roomID).emit("cursor-position", {
      ...cursorData,
      userId: socket.id,
    });
  });

  socket.on("quiz", ({ correctAnswer, roomID }) => {
    console.log(correctAnswer);
    socket.broadcast.to(roomID).emit("quiz", { correctAnswer });
  });

  socket.on("file", ({ roomID, fileName, fileType, fileData }) => {
    console.log(
      `File transfer - Name: ${fileName}, Type: ${fileType}, Room: ${roomID}`
    );

    if (isMediaFile(fileType)) {
      console.log("Media file detected - applying compression");
      const compressedFile = compress({ fileName, fileType, fileData });
      // Use broadcast to send to ALL clients in room
      socket.broadcast.to(roomID).emit("file-media", compressedFile);
    } else if (isUrlOrTextFile(fileType, fileName)) {
      console.log("URL/Text file detected - sending without compression");
      socket.broadcast
        .to(roomID)
        .emit("file-url", { fileName, fileType, fileData });
    } else {
      console.log("Other file type detected - applying compression as default");
      const compressedFile = compress({ fileName, fileType, fileData });
      socket.broadcast.to(roomID).emit("file-other", compressedFile);
    }

    // Also send via the generic file-received event as fallback
    socket.broadcast
      .to(roomID)
      .emit("file-rechieved", { fileName, fileType, fileData });

    console.log(
      `Broadcasting file to ${
        rooms[roomID]?.users?.length || 0
      } users in room ${roomID}`
    );
  });

  // Remove the old element-delete handler (it's replaced by element-removal)
  socket.on("elements-update", ({ elements: updatedElements, roomID }) => {
    if (!rooms[roomID]) {
      rooms[roomID] = { elements: [], users: [] };
    }

    rooms[roomID].elements = updatedElements;
    const compressed = compress(updatedElements);
    socket.broadcast.to(roomID).emit("elements-updated", compressed);
  });

  socket.on("get-definition", async ({ question, userID }) => {
    console.log(question);
    const genAI = new GoogleGenerativeAI(
      "AIzaSyBIM9JTcbsaivYrZMk5BOh1s_WY895kXuo"
    );
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-pro" });

    const prompt = `Explain in simple words ${question}`;

    const result = await model.generateContent(prompt);
    const answer = result.response.text();
    console.log(result.response.text());
    console.log(userID);

    const words = answer.split(" ");
    let formattedAnswer = "";

    for (let i = 0; i < words.length; i++) {
      if (i > 0 && i % 10 === 0) {
        formattedAnswer += "\n";
      }
      formattedAnswer += words[i] + " ";
    }

    formattedAnswer = formattedAnswer.trim();

    socket.emit("got-definition", formattedAnswer);
  });

  socket.on("audioStream", ({ audioData, roomID }) => {
    socket.broadcast.to(roomID).emit("audioStream", { audioData });
  });

  socket.on("disconnect", () => {
    if (socket.roomID && socket.userID) {
      console.log(
        `User ${socket.userID} disconnected from room ${socket.roomID}`
      );

      // Remove user from room
      if (rooms[socket.roomID]) {
        rooms[socket.roomID].users = rooms[socket.roomID].users.filter(
          (user) => user.socketId !== socket.id
        );

        // Clean up empty rooms (optional)
        if (rooms[socket.roomID].users.length === 0) {
          console.log(`Room ${socket.roomID} is empty, cleaning up...`);
          // Optionally delete the room after some time
          // delete rooms[socket.roomID];
        }
      }

      socket.broadcast
        .to(socket.roomID)
        .emit("user-disconnected", { userID: socket.userID });
    }
  });
});

app.get("/", (req, res) => {
  res.send("Hello server is working");
});

app.post("/", (req, res) => {
  const { role, roomID, userID } = req.body;
  console.log("role" + role);
  users.set(userID, { role: role, socketID: null });
});

const PORT = process.env.PORT || 3003;

server.listen(PORT, () => {
  console.log("server is running on port", PORT);
});

const updateElementInRoom = (elementData, roomID) => {
  if (!rooms[roomID]) {
    rooms[roomID] = { elements: [], users: [] };
  }

  const index = rooms[roomID].elements.findIndex(
    (element) => element.id === elementData.id
  );

  if (index === -1) {
    // Add new element with all properties preserved
    const completeElement = {
      ...elementData,
      // Ensure image elements keep their src and dimensions
      ...(elementData.type === "image" && {
        src: elementData.src,
        width: elementData.width || 200,
        height: elementData.height || 200,
      }),
    };
    rooms[roomID].elements.push(completeElement);
    console.log(`Added new ${elementData.type} element to room ${roomID}`);
  } else {
    // Update existing element
    rooms[roomID].elements[index] = {
      ...rooms[roomID].elements[index],
      ...elementData,
    };
    console.log(`Updated ${elementData.type} element in room ${roomID}`);
  }
};

// Add a debug endpoint to check room states (optional)
app.get("/debug/rooms", (req, res) => {
  const roomStats = {};
  Object.keys(rooms).forEach((roomID) => {
    roomStats[roomID] = {
      elementCount: rooms[roomID].elements.length,
      userCount: rooms[roomID].users.length,
      users: rooms[roomID].users.map((u) => u.userID),
    };
  });
  res.json(roomStats);
});
