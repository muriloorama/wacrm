-- ============================================================
-- 048 — Permissão de canal por membro.
--
-- Regra: owner/admin enxergam todos os canais da conta. agent/viewer
-- enxergam apenas os canais atribuídos em `channel_members`
-- (deny-by-default: sem atribuição, nenhum canal).
--
-- Hoje nenhuma conta tem membro agent/viewer — todos são owner/admin —
-- então esta migration não remove acesso de ninguém no momento em que
-- é aplicada. O deny-by-default só passa a valer quando alguém for
-- rebaixado para agent.
--
-- Contatos e negócios não têm canal: a ligação é indireta, via
-- `conversations.channel_id`, e o mesmo contato pode ter conversas em
-- canais diferentes. Regra adotada (ver can_access_contact):
--   - contato SEM nenhuma conversa (lead de formulário, importado,
--     criado à mão) é visível a todos — são 293 dos 536 contatos hoje,
--     e escondê-los quebraria o funil "Formulário";
--   - contato COM conversas é visível se ao menos uma delas está num
--     canal permitido. As conversas dos outros canais continuam
--     invisíveis (o filtro de conversations/messages cuida disso).
-- ============================================================

CREATE TABLE IF NOT EXISTS channel_members (
  channel_id UUID NOT NULL REFERENCES whatsapp_channels(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- Denormalizado só para a RLS de escrita não precisar de join.
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID,
  PRIMARY KEY (channel_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_channel_members_user ON channel_members(user_id);
CREATE INDEX IF NOT EXISTS idx_channel_members_account_user
  ON channel_members(account_id, user_id);

-- can_access_contact varre as conversas do contato; sem isto vira seq scan
-- a cada linha avaliada pela policy de contacts/deals.
CREATE INDEX IF NOT EXISTS idx_conversations_contact_channel
  ON conversations(contact_id, channel_id);

-- ------------------------------------------------------------
-- Predicados
-- ------------------------------------------------------------

-- Um canal é acessível se o usuário é membro da conta E (é admin+ OU o
-- canal está atribuído a ele). NULL → false.
CREATE OR REPLACE FUNCTION public.can_access_channel(p_channel_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM whatsapp_channels c
    WHERE c.id = p_channel_id
      AND is_account_member(c.account_id)
      AND (
        is_account_member(c.account_id, 'admin')
        OR EXISTS (
          SELECT 1 FROM channel_members cm
          WHERE cm.channel_id = c.id AND cm.user_id = auth.uid()
        )
      )
  );
$$;

-- Contato sem conversa nenhuma é de todos; com conversa, precisa de ao
-- menos uma num canal permitido.
CREATE OR REPLACE FUNCTION public.can_access_contact(p_contact_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $$
  SELECT
    NOT EXISTS (
      SELECT 1 FROM conversations v
      WHERE v.contact_id = p_contact_id AND v.channel_id IS NOT NULL
    )
    OR EXISTS (
      SELECT 1 FROM conversations v
      WHERE v.contact_id = p_contact_id
        AND can_access_channel(v.channel_id)
    );
$$;

-- ------------------------------------------------------------
-- RLS da própria channel_members
-- ------------------------------------------------------------
ALTER TABLE channel_members ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS channel_members_select ON channel_members;
CREATE POLICY channel_members_select ON channel_members
  FOR SELECT USING (is_account_member(account_id));

DROP POLICY IF EXISTS channel_members_insert ON channel_members;
CREATE POLICY channel_members_insert ON channel_members
  FOR INSERT WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS channel_members_delete ON channel_members;
CREATE POLICY channel_members_delete ON channel_members
  FOR DELETE USING (is_account_member(account_id, 'admin'));

-- ------------------------------------------------------------
-- Canais: leitura passa a respeitar a atribuição.
-- Escrita continua admin+ (inalterada).
-- ------------------------------------------------------------
DROP POLICY IF EXISTS whatsapp_channels_select ON whatsapp_channels;
CREATE POLICY whatsapp_channels_select ON whatsapp_channels
  FOR SELECT USING (
    is_account_member(account_id) AND can_access_channel(id)
  );

-- ------------------------------------------------------------
-- Conversas. `channel_id IS NULL` não existe hoje (0 linhas); a cláusula
-- é defensiva e trata a conversa sem canal como órfã — visível.
-- ------------------------------------------------------------
DROP POLICY IF EXISTS conversations_select ON conversations;
CREATE POLICY conversations_select ON conversations
  FOR SELECT USING (
    is_account_member(account_id)
    AND (channel_id IS NULL OR can_access_channel(channel_id))
  );

DROP POLICY IF EXISTS conversations_insert ON conversations;
CREATE POLICY conversations_insert ON conversations
  FOR INSERT WITH CHECK (
    is_account_member(account_id, 'agent')
    AND (channel_id IS NULL OR can_access_channel(channel_id))
  );

DROP POLICY IF EXISTS conversations_update ON conversations;
CREATE POLICY conversations_update ON conversations
  FOR UPDATE USING (
    is_account_member(account_id, 'agent')
    AND (channel_id IS NULL OR can_access_channel(channel_id))
  );

DROP POLICY IF EXISTS conversations_delete ON conversations;
CREATE POLICY conversations_delete ON conversations
  FOR DELETE USING (
    is_account_member(account_id, 'agent')
    AND (channel_id IS NULL OR can_access_channel(channel_id))
  );

-- ------------------------------------------------------------
-- Mensagens: seguem o canal da conversa. Sem isto o agente não veria a
-- conversa mas leria o conteúdo dela.
-- ------------------------------------------------------------
DROP POLICY IF EXISTS messages_select ON messages;
CREATE POLICY messages_select ON messages
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM conversations c
      WHERE c.id = messages.conversation_id
        AND is_account_member(c.account_id)
        AND (c.channel_id IS NULL OR can_access_channel(c.channel_id))
    )
  );

DROP POLICY IF EXISTS messages_modify ON messages;
CREATE POLICY messages_modify ON messages
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM conversations c
      WHERE c.id = messages.conversation_id
        AND is_account_member(c.account_id, 'agent')
        AND (c.channel_id IS NULL OR can_access_channel(c.channel_id))
    )
  );

-- ------------------------------------------------------------
-- Contatos e negócios.
-- ------------------------------------------------------------
DROP POLICY IF EXISTS contacts_select ON contacts;
CREATE POLICY contacts_select ON contacts
  FOR SELECT USING (
    is_account_member(account_id) AND can_access_contact(id)
  );

DROP POLICY IF EXISTS deals_select ON deals;
CREATE POLICY deals_select ON deals
  FOR SELECT USING (
    is_account_member(account_id) AND can_access_contact(contact_id)
  );

COMMENT ON TABLE channel_members IS
  'Canais que um membro agent/viewer pode ver. owner/admin ignoram esta tabela e veem tudo.';
