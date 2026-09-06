const express = require("express");
const Groq = require("groq-sdk");

const app = express();
const PORT = process.env.PORT || 3000;

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY
});

app.use(express.json());

app.get("/", (req, res) => {
  res.send("🤖 YouTube AI Moderator is online!");
});

app.get("/test-ai", async (req, res) => {
  try {
    const completion = await groq.chat.completions.create({
      model: "openai/gpt-oss-120b",
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
    console.error("GROQ ERROR:", error.message);
    console.error("STATUS:", error.status);
    res.status(500).send("Groq connection failed.");
  }
});

// TEST MODE ONLY — does NOT touch YouTube.
app.post("/moderate-test", async (req, res) => {
  try {
    const { comment } = req.body;

    if (!comment || typeof comment !== "string") {
      return res.status(400).json({
        error: "Please provide a comment."
      });
    }

    const completion = await groq.chat.completions.create({
      model: "openai/gpt-oss-120b",
      messages: [
        {
          role: "system",
          content: `
You are an AI YouTube comment moderator.

Classify the comment into exactly ONE action:

SPECIAL = exceptionally wholesome, supportive, or genuinely encouraging.
ALLOW = appropriate and ordinary.
REVIEW = questionable, ambiguous, or potentially inappropriate but not clearly removable.
REMOVE = clearly hateful, threatening, sexually inappropriate, seriously harassing, scammy, spammy, or otherwise unsafe.

Consider the entire context. Do not remove a comment merely because it contains a word that could be offensive in another context.

Return ONLY valid JSON:
{
  "action": "SPECIAL | ALLOW | REVIEW | REMOVE",
  "confidence": 0.00,
  "reason": "short explanation"
}
          `
        },
        {
          role: "user",
          content: `Comment to moderate:\n${comment}`
        }
      ],
      temperature: 0
    });

    const result = completion.choices[0].message.content;

    let parsed;

    try {
      parsed = JSON.parse(result);
    } catch {
      return res.status(500).json({
        error: "AI returned invalid JSON.",
        raw: result
      });
    }

    res.json({
      testMode: true,
      action: parsed.action,
      confidence: parsed.confidence,
      reason: parsed.reason,
      youtubeActionTaken: false
    });

  } catch (error) {
    console.error("MODERATION ERROR:", error.message);
    res.status(500).json({
      error: "AI moderation failed."
    });
  }
});

app.listen(PORT, () => {
  console.log(`Moderator running on port ${PORT}`);
});
