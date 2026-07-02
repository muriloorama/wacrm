import "server-only";

// ============================================================
// Abstração de provedor de WhatsApp: Meta Cloud API | uazapi.
//
// Ponto único onde o envio decide qual backend usar. Os "senders"
// (send-message, automations, flows, broadcast) resolvem a config da
// conta, decriptam os tokens e chamam `getProvider(config).sendX(...)`
// em vez de importar meta-api diretamente.
//
// Seleção: `config.provider` (persistido por conta) tem prioridade;
// na ausência, cai no padrão do sistema definido em env
// (WHATSAPP_PROVIDER). O servidor/admintoken do uazapi vivem só em env.
// ============================================================

import {
  sendTextMessage,
  sendMediaMessage,
  sendReactionMessage,
  type MediaKind,
} from "@/lib/whatsapp/meta-api";
import * as uazapi from "@/lib/whatsapp/uazapi-api";

export type WhatsAppProviderKind = "meta" | "uazapi";

export interface SendTextArgs {
  to: string;
  text: string;
  contextMessageId?: string;
}
export interface SendMediaArgs {
  to: string;
  kind: MediaKind;
  link: string;
  caption?: string;
  filename?: string;
  contextMessageId?: string;
}
export interface SendReactionArgs {
  to: string;
  targetMessageId: string;
  emoji: string;
}

export interface WhatsAppProvider {
  readonly kind: WhatsAppProviderKind;
  sendText(a: SendTextArgs): Promise<{ messageId: string }>;
  sendMedia(a: SendMediaArgs): Promise<{ messageId: string }>;
  sendReaction(a: SendReactionArgs): Promise<void>;
}

/** Config resolvida (tokens já DECRIPTADOS) para escolher o provider. */
export interface ProviderConfig {
  provider?: string | null;
  // Meta
  phoneNumberId?: string | null;
  accessToken?: string | null;
  // uazapi
  uazapiToken?: string | null;
}

class MetaProvider implements WhatsAppProvider {
  readonly kind = "meta" as const;
  constructor(
    private phoneNumberId: string,
    private accessToken: string,
  ) {}

  sendText(a: SendTextArgs) {
    return sendTextMessage({
      phoneNumberId: this.phoneNumberId,
      accessToken: this.accessToken,
      to: a.to,
      text: a.text,
      contextMessageId: a.contextMessageId,
    });
  }

  sendMedia(a: SendMediaArgs) {
    return sendMediaMessage({
      phoneNumberId: this.phoneNumberId,
      accessToken: this.accessToken,
      to: a.to,
      kind: a.kind,
      link: a.link,
      caption: a.caption,
      filename: a.filename,
      contextMessageId: a.contextMessageId,
    });
  }

  async sendReaction(a: SendReactionArgs) {
    await sendReactionMessage({
      phoneNumberId: this.phoneNumberId,
      accessToken: this.accessToken,
      to: a.to,
      targetMessageId: a.targetMessageId,
      emoji: a.emoji,
    });
  }
}

class UazapiProvider implements WhatsAppProvider {
  readonly kind = "uazapi" as const;
  constructor(private token: string) {}

  sendText(a: SendTextArgs) {
    return uazapi.sendText({
      token: this.token,
      to: a.to,
      text: a.text,
      replyId: a.contextMessageId,
    });
  }

  sendMedia(a: SendMediaArgs) {
    // Os 4 tipos da Meta são um subconjunto dos tipos do uazapi.
    return uazapi.sendMedia({
      token: this.token,
      to: a.to,
      kind: a.kind as uazapi.UazapiMediaKind,
      file: a.link,
      caption: a.caption,
      filename: a.filename,
      replyId: a.contextMessageId,
    });
  }

  sendReaction(a: SendReactionArgs) {
    return uazapi.sendReaction({
      token: this.token,
      to: a.to,
      targetMessageId: a.targetMessageId,
      emoji: a.emoji,
    });
  }
}

/** Provedor padrão do sistema, definido por env (fallback). */
export function defaultProviderKind(): WhatsAppProviderKind {
  return process.env.WHATSAPP_PROVIDER === "uazapi" ? "uazapi" : "meta";
}

/**
 * Instancia o provider certo a partir da config da conta. Lança se
 * faltar credencial do provider escolhido — o chamador transforma em
 * erro amigável (toast).
 */
export function getProvider(config: ProviderConfig): WhatsAppProvider {
  const kind: WhatsAppProviderKind =
    config.provider === "uazapi" || config.provider === "meta"
      ? config.provider
      : defaultProviderKind();

  if (kind === "uazapi") {
    if (!config.uazapiToken) {
      throw new Error("Instância do uazapi não conectada para esta conta.");
    }
    return new UazapiProvider(config.uazapiToken);
  }

  if (!config.phoneNumberId || !config.accessToken) {
    throw new Error("Credenciais do WhatsApp (Meta) ausentes para esta conta.");
  }
  return new MetaProvider(config.phoneNumberId, config.accessToken);
}
