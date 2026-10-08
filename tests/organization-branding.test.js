import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBrandLogoPath, getOrganizationBranding, getPublicBrandLogoUrl, isSafeBrandLogoPath, safeSupportPhoneHref, validateBrandLogoFile } from '../src/organization-branding.js';
import { renderPrintableBillHtml } from '../src/customer-documents.js';
import { renderPrintableReceiptHtml } from '../src/admin-bills.js';
import { formatMoney } from '../src/ledger.js';

const organizationId = '50000000-0000-4000-8000-000000000001';
const otherOrganizationId = '50000000-0000-4000-8000-000000000002';
const imageHeaders = {
  'image/png': [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  'image/jpeg': [0xff, 0xd8, 0xff, 0xdb],
  'image/webp': [0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50],
};

function imageFile(type, header, size = 64) {
  const bytes = new Uint8Array(header);
  return {
    type,
    size,
    slice(start, end) { return new Blob([bytes.slice(start, end)]); },
  };
}

test('branding accepts only matching PNG/JPEG/WebP signatures within the size cap', async () => {
  for (const [type, header] of Object.entries(imageHeaders)) {
    const result = await validateBrandLogoFile(imageFile(type, header));
    assert.equal(result.type, type);
  }
  await assert.rejects(validateBrandLogoFile(imageFile('image/png', imageHeaders['image/png'], 1_048_577)), /1 MB or smaller/);
  await assert.rejects(validateBrandLogoFile(imageFile('image/svg+xml', [0x3c, 0x73, 0x76, 0x67])), /PNG, JPEG, or WebP/);
  await assert.rejects(validateBrandLogoFile(imageFile('image/png', [0x3c, 0x68, 0x74, 0x6d])), /contents do not match/);
});

test('logo object paths are generated and validated inside exactly one organization folder', () => {
  const fileId = '60000000-0000-4000-8000-000000000001';
  const validPath = buildBrandLogoPath(organizationId, 'image/jpeg', fileId);
  assert.equal(validPath, `${organizationId}/${fileId}.jpg`);
  assert.equal(isSafeBrandLogoPath(organizationId, validPath), true);
  assert.equal(isSafeBrandLogoPath(otherOrganizationId, validPath), false);
  assert.equal(isSafeBrandLogoPath(organizationId, `${organizationId}/${fileId}.svg`), false);
  assert.equal(isSafeBrandLogoPath(organizationId, `https://example.invalid/${fileId}.png`), false);
  assert.equal(isSafeBrandLogoPath(organizationId, `${organizationId}/../${fileId}.png`), false);
  assert.throws(() => buildBrandLogoPath(organizationId, 'image/svg+xml', fileId), /PNG, JPEG, or WebP/);
});

test('public logo URL is derived from the configured project only; support phone links are restricted', () => {
  const path = `${organizationId}/60000000-0000-4000-8000-000000000001.png`;
  const client = {
    supabaseUrl: 'https://qkdsuvmlutkatcqoewkh.supabase.co',
    storage: { from(bucket) { return { getPublicUrl(logoPath) { return { data: { publicUrl: `${client.supabaseUrl}/storage/v1/object/public/${bucket}/${logoPath}` } }; } }; } },
  };
  assert.equal(getPublicBrandLogoUrl(client, organizationId, path), `${client.supabaseUrl}/storage/v1/object/public/organization-branding/${path}`);
  assert.equal(getPublicBrandLogoUrl(client, otherOrganizationId, path), '');
  assert.equal(safeSupportPhoneHref('+92 (300) 555-0101'), 'tel:+923005550101');
  assert.equal(safeSupportPhoneHref('javascript:alert(1)'), '');
});

test('public brand defaults are separate from customer-private fields', () => {
  assert.deepEqual(getOrganizationBranding(null, 'Canonical ISP'), {
    displayName: 'Canonical ISP', logoPath: null, supportPhone: '', address: '',
  });
});

test('printable bill escapes user-facing values and restricts its logo to the approved project origin', () => {
  const maliciousName = '<img src=x onerror=alert(1)>';
  const printed = renderPrintableBillHtml({
    bill: { id: 'synthetic-bill-1', invoice_number: 'SIF-202610-4', period: '2026-10-01', due_date: '2026-10-15', amount_due_cents: 10000, plan_snapshot: '<script>bad</script>' },
    customer: { name: maliciousName, customer_number: 4, pppoe_username: 'amina-10m' },
    summary: { status: 'unpaid', receiptCashCents: 0, creditAppliedCents: 0, balanceCents: 10000 },
    branding: {
      displayName: '<b>Globe Expert</b>',
      logoUrl: 'https://evil.example/logo.png',
      supportPhone: '<svg onload=bad>',
      address: '1 & <Main Street>',
    },
    projectUrl: 'https://qkdsuvmlutkatcqoewkh.supabase.co',
    formatMoney,
    t: (value) => value,
  });
  assert.match(printed, /&lt;b&gt;Globe Expert&lt;\/b&gt;/);
  assert.match(printed, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(printed, /&lt;script&gt;bad&lt;\/script&gt;/);
  assert.match(printed, /&lt;svg onload=bad&gt;/);
  assert.match(printed, /1 &amp; &lt;Main Street&gt;/);
  assert.match(printed, /Invoice No\. SIF-202610-4/);
  assert.match(printed, /PPPoE Username/);
  assert.match(printed, /amina-10m/);
  assert.match(printed, /2026-10-15/);
  assert.match(printed, /Total Amount/);
  assert.doesNotMatch(printed, /evil\.example|<script>|<img src=x/);
  assert.doesNotMatch(printed, /customer phone|staff_notes|private_details/i);
});

test('printable receipts escape public company contact data and never load arbitrary logo URLs', () => {
  const projectUrl = 'https://qkdsuvmlutkatcqoewkh.supabase.co';
  const logoUrl = `${projectUrl}/storage/v1/object/public/organization-branding/${organizationId}/60000000-0000-4000-8000-000000000001.png`;
  const options = {
    receipt: { id: 'synthetic-receipt', received_on: '2026-10-02', amount_cents: 5000, method: 'Cash' },
    customer: { name: 'Synthetic Customer' },
    bill: { period: '2026-10-01' },
    organizationName: 'Canonical ISP',
    branding: { displayName: '<em>Globe</em>', logoUrl, supportPhone: '+92 300 5550101', address: '1 & <Main Street>' },
    projectUrl,
    formatMoney,
    t: (value) => value,
  };
  const printed = renderPrintableReceiptHtml(options);
  assert.match(printed, /&lt;em&gt;Globe&lt;\/em&gt;/);
  assert.match(printed, /<img class="receipt__logo" src="https:\/\/qkdsuvmlutkatcqoewkh\.supabase\.co\/storage\/v1\/object\/public\/organization-branding\//);
  assert.match(printed, /\+92 300 5550101/);
  assert.match(printed, /1 &amp; &lt;Main Street&gt;/);
  assert.doesNotMatch(printed, /customer_private_details|staff_notes|private phone/i);
  const remote = renderPrintableReceiptHtml({
    ...options,
    branding: { ...options.branding, logoUrl: 'https://evil.example/logo.png' },
  });
  assert.doesNotMatch(remote, /evil\.example|<img class="receipt__logo"/);
});
