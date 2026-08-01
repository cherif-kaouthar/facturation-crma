import React from 'react';

/**
 * The built-in mark: a wheat stalk between two figures. Used wherever no logo
 * has been uploaded in Réglages, and drawn with currentColor so it sits equally
 * well on the pine header and on the white invoice sheet.
 */
export function AppMark({ className = 'h-10 w-10' }: { className?: string }) {
  return (
    <svg viewBox="0 0 500 500" className={className} role="img" aria-label="Logo" fill="currentColor">
      <path d="M 245 160 h 10 v 210 h -10 Z" />
      <path d="M 250 45 c -8 20 -8 35 0 55 c 8 -20 8 -35 0 -55 Z" />
      {[105, 140, 175, 210, 245].map((y) => (
        <React.Fragment key={y}>
          <path d={`M 255 ${y} L 300 ${y - 25} L 290 ${y + 10} L 255 ${y + 25} Z`} />
          <path d={`M 245 ${y} L 200 ${y - 25} L 210 ${y + 10} L 245 ${y + 25} Z`} />
        </React.Fragment>
      ))}
      <circle cx="165" cy="215" r="38" />
      <path d="M 80 265 L 140 265 L 145 190 L 215 190 L 215 295 L 195 295 L 195 425 L 150 425 L 150 350 L 130 350 L 130 425 L 85 425 L 115 295 L 80 295 Z" />
      <circle cx="335" cy="215" r="38" />
      <path d="M 420 265 L 360 265 L 355 190 L 285 190 L 285 295 L 305 295 L 305 425 L 350 425 L 350 350 L 370 350 L 370 425 L 415 425 L 385 295 L 420 295 Z" />
    </svg>
  );
}

/**
 * Renders the uploaded logo, falling back to the built-in mark. `tone` picks
 * the fallback's colour so the same component works on dark and light chrome.
 */
export function BrandLogo({
  logo,
  className = 'h-10 w-10',
  tone = 'pine',
  alt = 'Logo',
  objectFit = 'cover',
}: {
  logo?: string;
  className?: string;
  tone?: 'pine' | 'light';
  alt?: string;
  objectFit?: 'cover' | 'contain';
}) {
  if (logo) {
    return <img src={logo} alt={alt} className={`${className} ${objectFit === 'cover' ? 'object-cover' : 'object-contain'}`} />;
  }
  return <AppMark className={`${className} ${tone === 'light' ? 'text-white' : 'text-pine'}`} />;
}
