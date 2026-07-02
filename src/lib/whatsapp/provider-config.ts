import "server-only";

// ============================================================
// Helper compartilhado: deriva a config do provider (Meta | uazapi)
// a partir de uma linha `whatsapp_config` (ou `whatsapp_channels`),
// decriptando o token do provider em uso. Usado pelos "senders" do
// motor (automations, flows, broadcast) para escolher o backend via
// `getProvider(...)` em vez de chamar meta-api diretamente.
//
// Espelha a lógica de resolução já existente em send-message.ts,
// centralizada aqui para não duplicar decrypt/branch por arquivo.
// ============================================================

import { decrypt } from "@/lib/whatsapp/encryption";
import type { ProviderConfig, WhatsAppProviderKind } from "@/lib/whatsapp/provider";
import type { MessageTemplate } from "@/types";

/** Colunas mínimas que o helper lê de whatsapp_config/whatsapp_channels. */
export interface ProviderConfigRow {
  provider?: string | null;
  phone_number_id?: string | null;
  access_token?: string | null;
  uazapi_instance_token?: string | null;
}

/** ProviderConfig (tokens já DECRIPTADOS) + o nome do provider resolvido. */
export interface ResolvedProviderConfig extends ProviderConfig {
  providerName: WhatsAppProviderKind;
}

/**
 * Deriva a ProviderConfig decriptada a partir de uma linha de config.
 * Lança `Error` se faltar a credencial do provider em uso — o chamador
 * decide como transformar isso na sua própria resposta de erro.
 */
export function resolveProviderConfig(
  config: ProviderConfigRow,
): ResolvedProviderConfig {
  const providerName: WhatsAppProviderKind =
    config.provider === "uazapi" ? "uazapi" : "meta";

  if (providerName === "uazapi") {
    if (!config.uazapi_instance_token) {
      throw new Error(
        "WhatsApp por QR Code não conectado para esta conta.",
      );
    }
    return {
      providerName,
      provider: providerName,
      phoneNumberId: config.phone_number_id ?? null,
      accessToken: null,
      uazapiToken: decrypt(config.uazapi_instance_token),
    };
  }

  if (!config.access_token) {
    throw new Error("WhatsApp (Meta) não configurado para esta conta.");
  }
  return {
    providerName,
    provider: providerName,
    phoneNumberId: config.phone_number_id ?? null,
    accessToken: decrypt(config.access_token),
    uazapiToken: undefined,
  };
}

/**
 * Renderiza o corpo de um template substituindo {{1}}, {{2}}… pelos
 * params posicionais. Usado quando o provedor é o uazapi (que não tem
 * templates aprovados pela Meta) — o texto sai como mensagem normal.
 */
export function renderTemplateBody(
  row: Pick<MessageTemplate, "body_text"> | null | undefined,
  params: string[] | null | undefined,
): string {
  let body = (row?.body_text as string) ?? "";
  (params ?? []).forEach((p, i) => {
    body = body.replace(
      new RegExp(`\\{\\{\\s*${i + 1}\\s*\\}\\}`, "g"),
      p ?? "",
    );
  });
  return body;
}
