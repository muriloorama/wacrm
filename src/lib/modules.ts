// ============================================================
// Módulos alternáveis por conta (feature flags)
//
// O super admin pode habilitar/desabilitar estes módulos por conta no
// painel /admin. Módulos "core" (Painel, Caixa de entrada, Notificações,
// Configurações) não aparecem aqui — estão sempre visíveis.
//
// A fonte da verdade da configuração é `accounts.enabled_modules`
// (migration 044): NULL = todos habilitados; array = só as chaves
// listadas. Ver `isModuleEnabled` para a semântica completa.
// ============================================================

export const TOGGLEABLE_MODULES = [
  { key: "contacts", href: "/contacts", label: "Contatos" },
  { key: "pipelines", href: "/pipelines", label: "Funis" },
  { key: "broadcasts", href: "/broadcasts", label: "Transmissões" },
  { key: "automations", href: "/automations", label: "Automações" },
  { key: "flows", href: "/flows", label: "Fluxos" },
] as const;

export type ModuleKey = (typeof TOGGLEABLE_MODULES)[number]["key"];

const MODULE_KEYS = new Set<string>(TOGGLEABLE_MODULES.map((m) => m.key));

/** Chaves válidas (para saneamento no back). */
export function isValidModuleKey(key: unknown): key is ModuleKey {
  return typeof key === "string" && MODULE_KEYS.has(key);
}

/**
 * Um caminho (href) está habilitado para uma conta?
 *
 * - Se o href não pertence a nenhum módulo alternável → sempre `true`
 *   (rotas core como /dashboard, /inbox, /settings).
 * - `enabled == null` → conta sem configuração → tudo habilitado.
 * - Caso contrário → só habilitado se a chave do módulo estiver na lista.
 *
 * Casa tanto a rota exata quanto sub-rotas (ex.: /pipelines/123).
 */
export function isModuleEnabled(
  href: string,
  enabled: readonly string[] | null | undefined,
): boolean {
  const mod = TOGGLEABLE_MODULES.find(
    (m) => href === m.href || href.startsWith(`${m.href}/`),
  );
  if (!mod) return true; // rota core / não alternável
  if (enabled == null) return true; // sem configuração → tudo liberado
  return enabled.includes(mod.key);
}
