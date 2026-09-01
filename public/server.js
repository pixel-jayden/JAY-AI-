import express from "express";
import dotenv from "dotenv";
import { randomUUID } from "crypto";
import fs from "fs/promises";
import path from "path";
import { GoogleGenAI } from "@google/genai";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

const ai = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY
});

// -----------------------------------------------------------------
// JAY's personality. Edit this to change how JAY talks about itself.
// -----------------------------------------------------------------
const SYSTEM_INSTRUCTION = `You are JAY AI, a helpful, friendly assistant built by Jayden.
You are NOT Gemini or a Google product in the eyes of the user — if asked who you are,
say you are JAY AI. Keep answers clear and well-formatted using Markdown
(headings, bullet lists, and fenced code blocks with a language tag) when it helps
readability. Be concise by default, but go deeper when the user asks for detail.`;

// -----------------------------------------------------------------
// Very small JSON-file "database". Fine for a personal project;
// swap for a real DB later if this needs to support many users.
// -----------------------------------------------------------------
const DATA_DIR = path.join(process.cwd(), "data");
const DATA_FILE = path.join(DATA_DIR, "chats.json");

async function loadChats() {
    try {
        const raw = await fs.readFile(DATA_FILE, "utf-8");
        return JSON.parse(raw);
    } catch (err) {
        if (err.code === "ENOENT") return { chats: {} };
        throw err;
    }
}

async function saveChats(db) {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(DATA_FILE, JSON.stringify(db, null, 2), "utf-8");
}

function summarize(chat) {
    return {
        id: chat.id,
        title: chat.title,
        updatedAt: chat.updatedAt
    };
}

app.use(express.json());
// IMPORTANT: only the public/ folder is ever served. server.js, package.json,
// .env, and data/chats.json live outside it and are never reachable over HTTP.
app.use(express.static("public"));

// ---------------------- Chat list / CRUD ----------------------

app.get("/api/chats", async (req, res) => {
    const db = await loadChats();
    const list = Object.values(db.chats)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map(summarize);
    res.json(list);
});

app.get("/api/chats/:id", async (req, res) => {
    const db = await loadChats();
    const chat = db.chats[req.params.id];
    if (!chat) return res.status(404).json({ error: "Chat not found" });
    res.json(chat);
});

app.post("/api/chats", async (req, res) => {
    const db = await loadChats();
    const id = randomUUID();
    const now = Date.now();

    db.chats[id] = {
        id,
        title: "New chat",
        createdAt: now,
        updatedAt: now,
        messages: []
    };

    await saveChats(db);
    res.json(db.chats[id]);
});

app.delete("/api/chats/:id", async (req, res) => {
    const db = await loadChats();
    delete db.chats[req.params.id];
    await saveChats(db);
    res.json({ ok: true });
});

// ---------------------- Streaming reply ----------------------

app.post("/api/chats/:id/stream", async (req, res) => {
    const { message } = req.body;

    if (!message || !message.trim()) {
        return res.status(400).json({ error: "No message provided" });
    }

    const db = await loadChats();
    const chat = db.chats[req.params.id];

    if (!chat) {
        return res.status(404).json({ error: "Chat not found" });
    }

    // Persist the user's message immediately, before we even call Gemini,
    // so a crash mid-reply never loses what the user typed.
    chat.messages.push({ role: "user", content: message });
    if (chat.messages.length === 1) {
        chat.title = message.slice(0, 40) + (message.length > 40 ? "…" : "");
    }
    chat.updatedAt = Date.now();
    await saveChats(db);

    res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive"
    });

    const send = (event, data) => {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    let full = "";
    let clientGone = false;
    req.on("close", () => {
        clientGone = true;
    });

    try {
        const contents = chat.messages.map(item => ({
            role: item.role === "assistant" ? "model" : "user",
            parts: [{ text: item.content }]
        }));

        const stream = await ai.models.generateContentStream({
            model: "gemini-3.6-flash",
            contents,
            config: {
                systemInstruction: SYSTEM_INSTRUCTION
            }
        });

        for await (const chunk of stream) {
            if (clientGone) break; // user hit "stop" — quit forwarding tokens
            const piece = chunk.text;
            if (piece) {
                full += piece;
                send("chunk", { text: piece });
            }
        }

        if (!clientGone) {
            send("done", { fullText: full });
            res.end();
        }
    } catch (error) {
        console.error("Gemini stream error:", error);
        if (!clientGone) {
            send("error", { error: "Gemini request failed" });
            res.end();
        }
    } finally {
        // Save whatever we actually generated, even if the client
        // disconnected early (stop button) or an error cut things short.
        if (full) {
            const fresh = await loadChats();
            const freshChat = fresh.chats[req.params.id];
            if (freshChat) {
                freshChat.messages.push({ role: "assistant", content: full });
                freshChat.updatedAt = Date.now();
                await saveChats(fresh);
            }
        }
    }
});

app.listen(PORT, "0.0.0.0", () => {
    console.log(`JAY AI running on port ${PORT}`);
    console.log("Gemini API key loaded:", !!process.env.GEMINI_API_KEY);
});
