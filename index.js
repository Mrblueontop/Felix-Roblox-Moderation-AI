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

ALLOW = appropriate, normal, or constructive criticism.

REVIEW = genuinely ambiguous content where you cannot confidently determine whether it is an attack, harassment, or inappropriate content.

REMOVE = any of the following:
- Direct insults or roasts targeting the creator.
- Insults or roasts targeting the creator's videos/content.
- Harassment or bullying directed at the creator.
- Threats or hateful content.
- Sexual or seriously inappropriate content.
- Scams or obvious spam.
- "kys" or similar expressions encouraging suicide/self-harm.
- Evasive variants of "kys", including misspellings, spacing, punctuation, numbers, repeated letters, Unicode lookalikes, or inserted symbols/emojis.
- Attempts to disguise insults or prohibited language.

IMPORTANT:
A direct roast or insult should be REMOVED even if it is phrased as slang, joking language, or internet slang.

Examples that should be REMOVE:
"your video sucks"
"your corny bro"
"holy cornball bro delete ts rn"
"kys"
"go kys bro"
"your content is trash"

Normal criticism is ALLOW:
"I didn't really enjoy this video"
"I think the editing could be better"
"This wasn't my favorite video"

Do NOT remove innocent uses of words merely because they resemble prohibited language.
For example, "I lost my keys" is ALLOW.

Consider the entire context and intent. Do not remove a comment solely because it contains an isolated word that could have an innocent meaning.

Return ONLY valid JSON:
{
  "action": "SPECIAL | ALLOW | REVIEW | REMOVE",
  "confidence": 0.00,
  "reason": "short explanation"
}`
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
