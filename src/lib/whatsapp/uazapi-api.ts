import "server-only";

// ============================================================
// uazapi (uazapiGO) — cliente HTTP de baixo nível.
//
// Provedor ALTERNATIVO ao WhatsApp Cloud API da Meta. É um gateway
// baseado em WhatsApp Web (Baileys): conecta um número por QR/pairing
// e envia por 1 endpoint por tipo (o `file` aceita URL direta).
//
// SEGREDOS (ADMIN-ONLY, nunca expostos ao cliente):
//   UAZAPI_SERVER_URL   — ex.: https://agendaai.uazapi.com
//   UAZAPI_ADMIN_TOKEN  — token do servidor; provisiona/lista instâncias
//
// Autenticação por header (apiKey, NÃO Bearer):
//   - header `admintoken`  → operações de servidor (criar/listar instância)
//   - header `token`       → operações da instância (conectar, enviar, webhook)
//
// O token da instância é gerado no POST /instance/create e guardado por
// conta em `whatsapp_config` (nunca vai ao navegador).
// ============================================================

const SERVER_URL = (process.env.UAZAPI_SERVER_URL ?? "").replace(/\/+$/, "");
const ADMIN_TOKEN = process.env.UAZAPI_ADMIN_TOKEN ?? "";

/** True quando o provedor uazapi está configurado no servidor. */
export function isUazapiConfigured(): boolean {
  return Boolean(SERVER_URL && ADMIN_TOKEN);
}

export class UazapiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "UazapiError";
    this.status = status;
  }
}

type AuthKind = "admin" | "instance";

async function call<T = unknown>(
  path: string,
  opts: {
    method?: "GET" | "POST" | "DELETE";
    auth: AuthKind;
    token?: string; // obrigatório quando auth === "instance"
    body?: unknown;
  },
): Promise<T> {
  if (!SERVER_URL) throw new UazapiError("UAZAPI_SERVER_URL não configurado.", 500);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.auth === "admin") {
    if (!ADMIN_TOKEN) throw new UazapiError("UAZAPI_ADMIN_TOKEN não configurado.", 500);
    headers.admintoken = ADMIN_TOKEN;
  } else {
    if (!opts.token) throw new UazapiError("Token da instância ausente.", 500);
    headers.token = opts.token;
  }

  const res = await fetch(`${SERVER_URL}${path}`, {
    method: opts.method ?? "POST",
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    cache: "no-store",
  });

  const raw = await res.text();
  let data: unknown = null;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    data = raw;
  }

  if (!res.ok) {
    const msg =
      (data as { message_ptbr?: string; error?: string; message?: string })
        ?.message_ptbr ||
      (data as { error?: string })?.error ||
      (data as { message?: string })?.message ||
      `uazapi HTTP ${res.status}`;
    throw new UazapiError(msg, res.status);
  }
  return data as T;
}

// ---------- Instâncias (admin) ----------

export interface UazapiInstance {
  id: string;
  token: string;
  status: string; // disconnected | connecting | connected | hibernated
  name: string;
  profileName?: string;
  qrcode?: string;
  paircode?: string;
}

/** Cria uma nova instância (número). Retorna o token da instância. */
export async function createInstance(name: string): Promise<{ token: string; instance: UazapiInstance }> {
  const data = await call<{ token: string; instance: UazapiInstance }>("/instance/create", {
    auth: "admin",
    body: { name },
  });
  return data;
}

/** Lista todas as instâncias do servidor (admin). */
export async function listInstances(): Promise<UazapiInstance[]> {
  return call<UazapiInstance[]>("/instance/all", { auth: "admin", method: "GET" });
}

/** Remove a instância (usa o token da própria instância). */
export async function deleteInstance(token: string): Promise<void> {
  await call("/instance", { auth: "instance", token, method: "DELETE" });
}

// ---------- Conexão / status (instância) ----------

export interface UazapiStatus {
  instance: { id: string; name: string; status: string; qrcode?: string; paircode?: string };
  status: { connected: boolean; loggedIn: boolean; jid?: { user: string; server: string } };
}

/**
 * Inicia a conexão do número. Sem `phone` → gera QR (base64 em
 * instance.qrcode). Com `phone` → gera pairing code (instance.paircode).
 */
export async function connectInstance(
  token: string,
  opts: { phone?: string; systemName?: string } = {},
): Promise<UazapiStatus> {
  return call<UazapiStatus>("/instance/connect", {
    auth: "instance",
    token,
    body: { ...(opts.phone ? { phone: opts.phone } : {}), systemName: opts.systemName ?? "Super CRM" },
  });
}

/** Status atual da instância (conectada? QR atualizado?). */
export async function getInstanceStatus(token: string): Promise<UazapiStatus> {
  return call<UazapiStatus>("/instance/status", { auth: "instance", token, method: "GET" });
}

/** Desconecta o número (mantém a instância). */
export async function disconnectInstance(token: string): Promise<void> {
  await call("/instance/disconnect", { auth: "instance", token });
}

// ---------- Webhook (instância) ----------

/** Registra/atualiza o webhook da instância para receber mensagens. */
export async function setInstanceWebhook(
  token: string,
  url: string,
): Promise<void> {
  await call("/webhook", {
    auth: "instance",
    token,
    body: {
      action: "add",
      enabled: true,
      url,
      events: ["messages", "messages_update", "connection"],
      // Evita loop: não recebe de volta o que o próprio app enviou.
      excludeMessages: ["wasSentByApi"],
    },
  });
}

// ---------- Envio (instância) ----------

export interface UazapiMessage {
  id: string;
  messageid: string; // id no WhatsApp (equivalente ao wamid da Meta)
  status?: string;
}

/** Extrai o id externo (messageid) da resposta de envio. */
function messageIdOf(m: UazapiMessage | { message?: UazapiMessage }): string {
  const msg = (m as { message?: UazapiMessage }).message ?? (m as UazapiMessage);
  return msg?.messageid || msg?.id || "";
}

export async function sendText(args: {
  token: string;
  to: string;
  text: string;
  replyId?: string;
  delayMs?: number;
}): Promise<{ messageId: string }> {
  const data = await call<UazapiMessage>("/send/text", {
    auth: "instance",
    token: args.token,
    body: {
      number: args.to,
      text: args.text,
      ...(args.replyId ? { replyid: args.replyId } : {}),
      ...(args.delayMs ? { delay: args.delayMs } : {}),
      linkPreview: true,
    },
  });
  return { messageId: messageIdOf(data) };
}

export type UazapiMediaKind = "image" | "video" | "document" | "audio" | "ptt";

export async function sendMedia(args: {
  token: string;
  to: string;
  kind: UazapiMediaKind;
  file: string; // URL ou base64
  caption?: string;
  filename?: string;
  replyId?: string;
}): Promise<{ messageId: string }> {
  const data = await call<UazapiMessage>("/send/media", {
    auth: "instance",
    token: args.token,
    body: {
      number: args.to,
      type: args.kind,
      file: args.file,
      ...(args.caption ? { text: args.caption } : {}),
      ...(args.filename ? { docName: args.filename } : {}),
      ...(args.replyId ? { replyid: args.replyId } : {}),
    },
  });
  return { messageId: messageIdOf(data) };
}

export async function sendReaction(args: {
  token: string;
  to: string;
  targetMessageId: string;
  emoji: string;
}): Promise<void> {
  await call("/message/react", {
    auth: "instance",
    token: args.token,
    body: { number: args.to, id: args.targetMessageId, text: args.emoji },
  });
}
