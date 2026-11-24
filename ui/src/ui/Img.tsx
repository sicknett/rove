import { useEffect, useState } from 'react';

interface Props extends Omit<React.ImgHTMLAttributes<HTMLImageElement>, 'src'> {
  src?: string | null;
  /** Shown when there is no image or it fails to load. */
  fallback?: React.ReactNode;
}

/** An image that fades in once decoded and falls back quietly when missing or broken. */
export function Img({ src, fallback = null, className = '', alt = '', ...rest }: Props) {
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>(src ? 'loading' : 'failed');
  useEffect(() => setState(src ? 'loading' : 'failed'), [src]);
  if (!src || state === 'failed') return <>{fallback}</>;
  return (
    <img
      {...rest}
      src={src}
      alt={alt}
      draggable={false}
      decoding="async"
      loading={rest.loading ?? 'lazy'}
      className={`img ${state === 'ready' ? 'is-ready' : ''} ${className}`}
      onLoad={() => setState('ready')}
      onError={() => setState('failed')}
    />
  );
}
