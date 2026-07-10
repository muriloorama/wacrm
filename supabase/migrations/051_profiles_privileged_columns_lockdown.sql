-- 051_profiles_privileged_columns_lockdown
--
-- CORREÇÃO DE SEGURANÇA (privilege escalation).
--
-- A policy `profiles_update` (017) permite ao usuário editar a PRÓPRIA
-- linha em `profiles`. RLS no Postgres não restringe COLUNAS, então até
-- agora um usuário autenticado conseguia, direto do navegador:
--
--     supabase.from('profiles')
--       .update({ is_super_admin: true })   -- ou account_role: 'owner'
--       .eq('user_id', <meuId>)
--
-- ...e virar super admin (acesso total a /api/admin/*) ou se auto-promover
-- na conta ativa. `is_super_admin` (031) e `account_role`/`account_id`
-- (fonte de autorização lida pelo servidor) ficam nesta mesma tabela.
--
-- Correção: privilégio de UPDATE por COLUNA para o papel `authenticated`.
-- O usuário só pode escrever as colunas self-service (nome/avatar). As
-- colunas sensíveis passam a ser graváveis apenas por:
--   - service_role (clientes admin do servidor — /api/admin/*), e
--   - funções SECURITY DEFINER donas = postgres (switch_account,
--     set_member_role, handle_new_user, etc.),
-- ambos NÃO sujeitos a grants de coluna do `authenticated`.
--
-- Os únicos updates diretos do navegador em profiles são full_name e
-- avatar_url (settings/profile-form). Tudo mais já passa por service_role
-- ou RPC, então este REVOKE não quebra nenhum fluxo legítimo.
-- ============================================================

-- Remove o UPDATE amplo concedido por padrão ao papel authenticated…
REVOKE UPDATE ON public.profiles FROM authenticated;

-- …e devolve apenas as colunas self-service. updated_at incluído para o
-- caso de o client carimbá-lo junto (harmless se houver trigger próprio).
GRANT UPDATE (full_name, avatar_url, updated_at) ON public.profiles TO authenticated;
