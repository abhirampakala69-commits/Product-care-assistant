
import "dotenv/config";
import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY
});

async function main() {
    const response = await ai.models.generateContent({
        model: "gemini-2.5-flash",
        contents: "Reply with exactly: Gemini connection successful!"
    });

    console.log(response.text);
}

main().catch((error) => {
    console.error("Gemini test failed:", error.message);
});
