-- ============================================================
-- 044 — Módulos habilitados por conta (feature flags)
--
-- Cada conta pode ter só um subconjunto dos módulos alternáveis
-- (Contatos, Funis, Transmissões, Automações, Fluxos). O super admin
-- controla isso no painel /admin.
--
-- Semântica de NULL (padrão): conta SEM configuração explícita enxerga
-- TODOS os módulos — retrocompatível com as contas já existentes, sem
-- backfill. Quando o super admin salva, grava a lista explícita das
-- CHAVES alternáveis habilitadas (ex.: {contacts,pipelines}). Uma lista
-- vazia {} = nenhum módulo alternável habilitado.
--
-- Módulos "core" (Painel, Caixa de entrada, Notificações, Configurações)
-- NÃO são controlados por esta coluna — estão sempre visíveis.
-- ============================================================

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS enabled_modules text[];

COMMENT ON COLUMN accounts.enabled_modules IS
  'Módulos alternáveis habilitados (chaves: contacts,pipelines,broadcasts,automations,flows). NULL = todos habilitados.';
