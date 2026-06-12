/**
 * AI photo upscaling for doctor headshots (ProviderMember.photoUrl).
 *
 * Doctor photos scraped from clinic sites are often low-resolution and render
 * blurry on the full-bleed doctor cards (swipe-deck-card.tsx). This FAITHFULLY
 * upscales the source image with Gemini's latest image model
 * (gemini-3.1-flash-image). The 3.x image models enhance the REAL pixels in
 * place - preserving the actual person, texture, and composition while adding
 * genuine sharpness - unlike gemini-2.5-flash-image which regenerated the photo
 * into a plasticky AI-painted face.
 *
 * The prompt is deliberately conservative: act as a pure super-resolution
 * upscaler, NEVER regenerate/redraw/stylize, preserve the exact likeness,
 * composition, and background of the real photo.
 *
 * Returns null (caller keeps the original) if the API key is missing, the model
 * returns no image, or anything throws - never blocks enrichment on a failure.
 */

import { GoogleGenAI } from "@google/genai";

// gemini-3.1-flash-image: faithful enhancement (~9s). The older
// gemini-2.5-flash-image REGENERATED the photo (plasticky AI face); the 3.x
// image models enhance the real pixels in place. gemini-3-pro-image is
// marginally sharper but ~17s/photo - flash is the cost/speed sweet spot.
const UPSCALE_MODEL = "gemini-3.1-flash-image";

const UPSCALE_PROMPT =
  "This is a real photograph of a real person. Increase its resolution and sharpness so it is crisp and clear. " +
  "Do NOT regenerate, redraw, repaint, smooth, beautify, or stylize it - preserve every original detail, texture, " +
  "skin pore, and the EXACT likeness of this specific real person. Keep the background, framing, lighting, glasses, " +
  "and clothing exactly as they are. Act strictly as a faithful photo super-resolution upscaler: same photo, higher " +
  "resolution. Output only the enhanced photo.";

export interface UpscaledImage {
  buffer: Buffer;
  mime: string;
}

/**
 * Upscale a single image buffer. Pure Gemini call - the caller is responsible
 * for downloading the source and uploading the result to GCS.
 */
export async function upscaleImageBuffer(
  srcBuffer: Buffer,
  mime: string,
): Promise<UpscaledImage | null> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;
  // Gemini image input must be a real image with content.
  if (!srcBuffer || srcBuffer.length < 1024) return null;

  try {
    const ai = new GoogleGenAI({ apiKey });
    const response: any = await ai.models.generateContent({
      model: UPSCALE_MODEL,
      contents: [
        {
          role: "user",
          parts: [
            { inlineData: { mimeType: mime, data: srcBuffer.toString("base64") } },
            { text: UPSCALE_PROMPT },
          ],
        },
      ],
      config: { responseModalities: ["IMAGE"] },
    });
    const parts = response?.candidates?.[0]?.content?.parts || [];
    for (const p of parts) {
      if (p?.inlineData?.data) {
        return {
          buffer: Buffer.from(p.inlineData.data, "base64"),
          mime: p.inlineData.mimeType || "image/png",
        };
      }
    }
    return null;
  } catch {
    return null;
  }
}
