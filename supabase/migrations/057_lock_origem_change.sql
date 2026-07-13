-- ============================================================
-- 057 — Trava de alteração da ORIGEM por agentes.
--
-- Regra (decisão do produto):
--   - Contato SEM origem → qualquer membro (agent+) pode definir uma.
--   - Contato que JÁ TEM origem → só owner/admin pode trocar (ou limpar).
--     Agente/viewer não consegue mais alterar.
--
-- A origem do formulário já é gravada em src/lib/api/v1/leads.ts apenas
-- quando estava NULL ("o primeiro sinal vence"), então leads de
-- formulário nascem com origem='formulario' e ficam travados para o
-- agente por esta regra.
--
-- Como as automações e a ingestão de leads (Meta/site) rodam com
-- service-role (auth.uid() = NULL), elas passam livres — a trava vale
-- apenas para usuários autenticados que não sejam admin.
-- ============================================================

CREATE OR REPLACE FUNCTION public.enforce_origem_lock()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $$
BEGIN
  IF OLD.origem IS NOT NULL
     AND NEW.origem IS DISTINCT FROM OLD.origem
     AND auth.uid() IS NOT NULL                       -- service-role/servidor passa
     AND NOT is_account_member(OLD.account_id, 'admin') -- owner/admin passam
  THEN
    RAISE EXCEPTION 'Somente admin pode alterar a origem já definida de um contato'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_origem_lock_trg ON contacts;
CREATE TRIGGER enforce_origem_lock_trg
  BEFORE UPDATE OF origem ON contacts
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_origem_lock();

COMMENT ON FUNCTION public.enforce_origem_lock() IS
  'Impede agent/viewer de trocar/limpar a origem de um contato que já '
  'tem origem. Só quando origem está NULL o agente pode defini-la. '
  'owner/admin e service-role passam livres.';
