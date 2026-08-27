# Easy Analyze Images Backend

Vercel serverless backend for the native Android app. The public endpoint is `POST /analyze-image`; it expects `imageBase64` and `mimeType`, validates JPEG, PNG, and WEBP images, and asks Gemini Vision to return a structured analysis.

Set `GEMINI_API_KEY` as a Vercel server-side environment variable for Production and Preview. Never commit a key, add it to `vercel.json`, or place it in the Android APK. The endpoint limits decoded images to 3 MB and uses a best-effort per-instance rate limit.
