const express = require("express");
const Groq = require("groq-sdk");

const app = express();
const PORT = process.env.PORT || 3000;

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY
});

app.get("/", (req, res) => {
  res.send("🤖 YouTube AI Moderator is online!");
});

app.get("/test-ai", async (req, res) => {
  try {
    const completion = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [
        {
          role: "user",
          content: "Reply with exactly: AI moderator connection successful!"
        }
      ],
      temperature: 0
    });

    res.send(completion.choices[0].message.content);
  } catch (error) {
    console.error(error);
    console.error("GROQ ERROR:", error.message);
    console.error("STATUS:", error.status);
  }
});

app.listen(PORT, () => {
  console.log(`Moderator running on port ${PORT}`);
});
