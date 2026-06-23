import type { CompanyAddressLookupResult } from '@/lib/services/company-address-lookup';
import { normalizeCompanyWebsite } from '@/lib/services/company-address-lookup';
import type { AccountEnrichment, AccountSnapshot } from '@/lib/customer-account-enrich';
import { buildAccountEnrichment } from '@/lib/customer-account-enrich';
import type { CustomerDocumentExtractResult } from '@/lib/customer-document-extract';

const FREE_EMAIL_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'yahoo.com',
  'hotmail.com',
  'outlook.com',
  'live.com',
  'icloud.com',
  'aol.com',
  'msn.com',
  'protonmail.com',
  'me.com',
  'mail.com',
]);

function primaryContactEmail(account: AccountSnapshot): string | undefined {
  const primary = account.contacts.find((c) => c.isPrimary) ?? account.contacts[0];
  return primary?.email?.trim() || undefined;
}

/** Infer a company website from account website, document extract, or business email domain. */
export function mergeAccountSnapshot(
  account: AccountSnapshot,
  updates: AccountEnrichment,
): AccountSnapshot {
  let contacts = [...account.contacts];
  if (updates.contactUpsert) {
    const idx = contacts.findIndex((ct) => ct.id === updates.contactUpsert!.id);
    if (idx >= 0) contacts[idx] = updates.contactUpsert;
    else contacts.push(updates.contactUpsert);
  }

  let locations = [...account.locations];
  if (updates.locationPatch) {
    const idx = locations.findIndex((loc) => loc.id === updates.locationPatch!.id);
    if (idx >= 0) {
      locations[idx] = { ...locations[idx], ...updates.locationPatch.patch };
    }
  }

  return { ...account, ...updates.customerPatch, contacts, locations };
}

export function resolveLookupWebsite(
  account: AccountSnapshot,
  hints?: { website?: string; contactEmail?: string },
): string | null {
  const candidates = [
    hints?.website,
    account.website,
    domainWebsiteFromEmail(hints?.contactEmail),
    domainWebsiteFromEmail(primaryContactEmail(account)),
  ];

  for (const raw of candidates) {
    if (!raw?.trim()) continue;
    const normalized = normalizeCompanyWebsite(
      raw.includes('://') || raw.startsWith('www.') ? raw : `https://${raw.replace(/^www\./, '')}`,
    );
    if (normalized) return normalized;
  }
  return null;
}

export function domainWebsiteFromEmail(email?: string): string | null {
  if (!email?.includes('@')) return null;
  const domain = email.split('@')[1]?.trim().toLowerCase();
  if (!domain || FREE_EMAIL_DOMAINS.has(domain) || !domain.includes('.')) return null;
  return domain;
}

export function buildEnrichmentFromWebsiteLookup(
  account: AccountSnapshot,
  lookup: CompanyAddressLookupResult,
  lookupOrigin: string,
): AccountEnrichment {
  const profile: CustomerDocumentExtractResult = {
    street: lookup.street,
    city: lookup.city,
    state: lookup.state,
    zip: lookup.zip,
    industry: lookup.industry,
    mccCode: lookup.mccCode,
    companyLegalName: lookup.companyName,
    website: lookupOrigin,
    contactPhone: lookup.phone,
    source: 'ai',
  };

  const enrichment = buildAccountEnrichment(account, profile);

  if (lookup.description && !account.companyDescription?.trim()) {
    enrichment.customerPatch.companyDescription = lookup.description.slice(0, 240);
  }

  if (lookup.phone) {
    const primary = account.contacts.find((c) => c.isPrimary) ?? account.contacts[0];
    const target = enrichment.contactUpsert ?? primary;
    if (target && !target.phone?.trim()) {
      enrichment.contactUpsert = { ...target, phone: lookup.phone };
    } else if (!target && account.contacts.length === 0) {
      enrichment.contactUpsert = {
        id: `id-${Math.random().toString(36).slice(2, 10)}`,
        name: 'Main contact',
        role: 'Contact',
        email: primaryContactEmail(account) ?? '',
        phone: lookup.phone,
        isPrimary: true,
        locationIds: account.locations[0] ? [account.locations[0].id] : [],
      };
    }
  }

  if (!account.website?.trim() && lookupOrigin) {
    enrichment.customerPatch.website = lookupOrigin.replace(/^https?:\/\//, '');
  }

  return enrichment;
}

export async function fetchWebsiteEnrichment(
  website: string,
): Promise<CompanyAddressLookupResult | null> {
  const res = await fetch('/api/company-address-lookup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ website }),
  });
  if (!res.ok) return null;
  const lookup = (await res.json()) as CompanyAddressLookupResult;
  if (lookup.source === 'none') return null;
  return lookup;
}
