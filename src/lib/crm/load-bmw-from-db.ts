import type { SupabaseClient } from '@supabase/supabase-js';
import { dealKey } from '@/lib/bmw/deal-key';
import type { BmwAgentRate, BmwDeal } from '@/lib/bmw/types';
import { createCrmReadClient } from '@/lib/supabase/crm-read-client';

type BmwDealRow = {
  deal_data: BmwDeal;
};

type BmwAgentRateRow = {
  rate_data: BmwAgentRate;
};

export async function loadBmwDealsFromDatabase(client?: SupabaseClient): Promise<BmwDeal[]> {
  const db = client ?? (await createCrmReadClient());
  const { data, error } = await db.from('bmw_deals').select('deal_data').order('id');
  if (error) throw new Error(error.message);
  return (data as BmwDealRow[] | null)?.map((row) => row.deal_data) ?? [];
}

export async function loadBmwAgentRatesFromDatabase(client?: SupabaseClient): Promise<BmwAgentRate[]> {
  const db = client ?? (await createCrmReadClient());
  const { data, error } = await db.from('bmw_agent_rates').select('rate_data').order('id');
  if (error) throw new Error(error.message);
  return (data as BmwAgentRateRow[] | null)?.map((row) => row.rate_data) ?? [];
}

export function bmwDealExternalKey(deal: BmwDeal): string {
  const key = dealKey(deal);
  return key || `row-${deal.rowNum}`;
}
