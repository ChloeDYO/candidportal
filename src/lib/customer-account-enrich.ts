import type { ContractDocumentExtractResult } from '@/lib/contract-document-extract';
import type { CustomerDocumentExtractResult } from '@/lib/customer-document-extract';

export type AccountContactShape = {
  id: string;
  name: string;
  role: string;
  email: string;
  phone: string;
  isPrimary: boolean;
  locationIds?: string[];
};

export type AccountLocationShape = {
  id: string;
  label: string;
  street: string;
  city: string;
  state: string;
  zip: string;
  isPrimary: boolean;
};

export type AccountSnapshot = {
  company: string;
  companyLegal?: string;
  website?: string;
  taxId?: string;
  industry?: string;
  description?: string;
  companyDescription?: string;
  mccCode?: string;
  corpType?: string;
  dateSigned?: string;
  contacts: AccountContactShape[];
  locations: AccountLocationShape[];
};

export type AccountEnrichment = {
  customerPatch: Partial<
    Pick<
      AccountSnapshot,
      | 'companyLegal'
      | 'website'
      | 'taxId'
      | 'industry'
      | 'description'
      | 'companyDescription'
      | 'mccCode'
      | 'corpType'
      | 'dateSigned'
    >
  >;
  contactUpsert?: AccountContactShape;
  locationPatch?: { id: string; patch: Partial<AccountLocationShape> };
};

function isBlank(value?: string | null): boolean {
  return !value?.trim();
}

function pickIfMissing(current: string | undefined, next?: string): string | undefined {
  if (!next?.trim() || !isBlank(current)) return undefined;
  return next.trim();
}

function primaryContact(contacts: AccountContactShape[]): AccountContactShape | undefined {
  return contacts.find((c) => c.isPrimary) ?? contacts[0];
}

function primaryLocation(locations: AccountLocationShape[]): AccountLocationShape | undefined {
  return locations.find((l) => l.isPrimary) ?? locations[0];
}

function contactMatches(
  contact: AccountContactShape,
  name?: string,
  email?: string,
): boolean {
  const emailMatch =
    email &&
    contact.email.trim().toLowerCase() === email.trim().toLowerCase();
  const nameMatch =
    name &&
    contact.name.trim().toLowerCase() === name.trim().toLowerCase();
  return Boolean(emailMatch || nameMatch);
}

/** Fill only missing customer, contact, and primary-location fields from document extract. */
export function buildAccountEnrichment(
  account: AccountSnapshot,
  profile: CustomerDocumentExtractResult,
  contract?: ContractDocumentExtractResult,
): AccountEnrichment {
  const customerPatch: AccountEnrichment['customerPatch'] = {};

  const legal = pickIfMissing(account.companyLegal, profile.companyLegalName ?? profile.companyName);
  if (legal) customerPatch.companyLegal = legal;
  const website = pickIfMissing(account.website, profile.website);
  if (website) customerPatch.website = website;
  const taxId = pickIfMissing(account.taxId, profile.ein);
  if (taxId) customerPatch.taxId = taxId;
  const industry = pickIfMissing(account.industry, profile.industry);
  if (industry) customerPatch.industry = industry;
  const description = pickIfMissing(account.description, profile.description);
  if (description) customerPatch.description = description;
  const mccCode = pickIfMissing(account.mccCode, profile.mccCode);
  if (mccCode) customerPatch.mccCode = mccCode;
  const corpType = pickIfMissing(account.corpType, profile.corpType);
  if (corpType) customerPatch.corpType = corpType;

  const signedDate = pickIfMissing(
    account.dateSigned,
    profile.dateSigned ?? contract?.dateSigned ?? contract?.contractStartDate,
  );
  if (signedDate) customerPatch.dateSigned = signedDate;

  let contactUpsert: AccountContactShape | undefined;
  const signerName =
    profile.contactName?.trim() ||
    contract?.signerName?.trim() ||
    contract?.agentOfRecord?.trim();
  const signerEmail = profile.contactEmail?.trim();
  const signerPhone = profile.contactPhone?.trim();
  const signerRole = profile.contactRole?.trim();

  if (signerName || signerEmail || signerPhone) {
    const primary = primaryContact(account.contacts);
    const matched =
      account.contacts.find((c) => contactMatches(c, signerName, signerEmail)) ?? primary;

    if (matched) {
      const patch: Partial<AccountContactShape> = {};
      const name = pickIfMissing(matched.name, signerName);
      if (name) patch.name = name;
      const role = pickIfMissing(matched.role, signerRole || (signerName ? 'Signer' : undefined));
      if (role) patch.role = role;
      const email = pickIfMissing(matched.email, signerEmail);
      if (email) patch.email = email;
      const phone = pickIfMissing(matched.phone, signerPhone);
      if (phone) patch.phone = phone;

      if (Object.keys(patch).length) {
        contactUpsert = { ...matched, ...patch };
      }
    } else if (signerName || signerEmail) {
      const primaryLoc = primaryLocation(account.locations);
      contactUpsert = {
        id: `id-${Math.random().toString(36).slice(2, 10)}`,
        name: signerName || 'Document contact',
        role: signerRole || 'Signer',
        email: signerEmail || '',
        phone: signerPhone || '',
        isPrimary: account.contacts.length === 0,
        locationIds: primaryLoc ? [primaryLoc.id] : [],
      };
    }
  }

  let locationPatch: AccountEnrichment['locationPatch'];
  const loc = primaryLocation(account.locations);
  if (loc && (profile.street || profile.city || profile.state || profile.zip)) {
    const patch: Partial<AccountLocationShape> = {};
    const street = pickIfMissing(loc.street, profile.street);
    if (street) patch.street = street;
    const city = pickIfMissing(loc.city, profile.city);
    if (city) patch.city = city;
    const state = pickIfMissing(loc.state, profile.state);
    if (state) patch.state = state;
    const zip = pickIfMissing(loc.zip, profile.zip);
    if (zip) patch.zip = zip;
    if (Object.keys(patch).length) {
      locationPatch = { id: loc.id, patch };
    }
  }

  // Contract signer can reinforce contact name when profile omitted it
  if (contract && contactUpsert && isBlank(contactUpsert.name) && signerName) {
    contactUpsert = { ...contactUpsert, name: signerName };
  }

  return { customerPatch, contactUpsert, locationPatch };
}

export function formatAccountEnrichmentNote(
  enrichment: AccountEnrichment,
  profile: CustomerDocumentExtractResult,
): string {
  const parts: string[] = [];
  if (Object.keys(enrichment.customerPatch).length) parts.push('account profile');
  if (enrichment.contactUpsert) parts.push('contact');
  if (enrichment.locationPatch) parts.push('address');
  if (enrichment.customerPatch.dateSigned) parts.push('date signed');
  if (enrichment.customerPatch.companyDescription) parts.push('company description');
  if (!parts.length) {
    if (profile.source === 'filename') {
      return 'Limited hints from filename — upload a PDF or image for full extraction.';
    }
    return 'No missing account fields found in this document.';
  }
  return `Updated missing ${parts.join(', ')} on this account from the document.`;
}

export function contractSignerLabel(profile: CustomerDocumentExtractResult): string | undefined {
  return profile.contactName?.trim() || undefined;
}

export function hasAccountEnrichment(enrichment: AccountEnrichment): boolean {
  return Boolean(
    Object.keys(enrichment.customerPatch).length ||
      enrichment.contactUpsert ||
      enrichment.locationPatch,
  );
}
