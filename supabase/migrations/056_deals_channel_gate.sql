-- ============================================================
-- 056 — Kanban por caixa de entrada.
--
-- Problema: no Kanban (rota /pipelines) o agente via TODOS os
-- negócios. A policy anterior (048) filtrava deals por
-- can_access_contact, mas a maioria dos cards são de contatos SEM
-- conversa num canal (lead de formulário, importado, Meta, criado à
-- mão) — e para esses can_access_contact devolve TRUE para todos.
--
-- Solução: dar ao próprio negócio uma caixa (`deals.channel_id`) e
-- filtrar por ela, igual ao Inbox.
--
-- Regra de acesso adotada (decisão do produto):
--   - owner/admin  → veem TODOS os negócios da conta;
--   - agent/viewer → veem apenas negócios cuja caixa está atribuída
--     a eles em `channel_members`;
--   - negócio SEM caixa (channel_id NULL) → visível apenas a
--     owner/admin. Agente não vê negócio sem caixa (deny-by-default).
-- ============================================================

-- ------------------------------------------------------------
-- Coluna de caixa no negócio.
-- ON DELETE SET NULL: se a caixa for removida, o negócio não some;
-- vira "sem caixa" (visível só a admin, que pode reatribuir).
-- ------------------------------------------------------------
ALTER TABLE deals
  ADD COLUMN IF NOT EXISTS channel_id UUID
  REFERENCES whatsapp_channels(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_deals_channel ON deals(channel_id);

-- ------------------------------------------------------------
-- Backfill dos negócios existentes.
-- ------------------------------------------------------------

-- 1) A partir da conversa vinculada ao próprio negócio, quando houver.
UPDATE deals d
SET channel_id = c.channel_id
FROM conversations c
WHERE d.conversation_id = c.id
  AND c.channel_id IS NOT NULL
  AND d.channel_id IS NULL;

-- 2) A partir da conversa mais recente do contato do negócio (a que
--    tem canal). Cobre os cards criados de dentro de uma conversa.
UPDATE deals d
SET channel_id = sub.channel_id
FROM (
  SELECT DISTINCT ON (v.contact_id) v.contact_id, v.channel_id
  FROM conversations v
  WHERE v.channel_id IS NOT NULL
  ORDER BY v.contact_id, v.last_message_at DESC NULLS LAST
) sub
WHERE d.contact_id = sub.contact_id
  AND d.channel_id IS NULL;

-- Os negócios que sobrarem com channel_id NULL são os "sem caixa"
-- (formulário/importados/manuais) — visíveis só a admin, como decidido.

-- ------------------------------------------------------------
-- Deriva a caixa automaticamente ao criar um negócio, quando o app
-- não informa channel_id explicitamente. Assim os cards criados no
-- Inbox (contact-sidebar, conversation-list) já nascem com a caixa
-- certa sem precisar mudar cada ponto de inserção.
--
-- Só roda no INSERT: no UPDATE respeitamos o que o admin escolheu no
-- formulário (inclusive deixar "sem caixa").
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.deals_derive_channel()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.channel_id IS NULL THEN
    -- (a) conversa vinculada ao negócio
    IF NEW.conversation_id IS NOT NULL THEN
      SELECT c.channel_id INTO NEW.channel_id
      FROM conversations c
      WHERE c.id = NEW.conversation_id;
    END IF;

    -- (b) conversa mais recente do contato, com canal
    IF NEW.channel_id IS NULL AND NEW.contact_id IS NOT NULL THEN
      SELECT v.channel_id INTO NEW.channel_id
      FROM conversations v
      WHERE v.contact_id = NEW.contact_id
        AND v.channel_id IS NOT NULL
      ORDER BY v.last_message_at DESC NULLS LAST
      LIMIT 1;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS deals_derive_channel_trg ON deals;
CREATE TRIGGER deals_derive_channel_trg
  BEFORE INSERT ON deals
  FOR EACH ROW
  EXECUTE FUNCTION public.deals_derive_channel();

-- ------------------------------------------------------------
-- Nova policy de leitura: filtro por caixa.
--   admin/owner → tudo;
--   agent/viewer → só a caixa atribuída;
--   sem caixa → só admin.
-- ------------------------------------------------------------
DROP POLICY IF EXISTS deals_select ON deals;
CREATE POLICY deals_select ON deals
  FOR SELECT USING (
    is_account_member(account_id)
    AND (
      is_account_member(account_id, 'admin')
      OR (channel_id IS NOT NULL AND can_access_channel(channel_id))
    )
  );

COMMENT ON COLUMN deals.channel_id IS
  'Caixa (canal) do negócio. Controla quem vê o card no Kanban: '
  'admin vê tudo; agent/viewer só a caixa atribuída; NULL = só admin.';
