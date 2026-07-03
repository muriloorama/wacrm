import React from "react";

// Detecta URLs (http/https e www.) dentro do texto.
const URL_RE = /(https?:\/\/[^\s<]+|www\.[^\s<]+)/gi;
// Pontuação final que não faz parte do link (ex.: "veja http://x.com." — o
// ponto é da frase, não da URL).
const TRAILING_RE = /[.,;:!?)\]}'"»]+$/;

/**
 * Renderiza o texto transformando URLs em links clicáveis (abrem em nova aba).
 * O resto do texto é mantido igual (o <p> pai preserva quebras de linha).
 */
export function LinkifiedText({ text }: { text: string }) {
  if (!text) return null;

  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let key = 0;
  let match: RegExpExecArray | null;
  URL_RE.lastIndex = 0;

  while ((match = URL_RE.exec(text)) !== null) {
    const raw = match[0];
    const start = match.index;

    // Separa a pontuação final que não pertence à URL.
    const trailing = raw.match(TRAILING_RE)?.[0] ?? "";
    const url = trailing ? raw.slice(0, raw.length - trailing.length) : raw;
    const href = url.startsWith("www.") ? `https://${url}` : url;

    if (start > lastIndex) parts.push(text.slice(lastIndex, start));
    parts.push(
      <a
        key={key++}
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="break-all underline underline-offset-2 hover:opacity-80"
      >
        {url}
      </a>,
    );
    if (trailing) parts.push(trailing);

    lastIndex = start + raw.length;
  }

  if (lastIndex < text.length) parts.push(text.slice(lastIndex));

  return <>{parts}</>;
}
