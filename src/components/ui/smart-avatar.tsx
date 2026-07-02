"use client";

import { useState } from "react";

interface SmartAvatarProps {
  /** URL da foto; pode estar quebrada/expirada. */
  src?: string | null;
  alt: string;
  /** Conteúdo mostrado quando não há foto OU quando a foto falha (inicial). */
  fallback: React.ReactNode;
  /** Classe aplicada ao <img> (tamanho/rounded/object-cover). */
  className?: string;
}

/**
 * Avatar que cai automaticamente para a inicial quando a imagem falha ao
 * carregar (foto quebrada/expirada) — em vez de mostrar o ícone de imagem
 * quebrada. Deve ser usado DENTRO do container redondo já existente.
 *
 * Rastreamos a URL que falhou (não um boolean) para que, ao trocar de
 * contato/foto, uma nova `src` volte a tentar carregar sozinha.
 */
export function SmartAvatar({ src, alt, fallback, className }: SmartAvatarProps) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);

  if (src && failedSrc !== src) {
    return (
      <img
        src={src}
        alt={alt}
        onError={() => setFailedSrc(src)}
        className={className}
      />
    );
  }

  return <>{fallback}</>;
}
