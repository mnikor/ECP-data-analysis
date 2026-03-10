<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://github.com/user-attachments/assets/0aa67016-6eaf-458a-adb2-6e31a0763ed6" />
</div>

# Run and deploy your AI Studio app

This contains everything you need to run your app locally.

View your app in AI Studio: https://ai.studio/apps/e30ff1a0-27b6-4b3e-9145-c67089e0d577

## Run Locally

**Prerequisites:**  Node.js


1. Install dependencies:
   `npm install`
2. Set the `GEMINI_API_KEY` in `.env.local` to your Gemini API key.
   The key is now read by the local Node server only and is not injected into the browser bundle.
3. Run the app:
   `npm run dev`

## Production-style local run

1. Build the frontend:
   `npm run build`
2. Start the integrated app/API server:
   `npm run start`
