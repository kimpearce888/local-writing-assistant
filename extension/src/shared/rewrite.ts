/**
 * Rewrite API used by the side panel.
 *
 * Sends a `rewrite` request to the native host. Returns the rewritten
 * text — never applies it directly. The caller (side panel) is
 * responsible for the explicit Replace step.
 */

import { NativeResponse, RewriteOperation, ToneMode } from "../shared/types";
import { sendNative } from "../shared/native-bridge";
import { buildRewritePrompt, buildTonePrompt } from "../shared/prompts";
import { parseRewriteResponse } from "../shared/ai-validation";
import { getSettings } from "../shared/storage";

export interface RewriteOutcome {
  rewritten: string;
  explanation: string;
}

export async function runRewrite(
  text: string,
  operation: RewriteOperation,
  customInstruction?: string,
): Promise<RewriteOutcome> {
  const settings = await getSettings();
  if (!text.trim()) {
    throw { code: "INVALID_AI_RESPONSE", message: "no text supplied" };
  }
  if (text.length > settings.maxTextSize) {
    throw { code: "REQUEST_TOO_LARGE", message: "selection too large" };
  }
  const prompt =
    operation === "custom"
      ? buildRewritePrompt({ operation, customInstruction })
      : buildRewritePrompt({ operation });

  const resp: NativeResponse = await sendNative(
    "rewrite",
    {
      text,
      systemPrompt: prompt.system,
      model: settings.model,
      temperature: settings.temperature,
      maxTokens: settings.maxTokens,
      timeoutMs: settings.requestTimeoutMs,
    },
    settings.requestTimeoutMs + 5000,
  );
  if (!resp.ok) {
    throw {
      code: resp.errorCode ?? "NATIVE_HOST_UNAVAILABLE",
      message: resp.error ?? "native host error",
    };
  }
  const data = resp.data as { raw?: string };
  if (!data || typeof data.raw !== "string") {
    throw { code: "INVALID_AI_RESPONSE", message: "missing raw output" };
  }
  return parseRewriteResponse(data.raw);
}

export async function runToneTransform(
  text: string,
  tone: ToneMode,
): Promise<RewriteOutcome> {
  const settings = await getSettings();
  if (text.length > settings.maxTextSize) {
    throw { code: "REQUEST_TOO_LARGE", message: "selection too large" };
  }
  const prompt = buildTonePrompt({ tone });
  const resp: NativeResponse = await sendNative(
    "rewrite",
    {
      text,
      systemPrompt: prompt.system,
      model: settings.model,
      temperature: settings.temperature,
      maxTokens: settings.maxTokens,
      timeoutMs: settings.requestTimeoutMs,
    },
    settings.requestTimeoutMs + 5000,
  );
  if (!resp.ok) {
    throw {
      code: resp.errorCode ?? "NATIVE_HOST_UNAVAILABLE",
      message: resp.error ?? "native host error",
    };
  }
  const data = resp.data as { raw?: string };
  if (!data || typeof data.raw !== "string") {
    throw { code: "INVALID_AI_RESPONSE", message: "missing raw output" };
  }
  return parseRewriteResponse(data.raw);
}
