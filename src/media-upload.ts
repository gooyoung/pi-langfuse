import type { LangfuseRuntime } from "./types.js";

interface ImageContent {
  type: "image";
  data: string;
  mimeType: string;
}

function isImageContent(value: unknown): value is ImageContent {
  return (
    !!value &&
    typeof value === "object" &&
    (value as Record<string, unknown>).type === "image" &&
    typeof (value as Record<string, unknown>).data === "string" &&
    typeof (value as Record<string, unknown>).mimeType === "string"
  );
}

async function uploadOneImage(
  rt: LangfuseRuntime,
  image: ImageContent,
  traceId: string,
  field: string,
): Promise<string> {
  const { LangfuseMedia, uploadMedia } = await import("@langfuse/core");
  const media = new LangfuseMedia({
    source: "base64_data_uri",
    base64DataUri: `data:${image.mimeType};base64,${image.data}`,
  });
  await uploadMedia({
    // ponytail: LangfuseScoreClient only *declares* trace/ingestion; the runtime object handed in
    // is a real @langfuse/client LangfuseClient whose `.api` is the full LangfuseAPIClient (incl. `.media`).
    apiClient: (rt.scoreClient as unknown as { api: Parameters<typeof uploadMedia>[0]["apiClient"] }).api,
    media,
    traceId,
    field,
  });
  const tag = await media.getTag();
  if (!tag) {
    throw new Error("Failed to generate Langfuse media tag");
  }
  return tag;
}

/**
 * Walks a captured input/output payload and replaces `{ type: "image", data, mimeType }`
 * nodes with uploaded Langfuse media reference tags, so images render inline in the
 * Langfuse UI instead of being stripped or truncated.
 *
 * ponytail: only handles the one shape pi actually emits for attached images. Other
 * multimodal shapes (audio, file attachments, provider-specific image parts in tool
 * output) aren't uploaded yet — add when a handler starts emitting them.
 */
export async function uploadImagesInPlace(
  rt: LangfuseRuntime,
  value: unknown,
  traceId: string,
  field: "input" | "output",
): Promise<unknown> {
  if (Array.isArray(value)) {
    return Promise.all(value.map((item) => uploadImagesInPlace(rt, item, traceId, field)));
  }

  if (isImageContent(value)) {
    try {
      return await uploadOneImage(rt, value, traceId, field);
    } catch (e) {
      console.warn("📊 Langfuse: Failed to upload image media; omitting from trace", e);
      return "[image upload failed]";
    }
  }

  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = await uploadImagesInPlace(rt, item, traceId, field);
    }
    return out;
  }

  return value;
}
