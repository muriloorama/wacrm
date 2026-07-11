-- 055_ai_atendimento
--
-- Módulo de "Atendimento IA" (Fase 1): a IA responde o cliente sozinha no
-- WhatsApp e passa para um humano (handoff) quando não sabe ou o cliente pede.
-- Usa a chave OpenAI DO CLIENTE já existente (accounts.openai_api_key, 053).
--
--   accounts.ai_enabled       — liga/desliga a IA de atendimento na conta.
--   accounts.ai_system_prompt — instruções/persona/regras do negócio.
--   accounts.ai_model         — modelo OpenAI (default gpt-4o-mini).
--   accounts.ai_config        — extras (limites, mensagem de handoff) em JSON.
--   conversations.ai_paused   — quando um humano assume, a IA cala nesta
--                               conversa até ser reativada.
--
-- RLS: sem mudança. accounts_update (admin+) já cobre a escrita da config;
-- conversations já é editável pelo dono/atribuídos (o toggle de pausa no
-- inbox usa o mesmo caminho do unread/arquivar). A IA roda no servidor via
-- service-role no webhook.
-- ============================================================

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS ai_enabled BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS ai_system_prompt TEXT;

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS ai_model TEXT NOT NULL DEFAULT 'gpt-4o-mini';

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS ai_config JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS ai_paused BOOLEAN NOT NULL DEFAULT false;
