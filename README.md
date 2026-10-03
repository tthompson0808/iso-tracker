# Iso Tracker

A hands-free timer and log for isometric holds (wall sits, planks, dead hangs). No account, no server. Your history stays in your own browser.

**Use it:** https://tthompson0808.github.io/iso-tracker/ (open in Safari, Share, Add to Home Screen)

## Want to change something? Ask an AI.

You do not need to know how to code.

1. Copy this link: **https://github.com/tthompson0808/iso-tracker**
2. Paste it into an AI chat (Claude, ChatGPT, Gemini, or similar).
3. Say what you want, in plain words. For example: "Make the rest time 90 seconds by default" or "Add a button that lets me add a note to each hold."

The AI reads the project and tells you exactly what to change. Inside the app, Settings has a "Change this app" section with a Copy link button.

---

## Open it

From this folder:

```bash
python3 -m http.server 8765
```

Then open `http://127.0.0.1:8765`. The timer, the install prompt, and offline mode need a normal web address (`http://localhost` or `https://`). Opening the HTML file directly will not keep your history.

## Put it on your phone

1. Publish this folder as a static site over HTTPS. This Grok CLI cannot press the grok.me publish button. Use Grok's share sheet on the web or the phone app, or any static host.
2. In Safari, Share, then Add to Home Screen. The app then fills the screen and keeps the display awake during a workout.
3. A phone on the same Wi-Fi, using `http://` plus your computer's LAN address, is not a secure page. Wake Lock will not run there. Use the HTTPS address.

History is tied to that exact web address. A new address starts empty. Export before you move hosts.

## What a session is

3 rounds of the 6 exercises. Left and right are separate holds, with a 10 second switch between them. That is 24 holds, 6 switches, and a rest after each exercise except the last.

After Start, a workout where every exercise is in Target mode needs no more taps. Max holds end when you tap the clock. Pause and End stay small on purpose so a sweaty hand does not hit them.

## Defaults you can change

Rounds 3, rest 60 seconds, switch 10, get-in-position 5. Voice starts on. The six form-cue lines were written as a starting point. Edit them in Settings.

On an iPhone, the silent switch can mute the beeps. The app cannot detect that. Try a set with the ringer on before you trust the cues.

## Your data

Settings has Export JSON, Export CSV, Import, and Reset. Reset asks you to type `RESET`. If 14 days pass with history and no export, the home screen asks you to export.
