import express from "express";
import dotenv from "dotenv";
import { randomUUID } from "crypto";
import fs from "fs/promises";
import path from "path";
import { GoogleGenAI } from "@google/genai";
import pg from "pg";
import mammoth from "mammoth";

dotenv.config();

const { Pool } = pg;
const app = express();
const PORT = process.env.PORT || 3000;
const MAX_MESSAGE_LENGTH = 12000;
const USE_POSTGRES = Boolean(process.env.DATABASE_URL);

const ai = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY
});

const SYSTEM_INSTRUCTION = `You are JAY AI, a helpful, friendly assistant built by Jayden.
You are NOT Gemini or a Google product in the eyes of the user — if asked who you are,
say you are JAY AI. Keep answers clear and well-formatted using Markdown
(headings, bullet lists, and fenced code blocks with a language tag) when it helps
readability. Be concise by default, but go deeper when the user asks for detail.
Use web search when the user asks for current or recent information, news, prices,
schedules, live results, or facts where up-to-date information would improve the answer.
When web search is used, rely on the retrieved sources and make the answer clear about
what information came from the web.`;

const DATA_DIR = path.join(process.cwd(), "data");
const DATA_FILE = path.join(DATA_DIR, "chats.json");
const TEMP_FILE = path.join(DATA_DIR, "chats.tmp.json");

const pool = USE_POSTGRES
    ? new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: process.env.DATABASE_SSL === "false"
            ? false
            : { rejectUnauthorized: false }
    })
    : null;

async function initPostgres() {
    if (!pool) return;

    await pool.query(`
        CREATE TABLE IF NOT EXISTS chats (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            created_at BIGINT NOT NULL,
            updated_at BIGINT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS messages (
            id BIGSERIAL PRIMARY KEY,
            chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
            role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
            content TEXT NOT NULL,
            created_at BIGINT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS messages_chat_id_idx
            ON messages(chat_id, id);

        CREATE INDEX IF NOT EXISTS chats_updated_at_idx
            ON chats(updated_at DESC);
    `);
}

async function loadFileChats() {
    try {
        const raw = await fs.readFile(DATA_FILE, "utf-8");
        const db = JSON.parse(raw);

        if (!db || typeof db !== "object" || !db.chats || typeof db.chats !== "object") {
            throw new Error("Chat database has an invalid structure.");
        }

        return db;
    } catch (err) {
        if (err.code === "ENOENT") return { chats: {} };

        if (err instanceof SyntaxError) {
            throw new Error("Chat database contains invalid JSON.");
        }

        throw err;
    }
}

let saveQueue = Promise.resolve();

function saveFileChats(db) {
    const snapshot = JSON.stringify(db, null, 2);

    saveQueue = saveQueue.then(async () => {
        await fs.mkdir(DATA_DIR, { recursive: true });
        await fs.writeFile(TEMP_FILE, snapshot, "utf-8");
        await fs.rename(TEMP_FILE, DATA_FILE);
    });

    return saveQueue;
}

function chatFromRow(row, messages = []) {
    return {
        id: row.id,
        title: row.title,
        createdAt: Number(row.created_at),
        updatedAt: Number(row.updated_at),
        messages
    };
}

async function listChats() {
    if (!pool) {
        const db = await loadFileChats();
        return Object.values(db.chats)
            .sort((a, b) => b.updatedAt - a.updatedAt)
            .map(summarize);
    }

    const { rows } = await pool.query(
        "SELECT id, title, created_at, updated_at FROM chats ORDER BY updated_at DESC"
    );

    return rows.map(row => ({
        id: row.id,
        title: row.title,
        updatedAt: Number(row.updated_at)
    }));
}

async function getChat(id) {
    if (!pool) {
        const db = await loadFileChats();
        return db.chats[id] || null;
    }

    const chatResult = await pool.query(
        "SELECT id, title, created_at, updated_at FROM chats WHERE id = $1",
        [id]
    );

    if (!chatResult.rows[0]) return null;

    const messageResult = await pool.query(
        "SELECT role, content FROM messages WHERE chat_id = $1 ORDER BY id ASC",
        [id]
    );

    return chatFromRow(chatResult.rows[0], messageResult.rows);
}

async function createChat() {
    const id = randomUUID();
    const now = Date.now();

    if (!pool) {
        const db = await loadFileChats();
        db.chats[id] = {
            id,
            title: "New chat",
            createdAt: now,
            updatedAt: now,
            messages: []
        };
        await saveFileChats(db);
        return db.chats[id];
    }

    const { rows } = await pool.query(
        `INSERT INTO chats (id, title, created_at, updated_at)
         VALUES ($1, $2, $3, $3)
         RETURNING id, title, created_at, updated_at`,
        [id, "New chat", now]
    );

    return chatFromRow(rows[0], []);
}

async function renameChat(id, title) {
    if (!pool) {
        const db = await loadFileChats();
        const chat = db.chats[id];
        if (!chat) return null;

        chat.title = title;
        chat.updatedAt = Date.now();
        await saveFileChats(db);
        return summarize(chat);
    }

    const now = Date.now();
    const { rows } = await pool.query(
        `UPDATE chats
         SET title = $1, updated_at = $2
         WHERE id = $3
         RETURNING id, title, updated_at`,
        [title, now, id]
    );

    if (!rows[0]) return null;

    return {
        id: rows[0].id,
        title: rows[0].title,
        updatedAt: Number(rows[0].updated_at)
    };
}

async function deleteChat(id) {
    if (!pool) {
        const db = await loadFileChats();
        if (!db.chats[id]) return false;

        delete db.chats[id];
        await saveFileChats(db);
        return true;
    }

    const result = await pool.query("DELETE FROM chats WHERE id = $1", [id]);
    return result.rowCount > 0;
}

async function appendUserMessage(id, content) {
    const now = Date.now();

    if (!pool) {
        const db = await loadFileChats();
        const chat = db.chats[id];
        if (!chat) return null;

        chat.messages.push({ role: "user", content });

        if (chat.messages.length === 1) {
            chat.title = content.slice(0, 40) + (content.length > 40 ? "…" : "");
        }

        chat.updatedAt = now;
        await saveFileChats(db);
        return chat;
    }

    const client = await pool.connect();

    try {
        await client.query("BEGIN");

        const chatResult = await client.query(
            "SELECT id, title, created_at, updated_at FROM chats WHERE id = $1 FOR UPDATE",
            [id]
        );

        const chat = chatResult.rows[0];

        if (!chat) {
            await client.query("ROLLBACK");
            return null;
        }

        const countResult = await client.query(
            "SELECT COUNT(*)::int AS count FROM messages WHERE chat_id = $1",
            [id]
        );

        const isFirstMessage = countResult.rows[0].count === 0;
        const title = isFirstMessage
            ? content.slice(0, 40) + (content.length > 40 ? "…" : "")
            : chat.title;

        await client.query(
            `INSERT INTO messages (chat_id, role, content, created_at)
             VALUES ($1, 'user', $2, $3)`,
            [id, content, now]
        );

        await client.query(
            "UPDATE chats SET title = $1, updated_at = $2 WHERE id = $3",
            [title, now, id]
        );

        await client.query("COMMIT");

        return getChat(id);
    } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
    } finally {
        client.release();
    }
}

async function appendAssistantMessage(id, content) {
    const now = Date.now();

    if (!pool) {
        const db = await loadFileChats();
        const chat = db.chats[id];

        if (!chat) return;

        chat.messages.push({
            role: "assistant",
            content
        });

        chat.updatedAt = now;
        await saveFileChats(db);
        return;
    }

    await pool.query(
        `INSERT INTO messages (chat_id, role, content, created_at)
         VALUES ($1, 'assistant', $2, $3)`,
        [id, content, now]
    );

    await pool.query(
        "UPDATE chats SET updated_at = $1 WHERE id = $2",
        [now, id]
    );
}

function summarize(chat) {
    return {
        id: chat.id,
        title: chat.title,
        updatedAt: chat.updatedAt
    };
}

app.use(express.json({ limit: "20mb" }));
app.use(express.static("public"));

app.get("/api/health", async (req, res) => {
    try {
        if (pool) {
            await pool.query("SELECT 1");
        }

        res.json({
            ok: true,
            database: pool ? "postgres" : "file",
            geminiConfigured: Boolean(process.env.GEMINI_API_KEY)
        });
    } catch (error) {
        console.error("Health check failed:", error);
        res.status(503).json({
            ok: false,
            database: pool ? "postgres" : "file",
            geminiConfigured: Boolean(process.env.GEMINI_API_KEY)
        });
    }
});

app.get("/api/chats", async (req, res, next) => {
    try {
        res.json(await listChats());
    } catch (error) {
        next(error);
    }
});

app.get("/api/chats/:id", async (req, res, next) => {
    try {
        const chat = await getChat(req.params.id);

        if (!chat) {
            return res.status(404).json({ error: "Chat not found" });
        }

        res.json(chat);
    } catch (error) {
        next(error);
    }
});

app.post("/api/chats", async (req, res, next) => {
    try {
        res.status(201).json(await createChat());
    } catch (error) {
        next(error);
    }
});

app.patch("/api/chats/:id", async (req, res, next) => {
    try {
        const title = typeof req.body?.title === "string"
            ? req.body.title.trim().replace(/\s+/g, " ")
            : "";

        if (!title) {
            return res.status(400).json({ error: "A chat title is required" });
        }

        if (title.length > 80) {
            return res.status(400).json({
                error: "Chat title must be 80 characters or fewer"
            });
        }

        const chat = await renameChat(req.params.id, title);

        if (!chat) {
            return res.status(404).json({ error: "Chat not found" });
        }

        res.json(chat);
    } catch (error) {
        next(error);
    }
});

app.delete("/api/chats/:id", async (req, res, next) => {
    try {
        const deleted = await deleteChat(req.params.id);

        if (!deleted) {
            return res.status(404).json({ error: "Chat not found" });
        }

        res.json({ ok: true });
    } catch (error) {
        next(error);
    }
});

app.post("/api/chats/:id/analyze-file", async (req, res, next) => {
    try {
        const { name, mimeType, data, prompt } = req.body || {};

        if (typeof name !== "string" || typeof mimeType !== "string" || typeof data !== "string") {
            return res.status(400).json({ error: "A file name, type, and data are required." });
        }

        if (data.length > 16_000_000) {
            return res.status(413).json({ error: "That file is too large. Maximum upload size is about 12 MB." });
        }

        const chat = await getChat(req.params.id);
        if (!chat) return res.status(404).json({ error: "Chat not found" });

        const allowedTypes = new Set([
            "application/pdf",
            "text/plain",
            "text/markdown",
            "application/json",
            "text/csv",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "image/png",
            "image/jpeg",
            "image/webp"
        ]);

        if (!allowedTypes.has(mimeType)) {
            return res.status(415).json({
                error: "That file type is not supported yet. Try PDF, DOCX, TXT, MD, CSV, JSON, PNG, JPG, or WEBP."
            });
        }

        const cleanPrompt = typeof prompt === "string" && prompt.trim()
            ? prompt.trim()
            : "Analyze this file and explain the important information clearly.";

        const base64 = data.includes(",") ? data.split(",")[1] : data;
        const parts = [{ text: cleanPrompt }];

        if (
            mimeType.startsWith("text/") ||
            mimeType === "application/json"
        ) {
            const textContent = Buffer.from(base64, "base64").toString("utf8");

            if (textContent.length > 200_000) {
                return res.status(413).json({ error: "That text file is too large to analyze." });
            }

            parts.push({
                text: `FILE CONTENT (filename: ${name}):\n\n${textContent}`
            });
        } else if (mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
            let docxBuffer;

            try {
                docxBuffer = Buffer.from(base64, "base64");
                const result = await mammoth.extractRawText({ buffer: docxBuffer });
                const textContent = result.value.trim();

                if (!textContent) {
                    return res.status(422).json({
                        error: "I couldn't extract readable text from that DOCX file."
                    });
                }

                if (textContent.length > 200_000) {
                    return res.status(413).json({
                        error: "That DOCX file contains too much text to analyze at once."
                    });
                }

                parts.push({
                    text: `DOCUMENT CONTENT (filename: ${name}):\n\n${textContent}`
                });
            } catch (error) {
                console.error("DOCX extraction error:", error);
                return res.status(422).json({
                    error: "I couldn't read that DOCX document."
                });
            }
        } else {
            parts.push({ inlineData: { mimeType, data: base64 } });
        }

        const history = await getChat(req.params.id);
        const contents = history.messages.map(item => ({
            role: item.role === "assistant" ? "model" : "user",
            parts: [{ text: item.content }]
        }));
        contents.push({ role: "user", parts });

        const response = await ai.models.generateContent({
            model: "gemini-3.6-flash",
            contents,
            config: { systemInstruction: SYSTEM_INSTRUCTION }
        });

        const answer = response.text || "I couldn't extract anything useful from that file.";

        await appendUserMessage(req.params.id, `[Attached file: ${name}]\n\n${cleanPrompt}`);
        await appendAssistantMessage(req.params.id, answer);

        res.json({ answer });
    } catch (error) {
        console.error("File analysis error:", error);
        next(error);
    }
});

app.post("/api/chats/:id/stream", async (req, res, next) => {
    const message = typeof req.body?.message === "string"
        ? req.body.message.trim()
        : "";

    if (!message) {
        return res.status(400).json({ error: "No message provided" });
    }

    if (message.length > MAX_MESSAGE_LENGTH) {
        return res.status(413).json({
            error: `Message is too long. Maximum length is ${MAX_MESSAGE_LENGTH.toLocaleString()} characters.`
        });
    }

    try {
        const chat = await appendUserMessage(req.params.id, message);

        if (!chat) {
            return res.status(404).json({ error: "Chat not found" });
        }

        res.writeHead(200, {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive",
            "X-Accel-Buffering": "no"
        });

        if (typeof res.flushHeaders === "function") {
            res.flushHeaders();
        }

        const send = (event, data) => {
            if (!res.writableEnded && !res.destroyed) {
                res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
            }
        };

        let full = "";
        const sources = new Map();
        let clientGone = false;

        // The request can close normally after its body is received.
        // Only treat the connection as gone when the response itself closes
        // before we have finished sending it.
        req.on("aborted", () => {
            clientGone = true;
        });

        res.on("close", () => {
            if (!res.writableEnded) {
                clientGone = true;
            }
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
                    systemInstruction: SYSTEM_INSTRUCTION,
                    tools: [{ googleSearch: {} }]
                }
            });

            for await (const chunk of stream) {
                if (clientGone) break;

                const piece = chunk.text;

                if (piece) {
                    full += piece;
                    send("chunk", { text: piece });
                }

                const groundingChunks = chunk.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
                for (const groundingChunk of groundingChunks) {
                    const web = groundingChunk.web;
                    if (!web?.uri || !/^https?:\/\//i.test(web.uri)) continue;

                    if (!sources.has(web.uri)) {
                        let title = web.title || "";
                        try {
                            title = title || new URL(web.uri).hostname.replace(/^www\./, "");
                        } catch {}

                        sources.set(web.uri, {
                            title,
                            url: web.uri
                        });
                    }
                }
            }

            if (!clientGone) {
                const sourceList = [...sources.values()].slice(0, 8);

                if (sourceList.length) {
                    send("sources", { sources: sourceList });
                }

                send("done", { fullText: full });
                res.end();
            }
        } catch (error) {
            console.error("Gemini stream error:", error);

            if (!clientGone) {
                send("error", {
                    error: "JAY AI could not complete that request. Please try again."
                });
                res.end();
            }
        } finally {
            if (full) {
                try {
                    const sourceList = [...sources.values()].slice(0, 8);

                    if (sourceList.length) {
                        full += "\n\n---\n\n**Sources**\n" +
                            sourceList
                                .map(source => `- [${source.title}](${source.url})`)
                                .join("\n");
                    }

                    await appendAssistantMessage(req.params.id, full);
                } catch (saveError) {
                    console.error("Failed to save assistant response:", saveError);
                }
            }
        }
    } catch (error) {
        next(error);
    }
});

app.use((err, req, res, next) => {
    console.error("Unhandled server error:", err);

    if (res.headersSent) {
        return next(err);
    }

    res.status(500).json({
        error: "JAY AI encountered a server error. Please try again."
    });
});

async function start() {
    try {
        await initPostgres();

        app.listen(PORT, "0.0.0.0", () => {
            console.log(`JAY AI running on port ${PORT}`);
            console.log("Gemini API key loaded:", Boolean(process.env.GEMINI_API_KEY));
            console.log("Database:", USE_POSTGRES ? "Postgres" : "local JSON fallback");
        });
    } catch (error) {
        console.error("Failed to initialize JAY AI:", error);
        process.exit(1);
    }
}

start();
