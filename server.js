import express from "express";
import dotenv from "dotenv";
import { GoogleGenAI } from "@google/genai";

dotenv.config();

const app = express();
const PORT = 3000;

const ai = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY
});

app.use(express.json());
app.use(express.static("."));

app.post("/chat", async (req, res) => {

    try {

        const { message, history = [] } = req.body;

        if (!message) {

            return res.status(400).json({
                error: "No message provided"
            });

        }


        const contents = [

            ...history.map(item => ({
                role: item.role === "assistant"
                    ? "model"
                    : "user",

                parts: [
                    {
                        text: item.content
                    }
                ]
            })),

            {
                role: "user",

                parts: [
                    {
                        text: message
                    }
                ]
            }

        ];


        const response = await ai.models.generateContent({

            model: "gemini-3.6-flash",

            contents: contents

        });


        res.json({
            reply: response.text
        });


    } catch (error) {

        console.error("Gemini error:", error);

        res.status(500).json({
            error: "Gemini request failed"
        });

    }

});

app.listen(PORT, () => {
    console.log(`JAY AI running at http://localhost:${PORT}`);
});

console.log("Gemini API key loaded:", !!process.env.GEMINI_API_KEY);
dotenv.config();