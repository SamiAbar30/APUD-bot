const express = require("express");
const http = require("http");
const crypto = require("crypto");
const { Server } = require("socket.io");
const cors = require("cors");
const axios = require("axios");
const bodyParser = require("body-parser");
const { parseWhatsAppPayload } = require("./utils/payloadParser");
const { constructWebhookPayload } = require("./utils/webhookConstructor");


const PORT = Number(process.env.WCE_BRIDGE_PORT || 3001);

// TODO: Change this to your bot's webhook URL
const BOT_WEBHOOK_URL = process.env.BOT_WEBHOOK_URL || "http://localhost:8000/chatbot/webhook";
const PHONE_NUMBER_ID = process.env.WCE_PHONE_NUMBER_ID || "PHONE_NUMBER_ID";
const SENDER_PHONE = process.env.WCE_SENDER_PHONE || "1234567890";
const BUSINESS_ACCOUNT_ID = process.env.WCE_BUSINESS_ACCOUNT_ID || "WCE_BUSINESS_ACCOUNT_ID";
const APP_SECRET = process.env.WCE_APP_SECRET || "";

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});
// The upstream demo UI does not retain bridge messages that arrive before a
// browser connects. Keep a small in-memory backlog so starting APOD first is
// still visible when the operator opens the emulator a moment later.
const pendingUiMessages = [];
const recentUiMessages = [];
function emitUiMessage(message) {
  recentUiMessages.push(message);
  if (recentUiMessages.length > 20) recentUiMessages.shift();
  if (io.sockets.sockets.size === 0) {
    pendingUiMessages.push(message);
    if (pendingUiMessages.length > 100) pendingUiMessages.shift();
    return;
  }
  io.emit("ui_message", message);
}

app.use(cors());
app.use(bodyParser.json());

// Receive full WhatsApp payload from bot, translate, and send to UI
app.post("/send-to-emulator", (req, res) => {
  try {
    const fullPayload = req.body;
    console.log(
      "📥 Received WhatsApp payload from bot:",
      JSON.stringify({ type: fullPayload.type })
    );

    const simpleMessage = parseWhatsAppPayload(fullPayload);
    console.log(
      "✨ Translated to Simple UI Contract:",
      JSON.stringify({ type: simpleMessage.type })
    );

    emitUiMessage(simpleMessage);
    console.log("📤 Sent to UI clients");

    // Match the WhatsApp Cloud API response shape so the bot can persist a
    // durable message id and reconcile delivery without any Meta call.
    const messageId = `wce-wamid-${Date.now()}-${crypto.randomBytes(6).toString("hex")}`;
    res.status(200).json({ messaging_product: "whatsapp", contacts: [{ input: fullPayload.to || "", wa_id: fullPayload.to || "" }], messages: [{ id: messageId }] });
  } catch (error) {
    console.error("❌ Error processing payload:", error);
    res.status(500).json({ status: "error", message: error.message });
  }
});

// Socket.io: Listen for replies from UI, translate, and POST to bot
io.on("connection", (socket) => {
  console.log("✅ UI client connected:", socket.id);
  const replay = pendingUiMessages.splice(0);
  if (replay.length === 0) replay.push(...recentUiMessages.slice(-10));
  for (const message of replay) socket.emit("ui_message", message);

  socket.on("ui_reply", async (simpleReply) => {
    try {
      console.log(
        "📥 Received reply from UI:",
        JSON.stringify({ type: simpleReply.type, contentLogged: false })
      );

      const fullWebhookPayload = constructWebhookPayload(simpleReply, {
        phoneNumberId: PHONE_NUMBER_ID,
        senderPhone: SENDER_PHONE,
        businessAccountId: BUSINESS_ACCOUNT_ID,
      });
      console.log(
        "✨ Constructed webhook payload:",
        JSON.stringify({ signed: Boolean(APP_SECRET), contentLogged: false })
      );

      const raw = JSON.stringify(fullWebhookPayload);
      const headers = { "Content-Type": "application/json" };
      if (APP_SECRET) {
        headers["x-hub-signature-256"] = `sha256=${crypto.createHmac("sha256", APP_SECRET).update(raw).digest("hex")}`;
      }
      const response = await axios.post(BOT_WEBHOOK_URL, raw, { headers });
      console.log("📤 Sent to bot webhook. Response:", response.status);
    } catch (error) {
      console.error("❌ Error sending to bot:", error.message);
    }
  });

  socket.on("disconnect", () => {
    console.log("❌ UI client disconnected:", socket.id);
  });
});

server.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════════════════════════════
║   🌉 WCE Local Bridge 🌉
║
║   Port: ${PORT}
║   Bridge sends to:  [POST] http://localhost:${PORT}/send-to-emulator
║   <YOUR CHATBOT WEBHOOK> ${BOT_WEBHOOK_URL}
╚═══════════════════════════════════════════════════════════════════════
  `);
});
