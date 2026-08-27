const ALLOWED_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
const MAX_BASE64_LENGTH = Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 8;
const MAX_REQUEST_BYTES = 4_300_000;
const MAX_REQUESTS_PER_WINDOW = 12;
const RATE_WINDOW_MS = 10 * 60 * 1000;
const requestWindows = new Map();

function sendJson(response, statusCode, body) {
  response.status(statusCode).setHeader("Content-Type", "application/json; charset=utf-8").json(body);
}

function reject(response, statusCode, code, message) {
  sendJson(response, statusCode, { error: { code, message } });
}

function clientAddress(request) {
  const forwarded = request.headers["x-forwarded-for"];
  return typeof forwarded === "string" ? forwarded.split(",")[0].trim() : "unknown";
}

function isRateLimited(address) {
  const now = Date.now();
  const previous = requestWindows.get(address)?.filter((time) => now - time < RATE_WINDOW_MS) ?? [];
  if (previous.length >= MAX_REQUESTS_PER_WINDOW) {
    requestWindows.set(address, previous);
    return true;
  }
  previous.push(now);
  requestWindows.set(address, previous);
  return false;
}

function decodeAndValidateImage(imageBase64, mimeType) {
  if (!ALLOWED_MIME_TYPES.has(mimeType)) {
    throw new RequestError(415, "UNSUPPORTED_MIME_TYPE", "Only JPEG, PNG, and WEBP images are supported.");
  }
  if (typeof imageBase64 !== "string" || imageBase64.length === 0) {
    throw new RequestError(400, "INVALID_IMAGE", "imageBase64 is required.");
  }
  if (imageBase64.length > MAX_BASE64_LENGTH) {
    throw new RequestError(413, "IMAGE_TOO_LARGE", "The image exceeds the 3 MB analysis limit.");
  }
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(imageBase64) || imageBase64.length % 4 !== 0) {
    throw new RequestError(400, "INVALID_IMAGE", "imageBase64 must be valid base64 image data.");
  }

  const image = Buffer.from(imageBase64, "base64");
  if (image.length === 0 || image.length > MAX_IMAGE_BYTES) {
    throw new RequestError(413, "IMAGE_TOO_LARGE", "The image exceeds the 3 MB analysis limit.");
  }
  if (image.toString("base64") !== imageBase64) {
    throw new RequestError(400, "INVALID_IMAGE", "imageBase64 is malformed.");
  }

  const detectedMimeType = detectMimeType(image);
  if (!detectedMimeType || detectedMimeType !== mimeType) {
    throw new RequestError(400, "INVALID_IMAGE", "The image data does not match the declared MIME type.");
  }
  return image;
}

function detectMimeType(image) {
  if (image.length >= 3 && image[0] === 0xff && image[1] === 0xd8 && image[2] === 0xff) return "image/jpeg";
  if (image.length >= 8 && image.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (image.length >= 12 && image.subarray(0, 4).toString("ascii") === "RIFF" && image.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return null;
}

function parseAnalysis(rawText) {
  const text = rawText.trim().replace(/^```json\s*/i, "").replace(/\s*```$/, "");
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ResponseError("The AI service returned an invalid analysis response.");
  }
  const description = typeof parsed?.description === "string" ? parsed.description.trim() : "";
  const objects = Array.isArray(parsed?.objects)
    ? parsed.objects.filter((item) => typeof item === "string").map((item) => item.trim()).filter(Boolean).slice(0, 40)
    : null;
  const detectedText = typeof parsed?.text === "string" ? parsed.text.trim() : null;
  const importantDetails = typeof parsed?.importantDetails === "string" ? parsed.importantDetails.trim() : null;
  if (!description || !objects || detectedText === null || importantDetails === null) {
    throw new ResponseError("The AI service returned an incomplete analysis response.");
  }
  return {
    description: description.slice(0, 2000),
    objects: objects.map((item) => item.slice(0, 200)),
    text: detectedText.slice(0, 4000),
    importantDetails: importantDetails.slice(0, 2000),
  };
}

class RequestError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

class ResponseError extends Error {}

export const config = {
  api: { bodyParser: { sizeLimit: "4mb" } },
};

export default async function analyzeImage(request, response) {
  response.setHeader("Cache-Control", "no-store");
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    return reject(response, 405, "METHOD_NOT_ALLOWED", "Use POST for this endpoint.");
  }
  const contentLength = Number(request.headers["content-length"] ?? 0);
  if (contentLength > MAX_REQUEST_BYTES) {
    return reject(response, 413, "REQUEST_TOO_LARGE", "The request exceeds the allowed size.");
  }
  if (isRateLimited(clientAddress(request))) {
    response.setHeader("Retry-After", "600");
    return reject(response, 429, "RATE_LIMITED", "Too many analysis requests. Please try again later.");
  }

  try {
    const { imageBase64, mimeType } = request.body ?? {};
    const image = decodeAndValidateImage(imageBase64, mimeType);
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return reject(response, 503, "SERVICE_NOT_CONFIGURED", "The analysis service is not configured.");
    }

    const geminiResponse = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{
            role: "user",
            parts: [
              { text: "Analyze this image. Return only valid JSON with exactly these fields: description (string), objects (array of short strings), text (string containing visible text or empty string), importantDetails (string). Do not invent facts. If uncertain, state that briefly in description or importantDetails." },
              { inlineData: { mimeType, data: image.toString("base64") } },
            ],
          }],
          generationConfig: { responseMimeType: "application/json", temperature: 0.2, maxOutputTokens: 1024 },
        }),
        signal: AbortSignal.timeout(55_000),
      },
    );

    if (!geminiResponse.ok) {
      return reject(response, geminiResponse.status === 429 ? 429 : 502, "AI_SERVICE_ERROR", "The AI analysis service is temporarily unavailable.");
    }
    const geminiPayload = await geminiResponse.json();
    const rawText = geminiPayload?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (typeof rawText !== "string") throw new ResponseError("The AI service returned no analysis.");
    return sendJson(response, 200, parseAnalysis(rawText));
  } catch (error) {
    if (error instanceof RequestError) return reject(response, error.statusCode, error.code, error.message);
    if (error instanceof ResponseError) return reject(response, 502, "AI_RESPONSE_INVALID", "The AI analysis service returned an invalid response.");
    if (error?.name === "TimeoutError" || error?.name === "AbortError") {
      return reject(response, 504, "AI_TIMEOUT", "The AI analysis request timed out. Please try again.");
    }
    return reject(response, 502, "AI_SERVICE_ERROR", "The AI analysis service is temporarily unavailable.");
  }
}
