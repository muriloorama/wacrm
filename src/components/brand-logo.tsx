import { cn } from "@/lib/utils";

const DEFAULT_LIGHT = "/logo-super-crm.png";
const DEFAULT_DARK = "/logo-super-crm-white.png";

/**
 * Logo da marca. White-label: cada conta pode ter seu próprio logo
 * (`lightSrc`/`darkSrc`); sem eles, cai no padrão do Super CRM.
 *
 * Renderiza as duas variantes e alterna por tema via CSS
 * (`html[data-mode]` — ver globals.css): variante clara no tema claro,
 * variante escura no tema escuro. Passe a altura por `className` (ex.:
 * "h-8"); a largura é automática para preservar a proporção.
 *
 * Nas páginas de auth (login/signup/join) não há conta no contexto, então
 * usam o padrão. Só a sidebar do dashboard passa o logo da conta ativa.
 */
export function BrandLogo({
  className,
  lightSrc,
  darkSrc,
}: {
  className?: string;
  lightSrc?: string | null;
  darkSrc?: string | null;
}) {
  const light = lightSrc || DEFAULT_LIGHT;
  const dark = darkSrc || DEFAULT_DARK;
  return (
    <>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={light}
        alt="Logo"
        className={cn("brand-logo-light w-auto object-contain", className)}
      />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={dark}
        alt="Logo"
        className={cn("brand-logo-dark w-auto object-contain", className)}
      />
    </>
  );
}
