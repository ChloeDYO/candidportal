import type { SupabaseClient } from '@supabase/supabase-js';
import type { Customer } from '@/components/CustomersView';
import { createCrmReadClient } from '@/lib/supabase/crm-read-client';
import {
  dealRowToContract,
  recordRowToDocument,
  rowsToCustomer,
  type DbContactRow,
  type DbCustomerRow,
  type DbDealRow,
  type DbLocationRow,
  type DbRecordRow,
} from '@/lib/crm/db-mapper';
import type { CandidContractRecord, CustomerDocument } from '@/lib/customer-records';
import type { BmwAgentRate, BmwDeal } from '@/lib/bmw/types';
import type { CrmRuntimeData } from '@/lib/crm/runtime-store';
import {
  loadBmwAgentRatesFromDatabase,
  loadBmwDealsFromDatabase,
} from '@/lib/crm/load-bmw-from-db';

export type CrmBootstrap = CrmRuntimeData & {
  customerCount: number;
};

export async function loadCrmCustomerSlice(
  externalId: string,
  client?: SupabaseClient,
): Promise<CrmBootstrap | null> {
  const db = client ?? (await createCrmReadClient());

  const { data: customerRow, error: customerError } = await db
    .from('customers')
    .select('*')
    .eq('external_id', externalId)
    .maybeSingle();

  if (customerError) throw new Error(customerError.message);
  if (!customerRow) return null;

  const customerUuid = customerRow.id;

  const [
    { data: locationRows, error: locationError },
    { data: contactRows, error: contactError },
    { data: dealRows, error: dealError },
    { data: recordRows, error: recordError },
  ] = await Promise.all([
    db.from('customer_locations').select('*').eq('customer_id', customerUuid),
    db.from('customer_contacts').select('*').eq('customer_id', customerUuid),
    db.from('deals').select('*').eq('customer_id', customerUuid),
    db.from('customer_records').select('*').eq('customer_id', customerUuid),
  ]);

  if (locationError) throw new Error(locationError.message);
  if (contactError) throw new Error(contactError.message);
  if (dealError) throw new Error(dealError.message);
  if (recordError) throw new Error(recordError.message);

  const customer = rowsToCustomer(
    customerRow as DbCustomerRow,
    (locationRows as DbLocationRow[]) ?? [],
    (contactRows as DbContactRow[]) ?? [],
  );

  return {
    source: 'supabase',
    ready: true,
    customerCount: 1,
    customers: [customer],
    documentsByCustomerId: {
      [externalId]: ((recordRows as DbRecordRow[]) ?? []).map((r) => recordRowToDocument(r, externalId)),
    },
    contractsByCustomerId: {
      [externalId]: ((dealRows as DbDealRow[]) ?? []).map((d) => dealRowToContract(d, externalId)),
    },
    bmwDeals: [],
    agentRates: [],
  };
}

export async function loadCrmFromDatabase(client?: SupabaseClient): Promise<CrmBootstrap | null> {
  const db = client ?? (await createCrmReadClient());

  const { data: customerRows, error: customerError } = await db
    .from('customers')
    .select('*')
    .order('company');

  if (customerError) throw new Error(customerError.message);
  if (!customerRows?.length) return null;

  const { data: locationRows, error: locationError } = await db
    .from('customer_locations')
    .select('*');

  if (locationError) throw new Error(locationError.message);

  const { data: contactRows, error: contactError } = await db
    .from('customer_contacts')
    .select('*');

  if (contactError) throw new Error(contactError.message);

  const { data: dealRows, error: dealError } = await db.from('deals').select('*');

  if (dealError) throw new Error(dealError.message);

  const { data: recordRows, error: recordError } = await db
    .from('customer_records')
    .select('*');

  if (recordError) throw new Error(recordError.message);

  const locationsByCustomer = groupBy(locationRows as DbLocationRow[], 'customer_id');
  const contactsByCustomer = groupBy(contactRows as DbContactRow[], 'customer_id');
  const dealsByCustomer = groupBy(dealRows as DbDealRow[], 'customer_id');
  const recordsByCustomer = groupBy(recordRows as DbRecordRow[], 'customer_id');

  const customers: Customer[] = [];
  const documentsByCustomerId: Record<string, CustomerDocument[]> = {};
  const contractsByCustomerId: Record<string, CandidContractRecord[]> = {};

  for (const row of customerRows as DbCustomerRow[]) {
    const customer = rowsToCustomer(
      row,
      locationsByCustomer.get(row.id) ?? [],
      contactsByCustomer.get(row.id) ?? [],
    );
    customers.push(customer);

    const externalId = row.external_id;
    documentsByCustomerId[externalId] = (recordsByCustomer.get(row.id) ?? []).map((r) =>
      recordRowToDocument(r, externalId),
    );
    contractsByCustomerId[externalId] = (dealsByCustomer.get(row.id) ?? []).map((d) =>
      dealRowToContract(d, externalId),
    );
  }

  customers.sort((a, b) => a.company.localeCompare(b.company));

  const [bmwDeals, agentRates] = await Promise.all([
    loadBmwDealsFromDatabase(db),
    loadBmwAgentRatesFromDatabase(db),
  ]);

  return {
    source: 'supabase',
    ready: true,
    customerCount: customers.length,
    customers,
    documentsByCustomerId,
    contractsByCustomerId,
    bmwDeals,
    agentRates,
  };
}

function groupBy<T extends Record<string, unknown>>(rows: T[], key: keyof T): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const id = String(row[key]);
    const list = map.get(id) ?? [];
    list.push(row);
    map.set(id, list);
  }
  return map;
}

export async function getCrmCustomerUuid(
  externalId: string,
  client?: SupabaseClient,
): Promise<string | null> {
  const db = client ?? (await createCrmReadClient());
  const { data, error } = await db
    .from('customers')
    .select('id')
    .eq('external_id', externalId)
    .maybeSingle();
  if (error || !data) return null;
  return data.id;
}

export function customerUuidMap(rows: DbCustomerRow[]): Map<string, string> {
  return new Map(rows.map((row) => [row.external_id, row.id]));
}
