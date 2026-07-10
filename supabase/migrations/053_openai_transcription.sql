-- 053_openai_transcription
--
-- Transcrição automática de áudios recebidos.
--
--   1. accounts.openai_api_key — chave da OpenAI DO CLIENTE (por conta),
--      guardada CIFRADA (AES-256-GCM, mesmo encrypt() dos tokens). O admin
--      da conta configura em Configurações → Transcrição de áudio. Só é
--      lida no servidor (webhook, via service-role) para transcrever.
--   2. messages.transcription — texto transcrito de mensagens de áudio.
--
-- RLS: sem mudança. accounts_update (admin+) já cobre a escrita; a leitura
-- da chave acontece só via service-role no webhook. O valor é ciphertext.
-- ============================================================

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS openai_api_key TEXT;

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS transcription TEXT;
