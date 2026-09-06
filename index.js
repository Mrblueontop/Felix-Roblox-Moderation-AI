const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
  res.send("🤖 YouTube AI Moderator is online!");
});

app.listen(PORT, () => {
  console.log(`Moderator running on port ${PORT}`);
});
