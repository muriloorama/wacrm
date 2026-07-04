-- 043_member_is_attendant
-- Marca quais membros ATENDEM (podem receber conversas atribuídas). Muitos
-- membros são gestores/admins que não atendem — só os marcados aparecem no
-- seletor "Atribuir" do inbox. Default TRUE (comportamento atual); admins
-- desmarcam quem não atende.
ALTER TABLE account_members
  ADD COLUMN IF NOT EXISTS is_attendant BOOLEAN NOT NULL DEFAULT true;
