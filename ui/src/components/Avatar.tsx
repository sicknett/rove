import type { Profile } from '../state/profiles';

/** A profile's photo, or its initial on its colour with a soft gradient. */
export function Avatar({ profile, size = 36 }: { profile: Pick<Profile, 'name' | 'color'> & Partial<Profile>; size?: number }) {
  if (profile.image) {
    return <img className="avatar avatar--photo" src={profile.image} alt="" draggable={false} style={{ width: size, height: size }} />;
  }
  const initial = profile.name.trim()[0]?.toUpperCase() ?? '?';
  return (
    <span
      className="avatar"
      aria-hidden
      style={{
        width: size,
        height: size,
        fontSize: size * 0.42,
        background: `linear-gradient(145deg, ${profile.color} 0%, color-mix(in oklab, ${profile.color} 55%, #0b0c0d) 100%)`,
      }}
    >
      {initial}
    </span>
  );
}

/** Centre-crops an image file to a square and shrinks it, as a JPEG data URL. */
export async function squarePhoto(file: File, size = 256): Promise<string> {
  if (!file.type.startsWith('image/')) throw new Error('Choose an image file.');
  const bitmap = await createImageBitmap(file);
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, size, size);
  bitmap.close();
  return canvas.toDataURL('image/jpeg', 0.86);
}
