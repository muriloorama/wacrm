import type { SupabaseClient } from "@supabase/supabase-js";

import { getAccountOpenAiKey } from "@/lib/whatsapp/transcribe";
import { sendMessageToConversation } from "@/lib/whatsapp/send-message";

// ============================================================
// Atendimento IA (Fase 1). A IA responde o cliente sozinha e faz handoff
// para um humano quando não sabe ou o cliente pede. Usa a chave OpenAI DO
// CLIENTE (accounts.openai_api_key). Tudo é best-effort: qualquer falha só
// loga e retorna — nunca lança para não derrubar o webhook.
// ============================================================

const OPENAI_CHAT_URL = "https://api.openai.com/v1/chat/completions";

const DEFAULT_MODEL = "gpt-4o-mini";
const DEFAULT_HISTORY_LIMIT = 12;
const DEFAULT_DEBOUNCE_MS = 1500;
const DEFAULT_HANDOFF_MESSAGE =
  "Só um momento, vou te encaminhar para um atendente. 🙌";
const DEFAULT_SYSTEM_PROMPT =
  "Você é um atendente virtual educado e objetivo que responde clientes pelo WhatsApp em português do Brasil. Seja breve e cordial. Se não souber a resposta com segurança, se o assunto for sensível, ou se o cliente pedir para falar com uma pessoa, use a ferramenta de transferência para um atendente humano em vez de inventar.";

export interface AiAccountConfig {
  enabled: boolean;
  systemPrompt: string;
  model: string;
  historyLimit: number;
  debounceMs: number;
  handoffMessage: string;
}

/** Lê a config de IA da conta (accounts). Nunca lança. */
export async function getAccountAiConfig(
  db: SupabaseClient,
  accountId: string,
): Promise<AiAccountConfig> {
  const { data } = await db
    .from("accounts")
    .select("ai_enabled, ai_system_prompt, ai_model, ai_config")
    .eq("id", accountId)
    .maybeSingle();

  const cfg = (data?.ai_config ?? {}) as Record<string, unknown>;
  const num = (v: unknown, fallback: number) =>
    typeof v === "number" && Number.isFinite(v) ? v : fallback;

  return {
    enabled: Boolean(data?.ai_enabled),
    systemPrompt:
      (data?.ai_system_prompt as string | null)?.trim() || DEFAULT_SYSTEM_PROMPT,
    model: (data?.ai_model as string | null)?.trim() || DEFAULT_MODEL,
    historyLimit: num(cfg.history_limit, DEFAULT_HISTORY_LIMIT),
    debounceMs: num(cfg.debounce_ms, DEFAULT_DEBOUNCE_MS),
    handoffMessage:
      typeof cfg.handoff_message === "string" && cfg.handoff_message.trim()
        ? cfg.handoff_message.trim()
        : DEFAULT_HANDOFF_MESSAGE,
  };
}

type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

interface AiReplyResult {
  text: string | null;
  handoff: boolean;
  handoffReason?: string;
}

const HANDOFF_TOOL = {
  type: "function" as const,
  function: {
    name: "transferir_para_humano",
    description:
      "Use quando NÃO souber responder com segurança, quando o cliente pedir para falar com uma pessoa/atendente, ou em assuntos sensíveis (reclamação grave, jurídico, cobrança/financeiro complexo, cancelamento). Não invente respostas.",
    parameters: {
      type: "object",
      properties: {
        motivo: {
          type: "string",
          description: "Motivo curto do encaminhamento para o humano.",
        },
      },
      required: ["motivo"],
    },
  },
};

/**
 * Gera a resposta da IA a partir do histórico. Retorna o texto a enviar, ou
 * sinaliza handoff (quando o modelo chama a ferramenta). Best-effort: em
 * qualquer falha retorna { text: null, handoff: false }.
 */
export async function generateAiReply(args: {
  apiKey: string;
  model: string;
  systemPrompt: string;
  history: ChatMessage[];
}): Promise<AiReplyResult> {
  const { apiKey, model, systemPrompt, history } = args;
  if (!apiKey || history.length === 0) return { text: null, handoff: false };

  try {
    const res = await fetch(OPENAI_CHAT_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "system", content: systemPrompt }, ...history],
        tools: [HANDOFF_TOOL],
        tool_choice: "auto",
        temperature: 0.4,
        max_tokens: 500,
      }),
    });

    if (!res.ok) {
      console.error(
        "[ai] OpenAI",
        res.status,
        (await res.text()).slice(0, 200),
      );
      return { text: null, handoff: false };
    }

    const data = (await res.json()) as {
      choices?: {
        message?: {
          content?: string | null;
          tool_calls?: { function?: { name?: string; arguments?: string } }[];
        };
      }[];
    };

    const message = data.choices?.[0]?.message;
    const toolCall = message?.tool_calls?.find(
      (t) => t.function?.name === "transferir_para_humano",
    );
    if (toolCall) {
      let motivo: string | undefined;
      try {
        motivo = (JSON.parse(toolCall.function?.arguments ?? "{}") as {
          motivo?: string;
        }).motivo;
      } catch {
        /* argumentos malformados — segue sem motivo */
      }
      return { text: null, handoff: true, handoffReason: motivo };
    }

    const text = message?.content?.trim() || null;
    return { text, handoff: false };
  } catch (err) {
    console.error("[ai] generateAiReply erro:", err);
    return { text: null, handoff: false };
  }
}

/** Converte uma linha de `messages` numa mensagem de chat para a OpenAI. */
function toChatMessage(row: {
  sender_type: string;
  content_type: string;
  content_text: string | null;
  transcription: string | null;
}): ChatMessage | null {
  const role: ChatMessage["role"] =
    row.sender_type === "customer" ? "user" : "assistant";

  let content = row.content_text?.trim() || row.transcription?.trim() || "";
  if (!content) {
    // Mídia sem legenda/transcrição — dá contexto mínimo ao modelo.
    const label: Record<string, string> = {
      image: "[imagem]",
      video: "[vídeo]",
      audio: "[áudio]",
      document: "[documento]",
      location: "[localização]",
    };
    content = label[row.content_type] ?? "";
  }
  if (!content) return null;
  return { role, content };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Ponto de entrada do atendimento IA, chamado no after() do webhook quando um
 * fluxo NÃO consumiu a mensagem. Decide se responde, faz o debounce de rajada,
 * gera a resposta e envia como 'bot' — ou faz handoff (status 'pending').
 * Nunca lança.
 */
export async function maybeAiRespond(input: {
  db: SupabaseClient;
  accountId: string;
  conversationId: string;
  /** `messages.id` da mensagem recebida que disparou este atendimento. */
  triggerMessageId: string;
}): Promise<void> {
  const { db, accountId, conversationId, triggerMessageId } = input;
  try {
    const cfg = await getAccountAiConfig(db, accountId);
    if (!cfg.enabled) return;

    // Estado da conversa: IA pausada ou humano no comando → não responde.
    const { data: conv } = await db
      .from("conversations")
      .select("ai_paused, assigned_agent_id")
      .eq("id", conversationId)
      .maybeSingle();
    if (!conv || conv.ai_paused || conv.assigned_agent_id) return;

    const apiKey = await getAccountOpenAiKey(db, accountId);
    if (!apiKey) {
      console.warn("[ai] conta sem chave OpenAI configurada:", accountId);
      return;
    }

    // Debounce de rajada: espera um pouco e só o handler da ÚLTIMA mensagem
    // segue. Se algo (nova msg do cliente, ou já respondemos) chegou depois,
    // esta execução desiste — evita responder cada fragmento e evita loop.
    await sleep(cfg.debounceMs);
    const { data: latest } = await db
      .from("messages")
      .select("id")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!latest || latest.id !== triggerMessageId) return;

    // Histórico recente (mais antigo → mais novo) para dar contexto.
    const { data: rows } = await db
      .from("messages")
      .select("sender_type, content_type, content_text, transcription")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: false })
      .limit(cfg.historyLimit);
    const history = (rows ?? [])
      .reverse()
      .map(toChatMessage)
      .filter((m): m is ChatMessage => m !== null);
    if (history.length === 0) return;

    const result = await generateAiReply({
      apiKey,
      model: cfg.model,
      systemPrompt: cfg.systemPrompt,
      history,
    });

    if (result.handoff) {
      if (cfg.handoffMessage) {
        await safeSend(db, accountId, conversationId, cfg.handoffMessage);
      }
      // Marca 'pending' para os atendentes verem que precisa de humano.
      await db
        .from("conversations")
        .update({ status: "pending", updated_at: new Date().toISOString() })
        .eq("id", conversationId);
      return;
    }

    const text = result.text?.trim();
    if (!text) return;
    await safeSend(db, accountId, conversationId, text);
  } catch (err) {
    console.error("[ai] maybeAiRespond erro:", err);
  }
}

/** Envia texto como 'bot'. Best-effort — encapsula o try/catch. */
async function safeSend(
  db: SupabaseClient,
  accountId: string,
  conversationId: string,
  text: string,
): Promise<void> {
  try {
    await sendMessageToConversation(db, accountId, {
      conversationId,
      messageType: "text",
      contentText: text,
      senderType: "bot",
    });
  } catch (err) {
    console.error("[ai] falha ao enviar resposta da IA:", err);
  }
}
