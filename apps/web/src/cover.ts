import {
  MAX_COVER_IMAGE_BYTES,
  type CoverAlignment,
  type CoverComposition,
  type CoverContrastPanel,
  type CoverCrop,
  type CoverImage,
  type CoverLayout,
  type CoverTextColor,
} from '@wordconvert/cover-generator';

export type CoverSource = 'none' | 'upload' | 'extracted' | 'generated';

export interface CoverSettings {
  source: CoverSource;
  layout: CoverLayout;
  alignment: CoverAlignment;
  titlePosition: number;
  authorPosition: number;
  titleSize: number;
  authorSize: number;
  textColor: CoverTextColor;
  contrastPanel: CoverContrastPanel;
  panelOpacity: number;
  imageOpacity: number;
  margin: number;
  crop: CoverCrop;
  aspectRatio: 'book' | 'square';
  image?: CoverImage;
  imageName?: string;
  warning?: string;
}

export interface CoverMetadata {
  title: string;
  subtitle?: string;
  authors: readonly string[];
}

export interface CoverFileDescriptor {
  name: string;
  type: string;
  size: number;
}

export function createCoverSettings(): CoverSettings {
  return {
    source: 'none',
    layout: 'image-only',
    alignment: 'center',
    titlePosition: 18,
    authorPosition: 86,
    titleSize: 112,
    authorSize: 54,
    textColor: 'light',
    contrastPanel: 'dark',
    panelOpacity: 0.56,
    imageOpacity: 1,
    margin: 8,
    crop: 'cover',
    aspectRatio: 'book',
  };
}

export function coverComposition(
  settings: CoverSettings,
  metadata: CoverMetadata,
): CoverComposition | undefined {
  if (settings.source === 'none') return undefined;
  if (
    (settings.source === 'upload' || settings.source === 'extracted') &&
    !settings.image
  )
    return undefined;
  const width = 1600;
  const height = settings.aspectRatio === 'square' ? 1600 : 2560;
  return {
    width,
    height,
    layout: settings.source === 'generated' ? 'typographic' : settings.layout,
    title: metadata.title,
    ...(metadata.subtitle ? { subtitle: metadata.subtitle } : {}),
    authors: metadata.authors,
    alignment: settings.alignment,
    titlePosition: settings.titlePosition,
    authorPosition: settings.authorPosition,
    titleSize: settings.titleSize,
    authorSize: settings.authorSize,
    textColor: settings.textColor,
    contrastPanel: settings.contrastPanel,
    panelOpacity: settings.panelOpacity,
    imageOpacity: settings.imageOpacity,
    margin: settings.margin,
    crop: settings.crop,
    ...(settings.image ? { image: settings.image } : {}),
  };
}

export function validateCoverFile(
  file: CoverFileDescriptor,
): string | undefined {
  if (
    !['image/jpeg', 'image/png', 'image/webp', 'image/svg+xml'].includes(
      file.type,
    )
  )
    return 'Choose a JPEG, PNG, WebP, or SVG cover image.';
  if (file.size > MAX_COVER_IMAGE_BYTES)
    return 'Cover images must be no larger than 10 MiB.';
  return undefined;
}
