/**
 * Shared media-upload helper. O storage é o Backblaze B2 (S3-compatível,
 * bucket público). O caminho segue a convenção com prefixo lógico +
 * escopo de conta:
 *
 *   <bucket>/account-<account_id>/<timestamp>-<basename>.<ext>
 *
 * O upload NÃO usa a chave do B2 no navegador: pede uma URL pré-assinada
 * à rota `/api/media/presign` (que valida login + resolve a conta no
 * servidor) e faz o PUT direto no B2. Tanto o builder de Fluxos
 * (`node-config-form`) quanto o compositor do inbox chamam este helper,
 * então a lógica vive em exatamente um lugar.
 */

/** 16 MB — matches the `file_size_limit` on both buckets (migrations 016/020/023). */
export const MEDIA_MAX_BYTES = 16 * 1024 * 1024;

/**
 * Per-kind upload ceilings that mirror Meta's WhatsApp Cloud API caps so
 * a file that the bucket would accept (≤16 MB) but Meta would reject is
 * caught client-side BEFORE upload — otherwise it lands in storage as an
 * orphan and the send fails with a confusing 400. Images are Meta's
 * tightest cap at 5 MB; documents are held at the 16 MB bucket limit
 * (Meta allows 100 MB, but the bucket — and shared-hosting upload UX —
 * caps lower).
 */
export const MEDIA_MAX_BYTES_BY_KIND = {
  image: 5 * 1024 * 1024,
  video: 16 * 1024 * 1024,
  audio: 16 * 1024 * 1024,
  document: 16 * 1024 * 1024,
} as const;

/**
 * Build the account-scoped object path for an upload. Pure + exported so
 * it can be unit-tested without a Supabase client.
 *
 * - `basename` is stripped of its extension, lower-cased non-safe chars
 *   are collapsed to `_`, and it's capped at 40 chars (falls back to
 *   "file" when empty).
 * - The timestamp + the original name keep collisions between two
 *   concurrent uploads astronomically unlikely.
 */
export function buildMediaPath(
  accountId: string,
  fileName: string,
  now: number = Date.now(),
): string {
  // Only treat the trailing segment as an extension when there's a real
  // one — a bare name like "README" has no extension and falls back to
  // "bin" rather than becoming "readme".
  const hasExt = /\.[^.]+$/.test(fileName);
  const ext = hasExt ? fileName.split(".").pop()!.toLowerCase() : "bin";
  const safeBase =
    fileName
      .replace(/\.[^.]+$/, "")
      .replace(/[^a-zA-Z0-9_-]+/g, "_")
      .slice(0, 40) || "file";
  return `account-${accountId}/${now}-${safeBase}.${ext}`;
}

export interface UploadAccountMediaResult {
  /** Public URL Meta can fetch at send time. */
  publicUrl: string;
  /** Storage object path (account-scoped). */
  path: string;
}

/**
 * Faz upload de um arquivo para o bucket B2 (escopo de conta) e retorna
 * a URL pública. Lança com mensagem amigável em falha de autenticação /
 * resolução de conta / upload — os chamadores exibem via toast.
 *
 * A validação de tamanho é responsabilidade do chamador (limites variam
 * por recurso); `MEDIA_MAX_BYTES` é exportado para o caso comum.
 *
 * `bucket` é um prefixo lógico ("chat-media" | "flow-media" | "avatars")
 * que separa os arquivos dentro do bucket B2 físico.
 */
export async function uploadAccountMedia(
  bucket: string,
  file: File,
): Promise<UploadAccountMediaResult> {
  const contentType = file.type || "application/octet-stream";

  // 1) Pede a URL pré-assinada ao servidor (auth + conta resolvidos lá).
  const presignRes = await fetch("/api/media/presign", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      bucket,
      fileName: file.name,
      contentType,
      size: file.size,
    }),
  });
  if (!presignRes.ok) {
    const data = (await presignRes.json().catch(() => null)) as
      | { error?: string }
      | null;
    throw new Error(data?.error || "Não foi possível preparar o envio do arquivo.");
  }
  const { uploadUrl, publicUrl, path } = (await presignRes.json()) as {
    uploadUrl: string;
    publicUrl: string;
    path: string;
  };

  // 2) Sobe o arquivo direto no B2 com a URL pré-assinada.
  const putRes = await fetch(uploadUrl, {
    method: "PUT",
    body: file,
    headers: { "Content-Type": contentType },
  });
  if (!putRes.ok) {
    throw new Error("Falha ao enviar o arquivo para o armazenamento.");
  }

  return { publicUrl, path };
}

/**
 * Remove um objeto enviado anteriormente. Usado para limpar mídia que
 * foi preparada (upload) mas nunca enviada — um rascunho cancelado ou um
 * envio à Meta que falhou — para que anexos abandonados não se acumulem
 * no bucket. A rota valida que o objeto pertence à conta do chamador.
 *
 * Best-effort: os chamadores disparam sem aguardar e engolem erros (uma
 * remoção perdida é um detalhe de storage, não algo a mostrar ao usuário).
 */
export async function deleteAccountMedia(
  _bucket: string,
  path: string,
): Promise<void> {
  await fetch("/api/media/delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });
}
