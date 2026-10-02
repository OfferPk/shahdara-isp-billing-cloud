export const BRANDING_BUCKET = 'organization-branding';
export const MAX_BRAND_LOGO_BYTES = 1_048_576;

const MIME_TO_EXTENSION = Object.freeze({
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
});
const UUID_SOURCE = '[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const ORGANIZATION_ID = new RegExp(`^${UUID_SOURCE}$`, 'i');
const LOGO_PATH = new RegExp(`^(${UUID_SOURCE})/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\\.(png|jpg|jpeg|webp)$`, 'i');

function startsWith(bytes, values) {
  return values.every((value, index) => bytes[index] === value);
}

function isValidImageSignature(type, bytes) {
  if (type === 'image/png') return startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (type === 'image/jpeg') return startsWith(bytes, [0xff, 0xd8, 0xff]);
  if (type === 'image/webp') {
    return startsWith(bytes, [0x52, 0x49, 0x46, 0x46])
      && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50;
  }
  return false;
}

export async function validateBrandLogoFile(file) {
  if (!file || !Number.isSafeInteger(file.size) || file.size <= 0) {
    throw new Error('Choose a PNG, JPEG, or WebP logo file.');
  }
  if (file.size > MAX_BRAND_LOGO_BYTES) {
    throw new Error('The logo must be 1 MB or smaller.');
  }
  const type = String(file.type ?? '').toLowerCase();
  const extension = MIME_TO_EXTENSION[type];
  if (!extension) throw new Error('Choose a PNG, JPEG, or WebP logo file.');

  const bytes = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  if (!isValidImageSignature(type, bytes)) {
    throw new Error('The file contents do not match a PNG, JPEG, or WebP image.');
  }

  if (typeof globalThis.createImageBitmap === 'function') {
    let bitmap;
    try {
      bitmap = await globalThis.createImageBitmap(file);
    } catch {
      throw new Error('The selected logo is not a readable image.');
    }
    try {
      if (bitmap.width < 1 || bitmap.height < 1 || bitmap.width > 4096 || bitmap.height > 4096
          || bitmap.width * bitmap.height > 16_777_216) {
        throw new Error('Logo dimensions must not exceed 4096 by 4096 pixels.');
      }
    } finally {
      bitmap.close?.();
    }
  }
  return { type, extension };
}

export function isSafeBrandLogoPath(organizationId, logoPath) {
  if (!ORGANIZATION_ID.test(String(organizationId ?? ''))) return false;
  const match = LOGO_PATH.exec(String(logoPath ?? ''));
  return Boolean(match && match[1].toLowerCase() === String(organizationId).toLowerCase());
}

export function buildBrandLogoPath(organizationId, mimeType, objectId = globalThis.crypto?.randomUUID?.()) {
  const extension = MIME_TO_EXTENSION[String(mimeType ?? '').toLowerCase()];
  if (!ORGANIZATION_ID.test(String(organizationId ?? '')) || !extension) {
    throw new Error('A valid organization and PNG, JPEG, or WebP image are required.');
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(objectId ?? ''))) {
    throw new Error('A secure random logo identifier is required.');
  }
  return `${String(organizationId).toLowerCase()}/${String(objectId).toLowerCase()}.${extension}`;
}

export function getPublicBrandLogoUrl(supabase, organizationId, logoPath) {
  if (!isSafeBrandLogoPath(organizationId, logoPath)) return '';
  try {
    const expectedOrigin = new URL(supabase.supabaseUrl).origin;
    const publicUrl = supabase.storage.from(BRANDING_BUCKET).getPublicUrl(logoPath)?.data?.publicUrl;
    const parsed = new URL(publicUrl);
    if (parsed.protocol !== 'https:' || parsed.origin !== expectedOrigin
        || !parsed.pathname.includes(`/storage/v1/object/public/${BRANDING_BUCKET}/`)) return '';
    return parsed.href;
  } catch {
    return '';
  }
}

export function getOrganizationBranding(row, fallbackName = '') {
  return {
    displayName: String(row?.display_name ?? '').trim() || String(fallbackName ?? '').trim() || 'Shahdara Fiber Net',
    logoPath: row?.logo_path ?? null,
    supportPhone: String(row?.support_phone ?? '').trim(),
    address: String(row?.address ?? '').trim(),
  };
}

export function safeSupportPhoneHref(value) {
  const normalized = String(value ?? '').replace(/[\s().-]/g, '');
  return /^\+?\d{5,20}$/.test(normalized) ? `tel:${normalized}` : '';
}
