import { cn } from "@/lib/utils";

/**
 * Logo da marca "Super CRM".
 *
 * Renderiza as duas versões do banner e alterna por tema via CSS
 * (`html[data-mode]` — ver globals.css): logo colorido no tema claro,
 * logo branco no tema escuro. Passe a altura por `className` (ex.: "h-8");
 * a largura é automática para preservar a proporção.
 */
export function BrandLogo({ className }: { className?: string }) {
  return (
    <>
      <img
        src="/logo-super-crm.png"
        alt="Super CRM"
        className={cn("brand-logo-light w-auto object-contain", className)}
      />
      <img
        src="/logo-super-crm-white.png"
        alt="Super CRM"
        className={cn("brand-logo-dark w-auto object-contain", className)}
      />
    </>
  );
}
