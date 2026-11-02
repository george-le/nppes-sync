// FHIR Provider Directory (PDEX Plan-Net) client for payer directories.
// TypeScript port of sources/fhir_pd.py, used by POST /api/sources/:id/sync.
//
// Pulls PractitionerRole pages with _include for Practitioner, Location and
// Organization, follows Bundle "next" links, and normalizes each role to the
// providers column names. Falls back to a plain search (then per-Location fetches)
// for servers that reject _include.

export interface NormalizedRecord {
  source: string;
  source_provider_id: string;
  npi: string | null;
  entity_type: string | null;
  provider_name: string | null;
  first_name: string | null;
  last_name: string | null;
  credential: string | null;
  organization_name: string | null;
  location_name: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  phone: string | null;
  taxonomy_code: string | null;
  taxonomy_desc: string | null;
  status: 'Active' | 'Deactivated';
  active: boolean;
  last_updated: string | null;
}

type Includes = Record<string, any>;

export class FhirError extends Error {
  constructor(message: string, public status: number | null = null) {
    super(message);
  }
}

const INCLUDES = [
  'PractitionerRole:practitioner',
  'PractitionerRole:location',
  'PractitionerRole:organization',
];
const NPI_SYSTEM_HINTS = ['us-npi', '/sid/us-npi', 'npi'];
const RETRIES = 2;             // extra attempts for 5xx responses and transport errors
const RETRY_DELAY_MS = 3000;
const TIMEOUT_MS = 60_000;
const USER_AGENT = 'nppes-sync/0.1 (+provider-directory-adapter)';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function getJsonOnce(url: string): Promise<any> {
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Accept: 'application/fhir+json', 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err: any) {
    throw new FhirError(`network error for ${url}: ${err?.message ?? err}`);
  }
  if (!res.ok) throw new FhirError(`HTTP ${res.status} for ${url}`, res.status);
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new FhirError(`non-JSON response from ${url}: ${text.slice(0, 120)}`);
  }
}

// GET with retries on 5xx and transport errors. 4xx fails immediately.
async function getJson(url: string): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await getJsonOnce(url);
    } catch (err) {
      const fhirErr = err as FhirError;
      const retryable = fhirErr.status == null || fhirErr.status >= 500;
      if (!retryable || attempt >= RETRIES) throw fhirErr;
      await sleep(RETRY_DELAY_MS);
    }
  }
}

// One Bundle at a time: the roles on that page plus its included resources.
interface Page {
  pageNo: number;
  nextUrl: string | null;
  pairs: Array<{ role: any; includes: Includes }>;
}

async function* iterPages(
  endpoint: string,
  pageSize: number,
  maxPages: number | null,
  include: boolean,
  extra: Record<string, string> = {},
  startUrl: string | null = null,
  pageOffset = 0,
): AsyncGenerator<Page> {
  const params = new URLSearchParams();
  params.set('_count', String(pageSize));
  for (const [key, value] of Object.entries(extra)) params.set(key, value);
  if (include) for (const inc of INCLUDES) params.append('_include', inc);

  let url: string | null = startUrl ?? `${endpoint}/PractitionerRole?${params.toString()}`;
  let pageNo = pageOffset;
  while (url) {
    const bundle = await getJson(url);
    if (bundle.resourceType !== 'Bundle') {
      throw new FhirError(`expected Bundle from ${url}, got ${bundle.resourceType}`);
    }
    const includes: Includes = {};
    const roles: any[] = [];
    for (const entry of bundle.entry ?? []) {
      const res = entry.resource ?? {};
      const rtype = res.resourceType;
      if (!rtype) continue;
      if (entry.search?.mode === 'include' || rtype !== 'PractitionerRole') {
        includes[`${rtype}/${res.id}`] = res;
      } else {
        roles.push(res);
      }
    }
    pageNo++;
    const next = (bundle.link ?? []).find((l: any) => l.relation === 'next');
    const nextUrl: string | null = next ? new URL(next.url, endpoint + '/').toString() : null;
    const atLimit = maxPages !== null && pageNo >= maxPages;
    // No resume point once the last page is reached or the page limit stops the run.
    yield { pageNo, nextUrl: atLimit ? null : nextUrl, pairs: roles.map((role) => ({ role, includes })) };
    if (atLimit) return;
    url = nextUrl;
  }
}

// Resolve a Reference against the included resources from the same bundle.
function resolveRef(ref: any, includes: Includes): any | undefined {
  if (!ref?.reference) return undefined;
  const key = String(ref.reference).replace(/\/+$/, '').split('/').slice(-2).join('/');
  return includes[key];
}

function isNpiIdentifier(ident: any): boolean {
  const system = String(ident?.system ?? '').toLowerCase();
  if (NPI_SYSTEM_HINTS.some((h) => system.includes(h))) return true;
  const codings = ident?.type?.coding ?? [];
  return codings.some((c: any) => String(c?.code ?? '').toUpperCase() === 'NPI');
}

function npiFrom(identifiers: any): string | null {
  const list = Array.isArray(identifiers) ? identifiers : identifiers ? [identifiers] : [];
  for (const ident of list) {
    const value = ident?.value;
    if (value && isNpiIdentifier(ident) && /^\d+$/.test(String(value))) return String(value);
  }
  return null;
}

function specialtyOf(role: any): { code: string | null; display: string | null } {
  for (const spec of role.specialty ?? []) {
    for (const coding of spec.coding ?? []) {
      if (coding.code || coding.display) {
        return { code: coding.code ?? null, display: coding.display ?? spec.text ?? null };
      }
    }
    if (spec.text) return { code: null, display: spec.text };
  }
  return { code: null, display: null };
}

function personName(practitioner: any): { display: string | null; first: string | null; last: string | null } {
  const names: any[] = practitioner?.name ?? [];
  const name = names.find((n) => n.use === 'official') ?? names[0];
  if (!name) return { display: null, first: null, last: null };
  const given = (name.given ?? []).join(' ') || null;
  const family = name.family ?? null;
  const display = [...(name.prefix ?? []), given, family, ...(name.suffix ?? [])]
    .filter(Boolean)
    .join(' ') || name.text || null;
  return { display, first: given, last: family };
}

function addressOf(location: any): { line1: string | null; line2: string | null; city: string | null; state: string | null; postal: string | null } {
  const addr = location?.address ?? {};
  const lines: string[] = (addr.line ?? []).filter(Boolean);
  return {
    line1: lines[0] ?? null,
    line2: lines.slice(1).join(' ') || null,
    city: addr.city ?? null,
    state: addr.state ?? null,
    postal: addr.postalCode ? String(addr.postalCode).slice(0, 5) : null,
  };
}

function phoneOf(...resources: Array<any | undefined>): string | null {
  for (const res of resources) {
    for (const t of res?.telecom ?? []) {
      if (t.system === 'phone' && t.value) return t.value;
    }
  }
  return null;
}

function normalizeRole(role: any, includes: Includes, sourceId: string): NormalizedRecord {
  const practitioner = resolveRef(role.practitioner, includes);
  const organization = resolveRef(role.organization, includes);
  const locations = (role.location ?? []).map((l: any) => resolveRef(l, includes));
  const primaryLocation = locations.find((l: any) => l);
  const name = personName(practitioner);
  const spec = specialtyOf(role);
  const inlineLocation = (role.location ?? []).find((l: any) => l?.display)?.display ?? null;
  const addr = addressOf(primaryLocation);
  // Payer directories do not report NPI deactivation. Some (Blue Shield) set active=false on every
  // role, so the flag is not used for status. NPI status comes from NPPES, not from payer directories.

  return {
    source: sourceId,
    source_provider_id: String(role.id),
    npi: npiFrom(role.identifier) ?? npiFrom(practitioner?.identifier) ?? npiFrom(role.practitioner?.identifier),
    entity_type: null,
    provider_name: name.display ?? role.practitioner?.display ?? null,
    first_name: name.first,
    last_name: name.last,
    credential: null,
    organization_name: organization?.name ?? role.organization?.display ?? null,
    location_name: primaryLocation?.name ?? inlineLocation,
    address_line1: addr.line1,
    address_line2: addr.line2,
    city: addr.city,
    state: addr.state,
    postal_code: addr.postal,
    phone: phoneOf(role, primaryLocation, organization),
    taxonomy_code: spec.code,
    taxonomy_desc: spec.display,
    status: 'Active',
    active: true,
    last_updated: role.meta?.lastUpdated ?? null,
  };
}

async function fetchLocations(base: string, roles: any[]): Promise<{ found: Includes; failures: number }> {
  const wanted = new Set<string>();
  for (const role of roles) {
    for (const loc of role.location ?? []) {
      const ref = String(loc?.reference ?? '');
      if (ref.startsWith('Location/')) wanted.add(ref);
    }
  }
  const found: Includes = {};
  let failures = 0;
  for (const ref of wanted) {
    try {
      found[ref] = await getJson(`${base}/${ref}`);
    } catch {
      failures++;
    }
  }
  return { found, failures };
}

export interface RawResource {
  resourceType: string;
  id: string;
  payload: any;
}

// Top-level field differences between two FHIR payloads. Nested values compare as JSON text.
export function diffPayloads(oldPayload: any, newPayload: any): Array<{ field: string; oldValue: string | null; newValue: string | null }> {
  const keys = new Set([...Object.keys(oldPayload ?? {}), ...Object.keys(newPayload ?? {})]);
  const changes: Array<{ field: string; oldValue: string | null; newValue: string | null }> = [];
  for (const key of keys) {
    if (key === 'meta') continue; // versionId and lastUpdated change on every fetch of an unchanged resource
    const before = oldPayload?.[key];
    const after = newPayload?.[key];
    if (JSON.stringify(before) === JSON.stringify(after)) continue;
    const text = (v: any) => (v === undefined || v === null ? null : typeof v === 'string' ? v : JSON.stringify(v));
    changes.push({ field: key, oldValue: text(before), newValue: text(after) });
  }
  return changes;
}

// One network the role participates in, from its network-reference extension.
export interface NetworkRef {
  source_provider_id: string;
  network_ref: string;
  network_name: string | null;
}

// Everything one page of the directory produced, ready to write in one transaction.
export interface PagePull {
  pageNo: number;
  nextUrl: string | null;      // where to resume after this page; null after the last page
  records: NormalizedRecord[];
  raw: RawResource[];          // PractitionerRole plus every included resource, unmodified, deduplicated within the page
  networks: NetworkRef[];
  includesUsed: boolean;
  locationFailures: number;
}

function buildPage(pairs: Array<{ role: any; includes: Includes }>, sourceId: string, pageNo: number,
  nextUrl: string | null, includesUsed: boolean, locationFailures: number): PagePull {
  const raw: RawResource[] = [];
  const seen = new Set<string>();
  const keep = (res: any) => {
    if (!res?.resourceType || res.id == null) return;
    const key = `${res.resourceType}/${res.id}`;
    if (seen.has(key)) return;
    seen.add(key);
    raw.push({ resourceType: res.resourceType, id: String(res.id), payload: res });
  };
  const networks: NetworkRef[] = [];
  for (const { role, includes } of pairs) {
    keep(role);
    for (const inc of Object.values(includes)) keep(inc);
    for (const ext of role.extension ?? []) {
      if (!String(ext?.url ?? '').endsWith('network-reference')) continue;
      const ref = ext.valueReference ?? {};
      if (!ref.reference) continue;
      const org = resolveRef(ref, includes);
      networks.push({
        source_provider_id: String(role.id),
        network_ref: String(ref.reference),
        network_name: org?.name ?? ref.display ?? null,
      });
    }
  }
  return {
    pageNo,
    nextUrl,
    records: pairs.map(({ role, includes }) => normalizeRole(role, includes, sourceId)),
    raw,
    networks,
    includesUsed,
    locationFailures,
  };
}

// Pull a directory one page at a time. Each page is yielded as soon as it arrives, so the
// caller can write it before the next page is fetched. A server that rejects _include on the
// first request gets a plain search, with Locations fetched per page. Throws FhirError on failure.
export async function* pullPages(
  base: string,
  sourceId: string,
  opts: {
    pageSize: number;
    maxPages: number | null;
    extra?: Record<string, string>;
    // Resume from a saved next-page URL. includesUsed and pageOffset come from the saved job.
    resume?: { url: string; includesUsed: boolean; pageOffset: number };
  },
): AsyncGenerator<PagePull> {
  const extra = opts.extra ?? {};
  const endpoint = base.replace(/\/+$/, '');
  let include = true;
  let pages: AsyncGenerator<Page>;
  let current: IteratorResult<Page>;
  if (opts.resume) {
    include = opts.resume.includesUsed;
    pages = iterPages(endpoint, opts.pageSize, opts.maxPages, include, extra, opts.resume.url, opts.resume.pageOffset);
    current = await pages.next();
  } else {
    pages = iterPages(endpoint, opts.pageSize, opts.maxPages, true, extra);
    try {
      current = await pages.next();
    } catch (err) {
      if (!(err instanceof FhirError) || err.status !== 400) throw err;
      include = false;
      pages = iterPages(endpoint, opts.pageSize, opts.maxPages, false, extra);
      current = await pages.next();
    }
  }

  while (!current.done) {
    const page = current.value;
    if (include) {
      yield buildPage(page.pairs, sourceId, page.pageNo, page.nextUrl, true, 0);
    } else {
      const { found, failures } = await fetchLocations(endpoint, page.pairs.map((p) => p.role));
      const withLocations = page.pairs.map((p) => ({ role: p.role, includes: found }));
      yield buildPage(withLocations, sourceId, page.pageNo, page.nextUrl, false, failures);
    }
    current = await pages.next();
  }
}

// Fetch a list of references such as "Organization/123" directly from the payer's base URL.
// A single failed fetch is counted, not fatal.
export async function fetchReferences(base: string, refs: string[]): Promise<{ raw: RawResource[]; failures: number }> {
  const endpoint = base.replace(/\/+$/, '');
  const raw: RawResource[] = [];
  let failures = 0;
  for (const ref of [...new Set(refs)]) {
    if (!/^[A-Za-z]+\/[A-Za-z0-9._-]+$/.test(ref)) { failures++; continue; }
    try {
      const res = await getJson(`${endpoint}/${ref}`);
      if (res?.resourceType && res.id != null) raw.push({ resourceType: res.resourceType, id: String(res.id), payload: res });
      else failures++;
    } catch {
      failures++;
    }
  }
  return { raw, failures };
}

// Page through every resource of one type (e.g. InsurancePlan), following Bundle next links.
export async function* pullResourceType(base: string, resourceType: string, pageSize: number): AsyncGenerator<RawResource[]> {
  const endpoint = base.replace(/\/+$/, '');
  let url: string | null = `${endpoint}/${resourceType}?_count=${pageSize}`;
  while (url) {
    const bundle = await getJson(url);
    if (bundle.resourceType !== 'Bundle') throw new FhirError(`expected Bundle from ${url}, got ${bundle.resourceType}`);
    const page: RawResource[] = [];
    for (const entry of bundle.entry ?? []) {
      const res = entry.resource;
      if (res?.resourceType === resourceType && res.id != null) page.push({ resourceType, id: String(res.id), payload: res });
    }
    yield page;
    const next = (bundle.link ?? []).find((l: any) => l.relation === 'next');
    url = next ? new URL(next.url, endpoint + '/').toString() : null;
  }
}
