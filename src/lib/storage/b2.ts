import "server-only";

import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

// ============================================================
// Backblaze B2 storage (S3-compatible).
//
// Substitui o Supabase Storage. Todo upload de mídia (avatares,
// anexos do inbox, mídia de fluxos) vai para um único bucket B2
// PÚBLICO, com os arquivos separados por prefixo lógico
// (`chat-media/`, `flow-media/`, `avatars/`) e por conta
// (`account-<id>/`), montado em `buildMediaPath`.
//
// A Application Key do B2 é SEGREDO e nunca vai ao navegador — este
// módulo é `server-only`. O cliente pede uma URL pré-assinada à rota
// /api/media/presign e faz o PUT direto no B2 (evita o limite de
// corpo de requisição da Vercel e não expõe a chave).
// ============================================================

const rawEndpoint = process.env.B2_S3_ENDPOINT ?? "";
// aceita com ou sem protocolo
const host = rawEndpoint.replace(/^https?:\/\//, "").replace(/\/+$/, "");
const region =
  process.env.B2_REGION ||
  host.match(/^s3\.([a-z0-9-]+)\.backblazeb2\.com/i)?.[1] ||
  "us-east-005";
const bucket = process.env.B2_BUCKET ?? "";
const keyId = process.env.B2_KEY_ID ?? "";
const appKey = process.env.B2_APP_KEY ?? "";

/** True quando todas as variáveis do B2 estão presentes. */
export function isB2Configured(): boolean {
  return Boolean(host && bucket && keyId && appKey);
}

let client: S3Client | null = null;
function s3(): S3Client {
  if (!client) {
    client = new S3Client({
      region,
      endpoint: `https://${host}`,
      credentials: { accessKeyId: keyId, secretAccessKey: appKey },
      // B2 é servido em path-style (endpoint/bucket/key).
      forcePathStyle: true,
    });
  }
  return client;
}

/** URL pré-assinada para o navegador fazer PUT direto no bucket. */
export async function presignPutUrl(
  key: string,
  contentType: string,
  expiresIn = 600,
): Promise<string> {
  const cmd = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    ContentType: contentType,
  });
  return getSignedUrl(s3(), cmd, { expiresIn });
}

/** URL pública permanente do objeto (bucket público). */
export function publicUrl(key: string): string {
  const base =
    (process.env.B2_PUBLIC_BASE_URL || `https://${host}/${bucket}`).replace(
      /\/+$/,
      "",
    );
  const encoded = key
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
  return `${base}/${encoded}`;
}

/** Remove um objeto do bucket. */
export async function deleteObject(key: string): Promise<void> {
  await s3().send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}
