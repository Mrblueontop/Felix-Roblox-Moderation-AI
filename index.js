const express = require("express");
const Groq = require("groq-sdk");
const { google } = require("googleapis");

const app = express();
const PORT = process.env.PORT || 3000;

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY
});

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);

const YOUTUBE_SCOPES = [
  "https://www.googleapis.com/auth/youtube.force-ssl"
];

app.use(express.json());

/* =========================
   CONFIG
========================= */

const POLL_INTERVAL = 10 * 1000;
const MAX_VIDEOS_TO_CHECK = 1000;

const processedComments = new Map();

/* =========================
   BASIC ROUTES
========================= */

app.get("/", (req, res) => {
  res.send("🤖 YouTube AI Moderator is online!");
});

/* =========================
   YOUTUBE OAUTH
========================= */

app.get("/auth/youtube", (req, res) => {
  try {
    const authUrl = oauth2Client.generateAuthUrl({
      access_type: "offline",
      prompt: "consent",
      scope: YOUTUBE_SCOPES
    });

    res.redirect(authUrl);
  } catch (error) {
    console.error("AUTH URL ERROR:", error.message);
    res.status(500).send("Could not start YouTube authorization.");
  }
});

app.get("/oauth2callback", async (req, res) => {
  try {
    const { code } = req.query;

    if (!code) {
      return res.status(400).send(
        "Missing OAuth authorization code."
      );
    }

    const { tokens } = await oauth2Client.getToken(code);

    console.log("YouTube OAuth successful.");
    console.log(
      "Refresh token received:",
      Boolean(tokens.refresh_token)
    );

    if (!tokens.refresh_token) {
      return res.status(400).send(
        "Google did not provide a refresh token. Try authorizing again."
      );
    }

    res.send(`
      <h2>✅ YouTube authorization successful!</h2>
      <p>Your refresh token was received.</p>
      <p>Close this page.</p>
    `);

  } catch (error) {
    console.error(
      "YOUTUBE OAUTH ERROR:",
      error.response?.data || error.message
    );

    res.status(500).send(
      "YouTube authorization failed."
    );
  }
});

/* =========================
   YOUTUBE CLIENT
========================= */

function getYouTubeClient() {
  const refreshToken = process.env.YOUTUBE_REFRESH_TOKEN;

  if (!refreshToken) {
    throw new Error(
      "YOUTUBE_REFRESH_TOKEN is missing from Railway Variables."
    );
  }

  oauth2Client.setCredentials({
    refresh_token: refreshToken
  });

  return google.youtube({
    version: "v3",
    auth: oauth2Client
  });
}

/* =========================
   TEST YOUTUBE CONNECTION
========================= */

app.get("/test-youtube", async (req, res) => {
  try {
    const youtube = getYouTubeClient();

    const response = await youtube.channels.list({
      part: "snippet,contentDetails",
      mine: true
    });

    const channel = response.data.items?.[0];

    if (!channel) {
      return res.status(500).json({
        connected: false,
        error: "YouTube channel could not be found."
      });
    }

    res.json({
      connected: true,
      channelName: channel.snippet.title,
      channelId: channel.id,
      message: "YouTube connection is working."
    });

  } catch (error) {
    console.error(
      "YOUTUBE TEST ERROR:",
      error.response?.data || error.message
    );

    res.status(500).json({
      connected: false,
      error: "YouTube connection failed."
    });
  }
});

/* =========================
   AI MODERATION
========================= */

async function moderateComment(comment) {
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

REMOVE = clearly unacceptable content, including:

- Direct insults or roasts targeting the creator.
- Insults or roasts targeting the creator's videos/content.
- Harassment or bullying directed at the creator.
- Threats.
- Hateful content.
- Sexual or seriously inappropriate content.
- Scams.
- Obvious spam.
- "kys" or expressions encouraging suicide/self-harm.
- Evasive variants of prohibited language.
- Insults disguised with slang or jokes.
- Spam designed to manipulate engagement.
- Repeated promotional comments.
- Malicious or deceptive comments.

Direct creator insults should be REMOVE even when they are slang or joking.

Examples REMOVE:
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

Do NOT remove innocent uses of words.

Example:
"I lost my keys"
= ALLOW

Understand context and intent.

Look through obvious spelling tricks, spacing, punctuation,
numbers, Unicode lookalikes, repeated characters,
inserted symbols/emojis, and other attempts to evade moderation.

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

  const raw = completion.choices[0].message.content;

  let parsed;

  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      `AI returned invalid JSON: ${raw}`
    );
  }

  const validActions = [
    "SPECIAL",
    "ALLOW",
    "REVIEW",
    "REMOVE"
  ];

  if (!validActions.includes(parsed.action)) {
    throw new Error(
      `Invalid AI action: ${parsed.action}`
    );
  }

  let confidence = Number(parsed.confidence);

  if (!Number.isFinite(confidence)) {
    confidence = 0;
  }

  confidence = Math.max(
    0,
    Math.min(1, confidence)
  );

  return {
    action: parsed.action,
    confidence,
    reason: parsed.reason || ""
  };
}

/* =========================
   REMOVE COMMENT
========================= */

async function removeComment(youtube, commentId) {
  await youtube.comments.setModerationStatus({
    id: commentId,
    moderationStatus: "rejected"
  });
}

/* =========================
   GET CHANNEL VIDEOS
========================= */

async function getRecentVideos(youtube) {
  const channelResponse = await youtube.channels.list({
    part: "contentDetails",
    mine: true
  });

  const channel = channelResponse.data.items?.[0];

  if (!channel) {
    throw new Error("Could not find authenticated YouTube channel.");
  }

  const uploadsPlaylistId =
    channel.contentDetails.relatedPlaylists.uploads;

  const playlistResponse =
    await youtube.playlistItems.list({
      part: "contentDetails",
      playlistId: uploadsPlaylistId,
      maxResults: MAX_VIDEOS_TO_CHECK
    });

  return (playlistResponse.data.items || [])
    .map(item => item.contentDetails.videoId)
    .filter(Boolean);
}

/* =========================
   MODERATE COMMENTS
========================= */

async function checkComments() {
  try {
    const youtube = getYouTubeClient();

    const videoIds = await getRecentVideos(youtube);

    console.log(
      `Checking ${videoIds.length} recent videos...`
    );

    for (const videoId of videoIds) {
      let nextPageToken = undefined;

      do {
        const response =
          await youtube.commentThreads.list({
            part: "snippet",
            videoId,
            maxResults: 100,
            order: "time",
            pageToken: nextPageToken
          });

        const threads = response.data.items || [];

        for (const thread of threads) {
          const topLevelComment =
            thread.snippet?.topLevelComment;

          const commentId = topLevelComment?.id;

          const comment =
            topLevelComment?.snippet?.textDisplay ||
            topLevelComment?.snippet?.textOriginal;

          const author =
            topLevelComment?.snippet?.authorDisplayName;

          if (!commentId || !comment) {
            continue;
          }

          if (processedComments.has(commentId)) {
            continue;
          }

          processedComments.set(
            commentId,
            Date.now()
          );

          try {
            const result =
              await moderateComment(comment);

            console.log("");
            console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
            console.log("COMMENT:", comment);
            console.log("AUTHOR:", author || "Unknown");
            console.log("ACTION:", result.action);
            console.log(
              "CONFIDENCE:",
              result.confidence
            );
            console.log(
              "REASON:",
              result.reason
            );

            if (
              result.action === "REMOVE" &&
              result.confidence >= 0.85
            ) {
              await removeComment(
                youtube,
                commentId
              );

              console.log(
                "🗑️ COMMENT REMOVED"
              );
            }

            if (result.action === "SPECIAL") {
              console.log(
                "❤️ SPECIAL COMMENT DETECTED"
              );

              console.log(
                "NOTE: YouTube Data API does not provide an official comment-heart write endpoint."
              );
            }

            console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
            console.log("");

          } catch (error) {
            console.error(
              "COMMENT MODERATION ERROR:",
              error.message
            );
          }
        }

        nextPageToken =
          response.data.nextPageToken;

      } while (nextPageToken);
    }

    cleanupProcessedComments();

  } catch (error) {
    console.error(
      "COMMENT CHECK ERROR:",
      error.response?.data || error.message
    );
  }
}

/* =========================
   MEMORY CLEANUP
========================= */

function cleanupProcessedComments() {
  const expiration =
    Date.now() - 24 * 60 * 60 * 1000;

  for (const [
    commentId,
    timestamp
  ] of processedComments.entries()) {
    if (timestamp < expiration) {
      processedComments.delete(commentId);
    }
  }
}

/* =========================
   TEST AI ENDPOINT
========================= */

app.post("/moderate-test", async (req, res) => {
  try {
    const { comment } = req.body;

    if (!comment || typeof comment !== "string") {
      return res.status(400).json({
        error: "Please provide a comment."
      });
    }

    const result =
      await moderateComment(comment);

    res.json({
      testMode: true,
      action: result.action,
      confidence: result.confidence,
      reason: result.reason,
      youtubeActionTaken: false
    });

  } catch (error) {
    console.error(
      "MODERATION ERROR:",
      error.message
    );

    res.status(500).json({
      error: "AI moderation failed."
    });
  }
});

/* =========================
   START SERVER
========================= */

app.listen(PORT, () => {
  console.log(
    `Moderator running on port ${PORT}`
  );

  setTimeout(() => {
    checkComments();

    setInterval(
      checkComments,
      POLL_INTERVAL
    );
  }, 5000);
});
