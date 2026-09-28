---
prompts:
  - prompt: Build a Chrome extension that pulls our orders from a supplier portal with no API, from the user's signed-in session, and sends them to our app.
    stack: Chrome MV3
  - prompt: Our extension's service worker dies and records go missing. Make the sync reliable with an offline buffer and a single polled endpoint.
    stack: Chrome MV3
  - prompt: Pair the extension with a user's account in our app using a PIN, instead of asking for their password.
    stack: Chrome MV3
---

# Prompts

What an operator types after installing this skill, in their own words. An agent eval installs the skill
into an empty Next.js app, gives the agent one of these prompts and no further help, then type-checks, builds
and tests the result; the first prompt runs before every release. The results are the other files in this
folder. Section 10 of [STANDARD.md](https://github.com/timerise-ai/skills/blob/main/STANDARD.md) says how a
run is made. The prompts and the newest runs are on
[the skill's page](https://timerise.ai/skills/browser-extension-connector) on timerise.ai.
