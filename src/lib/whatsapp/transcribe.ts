import type { SupabaseClient } from "@supabase/supabase-js";

import { decrypt } from "@/lib/whatsapp/encryption";

// ============================================================
// Transcrição de áudio via OpenAI (Whisper). A chave é DO CLIENTE
// (por conta), guardada cifrada em accounts.openai_api_key. Tudo aqui
// é best-effort: qualquer falha só loga e retorna null — nunca lança.
// ============================================================

const OPENAI_TRANSCRIBE_URL = "https://api.openai.com/v1/audio/transcriptions";

/** Chave OpenAI (decifrada) da conta, ou null se não configurada. */
export async function getAccountOpenAiKey(
  db: SupabaseClient,
  accountId: string,
): Promise<string | null> {
  const { data } = await db
    .from("accounts")
    .select("openai_api_key")
    .eq("id", accountId)
    .maybeSingle();
  const enc = (data?.openai_api_key as string | null) ?? null;
  if (!enc) return null;
  try {
    return decrypt(enc);
  } catch {
    return null;
  }
}

function extForMime(mime: string): string {
  if (mime.includes("mpeg") || mime.includes("mp3")) return "mp3";
  if (mime.includes("mp4") || mime.includes("m4a") || mime.includes("aac"))
    return "m4a";
  if (mime.includes("wav")) return "wav";
  if (mime.includes("webm")) return "webm";
  if (mime.includes("amr")) return "amr";
  return "ogg"; // opus/ogg (voz do WhatsApp) e default
}

/**
 * Transcreve bytes de áudio via Whisper. Retorna o texto, ou null se a
 * chave estiver ausente/ inválida ou a API falhar.
 */
export async function transcribeAudio(
  bytes: Uint8Array,
  mime: string,
  apiKey: string,
): Promise<string | null> {
  if (!apiKey || !bytes || bytes.length === 0) return null;
  try {
    const type = mime || "audio/ogg";
    const form = new FormData();
    form.append(
      "file",
      new Blob([bytes as BlobPart], { type }),
      `audio.${extForMime(type)}`,
    );
    form.append("model", "whisper-1");

    const res = await fetch(OPENAI_TRANSCRIBE_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    });
    if (!res.ok) {
      console.error(
        "[transcribe] OpenAI",
        res.status,
        (await res.text()).slice(0, 200),
      );
      return null;
    }
    const data = (await res.json()) as { text?: string };
    const text = data.text?.trim();
    return text ? text : null;
  } catch (err) {
    console.error("[transcribe] erro:", err);
    return null;
  }
}
