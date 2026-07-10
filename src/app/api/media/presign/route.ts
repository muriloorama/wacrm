import { NextResponse } from "next/server";

import { createClient } from "@/lib/supabase/server";
import { buildMediaPath, MEDIA_MAX_BYTES } from "@/lib/storage/upload-media";
import { isB2Configured, presignPutUrl, publicUrl } from "@/lib/storage/b2";

// O AWS SDK precisa do runtime Node.js (não Edge).
export const runtime = "nodejs";

/** Prefixos lógicos permitidos dentro do bucket B2. */
const ALLOWED_BUCKETS = new Set([
  "chat-media",
  "flow-media",
  "avatars",
  // Logos white-label da conta (appearance-panel → uploadAccountMedia("logos")).
  // Faltava aqui, então todo upload de logo falhava com "Parâmetros inválidos".
  "logos",
]);

/**
 * Emite uma URL pré-assinada para o cliente subir um arquivo direto no
 * Backblaze B2. Valida login + resolve a conta aqui no servidor (a chave
 * do B2 nunca vai ao navegador) e monta um caminho com escopo de conta.
 */
export async function POST(request: Request) {
  if (!isB2Configured()) {
    return NextResponse.json(
      { error: "Armazenamento não configurado no servidor." },
      { status: 500 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Requisição inválida." }, { status: 400 });
  }

  const { bucket, fileName, contentType, size } = (body ?? {}) as {
    bucket?: unknown;
    fileName?: unknown;
    contentType?: unknown;
    size?: unknown;
  };

  if (
    typeof bucket !== "string" ||
    !ALLOWED_BUCKETS.has(bucket) ||
    typeof fileName !== "string" ||
    fileName.length === 0 ||
    typeof contentType !== "string" ||
    contentType.length === 0
  ) {
    return NextResponse.json({ error: "Parâmetros inválidos." }, { status: 400 });
  }

  if (typeof size === "number" && size > MEDIA_MAX_BYTES) {
    return NextResponse.json(
      { error: "Arquivo excede o tamanho máximo (16 MB)." },
      { status: 413 },
    );
  }

  const supabase = await createClient();
  const {
    data: { user },
    error: userErr,
  } = await supabase.auth.getUser();
  if (userErr || !user) {
    return NextResponse.json({ error: "Você não está autenticado." }, { status: 401 });
  }

  const { data: profile, error: profileErr } = await supabase
    .from("profiles")
    .select("account_id")
    .eq("user_id", user.id)
    .maybeSingle();
  if (profileErr || !profile?.account_id) {
    return NextResponse.json(
      { error: "Não foi possível identificar sua conta." },
      { status: 403 },
    );
  }

  const key = `${bucket}/${buildMediaPath(profile.account_id as string, fileName)}`;
  const uploadUrl = await presignPutUrl(key, contentType);

  return NextResponse.json({ uploadUrl, publicUrl: publicUrl(key), path: key });
}
