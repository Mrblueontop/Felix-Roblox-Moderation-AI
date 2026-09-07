const express = require("express");
const Groq = require("groq-sdk");
const { google } = require("googleapis");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});

const YOUTUBE_SCOPES = [
  "https://www.googleapis.com/auth/youtube.force-ssl",
];

const POLL_INTERVAL = 10 * 1000;
const MAX_VIDEOS_TO_CHECK = 5000;
const REMOVE_CONFIDENCE = 0.85;

// Prevent repeatedly processing the same comment/reply.
const processedComments = new Map();

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);

// --------------------------------------------------
// Discord logging
// --------------------------------------------------

async function sendDiscordLog({
  action,
  author,
  comment,
  confidence,
  reason,
  videoId,
  type,
  removed,
}) {
  const webhook = process.env.DISCORD_WEBHOOK_URL;

  if (!webhook) {
    console.log("DISCORD_WEBHOOK_URL is not configured.");
    return;
  }

  try {
    const response = await fetch(webhook, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        embeds: [
          {
            title:
              action === "REMOVE"
                ? "🗑️ Comment Removed"
                : action === "SPECIAL"
                  ? "⭐ Special Comment"
                  : "✅ Comment Allowed",

            fields: [
              {
                name: "Author",
                value: author || "Unknown",
                inline: true,
              },
              {
                name: "Type",
                value: type || "Comment",
                inline: true,
              },
              {
                name: "Action",
                value: action || "UNKNOWN",
                inline: true,
              },
              {
                name: "Confidence",
                value: `${Math.round((confidence || 0) * 100)}%`,
                inline: true,
              },
              {
                name: "Reason",
                value: reason || "No reason provided",
              },
              {
                name: "Comment",
                value:
                  comment && comment.length > 1000
                    ? comment.slice(0, 1000) + "..."
                    : comment || "(empty)",
              },
              {
                name: "Removed",
                value: removed ? "Yes" : "No",
                inline: true,
              },
              {
                name: "Video ID",
                value: videoId || "Unknown",
                inline: true,
              },
            ],
            timestamp: new Date().toISOString(),
          },
        ],
      }),
    });

    if (!response.ok) {
      console.error(
        "Discord webhook failed:",
        response.status,
        await response.text()
      );
    }
  } catch (error) {
    console.error("Discord logging error:", error.message);
  }
}

// --------------------------------------------------
// YouTube authentication
// --------------------------------------------------

function getYouTubeClient() {
  const refreshToken = process.env.YOUTUBE_REFRESH_TOKEN;

  if (!refreshToken) {
    throw new Error("YOUTUBE_REFRESH_TOKEN is missing.");
  }

  oauth2Client.setCredentials({
    refresh_token: refreshToken,
  });

  return google.youtube({
    version: "v3",
    auth: oauth2Client,
  });
}

// --------------------------------------------------
// AI moderation
// --------------------------------------------------

async function moderateText(text) {
  const prompt = `
You are a strict but fair YouTube comment moderator.

Analyze this YouTube comment/reply and classify it.

REMOVE comments that contain:
- Direct insults toward the creator or another person
- Harassment or bullying
- Threats
- Hate speech
- Sexual or inappropriate content
- "kys" or similar suicide encouragement
- Spam
- Scams
- Obvious malicious promotion
- Severe profanity directed at someone
- Evasive versions of prohibited language

The user may try to evade moderation using:
- Misspellings
- Extra spaces
- Punctuation
- Numbers
- Unicode lookalikes
- Emoji inserted into words
- Repeated letters
- Coded language
- Weird capitalization
- Character substitutions

Examples that SHOULD be removed:
"your video sucks"
"your corny bro"
"holy cornball bro delete ts rn"
"kys"
"go kys bro"
"your content is trash"

IMPORTANT:
Constructive criticism should NOT be removed.

Examples that should be allowed:
"I didn't really enjoy this video"
"I think the editing could be better"
"This wasn't my favorite video"

Do NOT remove a comment simply because it disagrees with the creator.

Also identify exceptionally wholesome, positive, supportive, or heartwarming comments as SPECIAL.

Return ONLY valid JSON in exactly this format:

{
  "action": "REMOVE" | "ALLOW" | "SPECIAL",
  "confidence": 0.0,
  "reason": "short explanation"
}

Comment:
${text}
`;

  try {
    const completion = await groq.chat.completions.create({
      model: "openai/gpt-oss-120b",
      temperature: 0,
      messages: [
        {
          role: "system",
          content:
            "You are a precise YouTube moderation classifier. Return only JSON.",
        },
        {
          role: "user",
          content: prompt,
        },
      ],
    });

    const raw = completion.choices?.[0]?.message?.content?.trim();

    if (!raw) {
      throw new Error("Groq returned an empty response.");
    }

    // Handle accidental markdown fences.
    const cleaned = raw
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();

    const result = JSON.parse(cleaned);

    if (
      !["REMOVE", "ALLOW", "SPECIAL"].includes(result.action) ||
      typeof result.confidence !== "number"
    ) {
      throw new Error("Invalid moderation response.");
    }

    return {
      action: result.action,
      confidence: Math.max(0, Math.min(1, result.confidence)),
      reason: result.reason || "No reason provided",
    };
  } catch (error) {
    console.error("AI moderation error:", error.message);

    // Fail safe: if AI fails, do NOT remove the comment.
    return {
      action: "ALLOW",
      confidence: 0,
      reason: "AI moderation failed; comment left untouched",
    };
  }
}

// --------------------------------------------------
// Moderate one comment/reply
// --------------------------------------------------

async function moderateSingleComment({
  youtube,
  commentId,
  text,
  author,
  videoId,
  type,
}) {
  if (!commentId) return;

  if (processedComments.has(commentId)) {
    return;
  }

  processedComments.set(commentId, Date.now());

  console.log(`\nChecking ${type}:`);
  console.log(`Author: ${author}`);
  console.log(`Comment: ${text}`);

  const moderation = await moderateText(text);

  console.log(
    `AI: ${moderation.action} (${Math.round(
      moderation.confidence * 100
    )}%)`
  );
  console.log(`Reason: ${moderation.reason}`);

  let removed = false;

  if (
    moderation.action === "REMOVE" &&
    moderation.confidence >= REMOVE_CONFIDENCE
  ) {
    try {
      await youtube.comments.setModerationStatus({
        id: commentId,
        moderationStatus: "rejected",
      });

      removed = true;

      console.log("🗑️ REMOVED");
    } catch (error) {
      console.error(
        "Failed to remove comment:",
        error.response?.data || error.message
      );
    }
  } else if (moderation.action === "SPECIAL") {
    console.log("⭐ SPECIAL COMMENT DETECTED");
  } else {
    console.log("✅ ALLOWED");
  }

  await sendDiscordLog({
    action: moderation.action,
    author,
    comment: text,
    confidence: moderation.confidence,
    reason: moderation.reason,
    videoId,
    type,
    removed,
  });
}

// --------------------------------------------------
// Get latest channel videos
// --------------------------------------------------

async function getRecentVideos(youtube) {
  const channelResponse = await youtube.channels.list({
    part: "contentDetails",
    mine: true,
  });

  const channel = channelResponse.data.items?.[0];

  if (!channel) {
    throw new Error("Could not find authenticated YouTube channel.");
  }

  const uploadsPlaylistId =
    channel.contentDetails.relatedPlaylists.uploads;

  const response = await youtube.playlistItems.list({
    part: "contentDetails",
    playlistId: uploadsPlaylistId,
    maxResults: MAX_VIDEOS_TO_CHECK,
  });

  return (
    response.data.items
      ?.map((item) => item.contentDetails.videoId)
      .filter(Boolean) || []
  );
}

// --------------------------------------------------
// Get and moderate replies
// --------------------------------------------------

async function checkReplies(youtube, parentCommentId, videoId) {
  let pageToken;

  do {
    const response = await youtube.comments.list({
      part: "snippet",
      parentId: parentCommentId,
      maxResults: 100,
      pageToken,
    });

    const replies = response.data.items || [];

    for (const reply of replies) {
      const snippet = reply.snippet;

      const text =
        snippet.textOriginal ||
        snippet.textDisplay ||
        "";

      const author =
        snippet.authorDisplayName ||
        "Unknown";

      await moderateSingleComment({
        youtube,
        commentId: reply.id,
        text,
        author,
        videoId,
        type: "Reply",
      });
    }

    pageToken = response.data.nextPageToken;
  } while (pageToken);
}

// --------------------------------------------------
// Check comments AND replies
// --------------------------------------------------

async function checkComments() {
  let youtube;

  try {
    youtube = getYouTubeClient();
  } catch (error) {
    console.error("YouTube authentication error:", error.message);
    return;
  }

  try {
    const videoIds = await getRecentVideos(youtube);

    console.log(
      `Checking ${videoIds.length} recent videos...`
    );

    for (const videoId of videoIds) {
      try {
        let pageToken;

        do {
          const response = await youtube.commentThreads.list({
            part: "snippet",
            videoId,
            maxResults: 100,
            order: "time",
            pageToken,
          });

          const threads = response.data.items || [];

          for (const thread of threads) {
            const topLevel =
              thread.snippet?.topLevelComment;

            if (!topLevel) continue;

            const snippet = topLevel.snippet;

            const text =
              snippet.textOriginal ||
              snippet.textDisplay ||
              "";

            const author =
              snippet.authorDisplayName ||
              "Unknown";

            // Moderate the top-level comment.
            await moderateSingleComment({
              youtube,
              commentId: topLevel.id,
              text,
              author,
              videoId,
              type: "Top-level Comment",
            });

            // NEW:
            // Moderate every reply belonging to this comment.
            const replyCount =
              thread.snippet?.totalReplyCount || 0;

            if (replyCount > 0) {
              await checkReplies(
                youtube,
                topLevel.id,
                videoId
              );
            }
          }

          pageToken = response.data.nextPageToken;
        } while (pageToken);
      } catch (error) {
        console.error(
          `Error checking video ${videoId}:`,
          error.response?.data || error.message
        );
      }
    }

    // Keep the in-memory map from growing forever.
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;

    for (const [commentId, timestamp] of processedComments) {
      if (timestamp < cutoff) {
        processedComments.delete(commentId);
      }
    }
  } catch (error) {
    console.error(
      "Comment checking error:",
      error.response?.data || error.message
    );
  }
}

// --------------------------------------------------
// Routes
// --------------------------------------------------

app.get("/", (req, res) => {
  res.json({
    status: "online",
    service: "YouTube AI Moderator",
    features: [
      "AI moderation",
      "Top-level comment moderation",
      "Reply moderation",
      "Automatic removal",
      "Discord logging",
    ],
  });
});

app.get("/auth/youtube", (req, res) => {
  const url = oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: YOUTUBE_SCOPES,
  });

  res.redirect(url);
});

app.get("/oauth2callback", async (req, res) => {
  try {
    const { code } = req.query;

    if (!code) {
      return res.status(400).send("Missing OAuth code.");
    }

    const { tokens } =
      await oauth2Client.getToken(code);

    oauth2Client.setCredentials(tokens);

    res.send(`
      <h1>YouTube Connected Successfully!</h1>
      <p>You can close this page.</p>
    `);
  } catch (error) {
    console.error("OAuth callback error:", error);

    res.status(500).send(
      "YouTube authorization failed: " + error.message
    );
  }
});

app.get("/test-youtube", async (req, res) => {
  try {
    const youtube = getYouTubeClient();

    const response = await youtube.channels.list({
      part: "snippet",
      mine: true,
    });

    const channel = response.data.items?.[0];

    res.json({
      connected: true,
      channel: channel
        ? {
            id: channel.id,
            title: channel.snippet.title,
          }
        : null,
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      connected: false,
      error:
        error.response?.data ||
        error.message,
    });
  }
});

app.get("/moderate-test", async (req, res) => {
  try {
    const text =
      req.query.text ||
      "your video sucks bro";

    const result = await moderateText(text);

    res.json({
      text,
      result,
    });
  } catch (error) {
    res.status(500).json({
      error: error.message,
    });
  }
});

// --------------------------------------------------
// Start server
// --------------------------------------------------

app.listen(PORT, () => {
  console.log(
    `YouTube AI Moderator running on port ${PORT}`
  );

  console.log(
    `Polling every ${POLL_INTERVAL / 1000} seconds`
  );

  // Start immediately.
  checkComments();

  // Continue polling.
  setInterval(checkComments, POLL_INTERVAL);
});
