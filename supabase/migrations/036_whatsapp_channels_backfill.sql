-- 036_whatsapp_channels_backfill
--
-- Fecha o DRIFT entre o banco de produção e as migrations versionadas.
-- Os objetos abaixo (tabela whatsapp_channels e as colunas channel_id,
-- is_group, group_sender_name) foram aplicados direto na prod fora do
-- fluxo de migrations, então um ambiente novo criado a partir de
-- supabase/migrations/ ficava sem eles — quebrando o webhook uazapi, o
-- envio por canal e o inbox de grupos. Esta migration reproduz EXATAMENTE
-- o schema de produção (introspeccionado) de forma idempotente: no-op na
-- prod (tudo já existe), e cria tudo num banco limpo.
--
-- Reproduz o schema tal como estava na prod em 2026-07-04.

-- ============================================================
-- Tabela whatsapp_channels — um "canal" (número) de WhatsApp por conta,
-- provedor Meta ou uazapi (QR Code). Credenciais por canal.
-- ============================================================
CREATE TABLE IF NOT EXISTS whatsapp_channels (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'uazapi'
    CHECK (provider IN ('meta', 'uazapi')),
  uazapi_instance_id TEXT,
  uazapi_instance_token TEXT,
  phone_number_id TEXT,
  access_token TEXT,
  phone TEXT,
  status TEXT NOT NULL DEFAULT 'disconnected',
  created_by UUID,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS whatsapp_channels_account_idx
  ON whatsapp_channels(account_id);
CREATE INDEX IF NOT EXISTS whatsapp_channels_instance_idx
  ON whatsapp_channels(uazapi_instance_id);

-- RLS — leitura por membro (viewer+), escrita por admin+. Igual às demais
-- tabelas de tenant (via is_account_member da 017). DROP+CREATE para ser
-- idempotente (CREATE POLICY não tem IF NOT EXISTS).
ALTER TABLE whatsapp_channels ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS whatsapp_channels_select ON whatsapp_channels;
CREATE POLICY whatsapp_channels_select ON whatsapp_channels
  FOR SELECT USING (is_account_member(account_id, 'viewer'));

DROP POLICY IF EXISTS whatsapp_channels_insert ON whatsapp_channels;
CREATE POLICY whatsapp_channels_insert ON whatsapp_channels
  FOR INSERT WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS whatsapp_channels_update ON whatsapp_channels;
CREATE POLICY whatsapp_channels_update ON whatsapp_channels
  FOR UPDATE USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS whatsapp_channels_delete ON whatsapp_channels;
CREATE POLICY whatsapp_channels_delete ON whatsapp_channels
  FOR DELETE USING (is_account_member(account_id, 'admin'));

-- ============================================================
-- conversations.channel_id — a qual canal a conversa pertence. Mesmo
-- contato em canais diferentes = conversas separadas (a resolução do
-- webhook/envio filtra por channel_id).
-- ============================================================
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS channel_id UUID;

-- FK só se ainda não existir (ADD CONSTRAINT não tem IF NOT EXISTS).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'conversations_channel_id_fkey'
  ) THEN
    ALTER TABLE conversations
      ADD CONSTRAINT conversations_channel_id_fkey
      FOREIGN KEY (channel_id) REFERENCES whatsapp_channels(id) ON DELETE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS conversations_channel_idx
  ON conversations(channel_id);

-- ============================================================
-- contacts.is_group — contato é um grupo de WhatsApp (phone = id do grupo;
-- JID reconstruído como `<id>@g.us` no envio).
-- ============================================================
ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS is_group BOOLEAN NOT NULL DEFAULT false;

-- ============================================================
-- messages.group_sender_name — nome do remetente real dentro de um grupo
-- (o "from" de cada mensagem de grupo), exibido no balão.
-- ============================================================
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS group_sender_name TEXT;
