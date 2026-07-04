-- ============================================================
-- 046 — Nota única por contato
--
-- Antes: `contact_notes` guardava VÁRIAS notas por contato (log com
-- timestamp). O produto passou a querer UMA nota editável por contato.
-- Adiciona `contacts.notes` (texto livre único) e migra a nota MAIS
-- RECENTE de cada contato para lá. A tabela contact_notes é mantida
-- (histórico), mas a UI passa a ler/gravar `contacts.notes`.
-- ============================================================

ALTER TABLE contacts ADD COLUMN IF NOT EXISTS notes text;

COMMENT ON COLUMN contacts.notes IS 'Nota única editável do contato (texto livre).';

UPDATE contacts c SET notes = sub.note_text
FROM (
  SELECT DISTINCT ON (contact_id) contact_id, note_text
  FROM contact_notes
  ORDER BY contact_id, created_at DESC
) sub
WHERE sub.contact_id = c.id AND (c.notes IS NULL OR c.notes = '');
