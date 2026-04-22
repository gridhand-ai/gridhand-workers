'use strict';

/**
 * City Data Integration
 * Vendor: City of Milwaukee Open Data Portal (data.milwaukee.gov)
 * Protocol: n8n webhook (primary) → CKAN CSV download (fallback)
 *
 * DATA ROUTING:
 *   1. PRIMARY — n8n webhook (N8N_CITY_DATA_WEBHOOK env var)
 *      When configured, all city data queries route through an n8n workflow
 *      that normalizes responses across different city portal types.
 *      n8n workflow receives: { city, industry, dataset, limit }
 *      n8n workflow returns:  { records: [...], total: N, source_label: '...' }
 *
 *   2. FALLBACK — direct CKAN CSV download from data.milwaukee.gov
 *      Used when N8N_CITY_DATA_WEBHOOK is not set.
 *      Currently wired for Milwaukee. Extensible to other cities via CITY_DATA_SOURCES config.
 *      TODO: route through n8n when N8N_CITY_DATA_WEBHOOK is configured for this operator.
 *
 * Milwaukee datasets used (fallback path):
 *   - Liquor Licenses (food/bar establishments): resource ID 45c027b5-fa66-4de2-aa7e-d9314292093d
 *     Fields: EXP_DATE, EFF_DATE, CORP_NAME, TRADE_NAME, LICENSEE, TAXKEY_NUMBER,
 *             HOUSE_NR, SDIR, STREET, STTYPE, ALDERMANIC_DISTRICT, POLICE_DISTRICT,
 *             LIC_TYPE, License Type Full Name, TOT_CAP, ROOM_CAP, TAXKEY
 *   - Building Permits (commercial/trades): resource ID 828e9630-d7cb-42e4-960e-964eae916397
 *     Used to surface active trades contractors (plumbing, HVAC, electrical)
 *
 * Env vars:
 *   N8N_CITY_DATA_WEBHOOK  — optional. If set, all queries route through n8n first.
 *                             Store in Railway as N8N_CITY_DATA_WEBHOOK=https://...
 *
 * Cache TTL: 24 hours in-memory (Map with timestamps).
 *
 * Exports:
 *   getBusinessesByIndustry(city, industry, options)
 *   getBusinessProfile(city, businessName, address)
 *   refreshCache(city)
 *   getSupportedCities()
 *   getSupportedIndustries()
 */

const https = require('https');

// ── n8n webhook config ────────────────────────────────────────────────────────
// When N8N_CITY_DATA_WEBHOOK is set, all city data queries route through n8n
// before falling back to direct CSV downloads.
// Set in Railway: N8N_CITY_DATA_WEBHOOK=https://gridhand-n8n-production.up.railway.app/webhook/<path>
const N8N_CITY_DATA_WEBHOOK = process.env.N8N_CITY_DATA_WEBHOOK || null;

// ── City data source registry ─────────────────────────────────────────────────
// Add new cities here. Milwaukee uses CKAN datastore with CSV resources.
// Other cities may use Socrata SODA — set `protocol: 'socrata'` and `datasetId` accordingly.
const CITY_DATA_SOURCES = {
  milwaukee: {
    name: 'Milwaukee',
    state: 'WI',
    protocol: 'ckan_csv',
    baseUrl: 'https://data.milwaukee.gov',
    datasets: {
      // Liquor/food establishment licenses — broadest business license dataset available
      business_licenses: {
        resourceId: '45c027b5-fa66-4de2-aa7e-d9314292093d',
        downloadPath: '/dataset/liquorlicenses/resource/45c027b5-fa66-4de2-aa7e-d9314292093d/download/liquorlicenses.csv',
        fields: {
          name: 'TRADE_NAME',
          corp: 'CORP_NAME',
          licenseType: 'License Type Full Name',
          licenseCode: 'LIC_TYPE',
          houseNr: 'HOUSE_NR',
          streetDir: 'SDIR',
          street: 'STREET',
          streetType: 'STTYPE',
          effDate: 'EFF_DATE',
          expDate: 'EXP_DATE',
          capacity: 'TOT_CAP',
        },
      },
      // Building permits — surfaces active trades (plumbing, HVAC, electrical, etc.)
      building_permits: {
        resourceId: '828e9630-d7cb-42e4-960e-964eae916397',
        downloadPath: '/dataset/buildingpermits/resource/828e9630-d7cb-42e4-960e-964eae916397/download/permits.csv',
        fields: {
          // Field names resolved at runtime from CSV header row
        },
      },
    },
  },

  // Template for adding Chicago (Socrata/SODA)
  // chicago: {
  //   name: 'Chicago',
  //   state: 'IL',
  //   protocol: 'socrata',
  //   baseUrl: 'https://data.cityofchicago.org',
  //   datasets: {
  //     business_licenses: {
  //       datasetId: 'uupf-x98q',
  //       fields: { name: 'doing_business_as_name', ... },
  //     },
  //   },
  // },
};

// ── Industry keyword maps ─────────────────────────────────────────────────────
// Maps GRIDHAND industry slugs to Milwaukee license type codes + keyword filters.
// LIC_TYPE codes from the Milwaukee liquor licenses dataset:
//   ALQML = Class A Malt & Class A Liquor (retail bottle shops)
//   BTAVN = Class B Tavern License (bars, restaurants with full bar)
//   BRSTR = Class B Restaurant License (food-primary)
//   CBRST = Combination B Restaurant
//   WINE  = Wine license
//   CATER = Caterer
const INDUSTRY_MAP = {
  restaurant: {
    label: 'Restaurant / Food Service',
    licenseCodes: ['BTAVN', 'BRSTR', 'CBRST', 'WINE', 'CATER', 'RSTRNT'],
    keywords: ['restaurant', 'grill', 'cafe', 'pizza', 'diner', 'bistro', 'kitchen', 'eatery', 'food', 'sushi', 'burger', 'bbq', 'taco', 'wings'],
  },
  bar: {
    label: 'Bar / Nightclub',
    licenseCodes: ['BTAVN', 'ALQML'],
    keywords: ['bar', 'tavern', 'pub', 'lounge', 'nightclub', 'brewery', 'tap', 'saloon'],
  },
  auto: {
    label: 'Auto Repair / Dealership',
    licenseCodes: [],
    keywords: ['auto', 'automotive', 'motor', 'tire', 'muffler', 'transmission', 'collision', 'bodyshop', 'dealership', 'car wash', 'oil change', 'lube', 'mechanic'],
  },
  salon: {
    label: 'Salon / Beauty / Barber',
    licenseCodes: [],
    keywords: ['salon', 'beauty', 'barber', 'hair', 'nails', 'spa', 'lash', 'wax', 'threading', 'cosmetology', 'stylists'],
  },
  gym: {
    label: 'Gym / Fitness',
    licenseCodes: [],
    keywords: ['gym', 'fitness', 'crossfit', 'yoga', 'pilates', 'boxing', 'martial arts', 'karate', 'bjj', 'jiu jitsu', 'personal training', 'health club'],
  },
  dental: {
    label: 'Dental / Medical',
    licenseCodes: [],
    keywords: ['dental', 'dentist', 'orthodont', 'oral', 'clinic', 'medical', 'health', 'therapy', 'chiropractic', 'physical therapy', 'urgent care'],
  },
  realestate: {
    label: 'Real Estate / Property Management',
    licenseCodes: [],
    keywords: ['realty', 'real estate', 'property', 'properties', 'management', 'rentals', 'apartments', 'housing', 'leasing'],
  },
  trades: {
    label: 'Trades (Plumbing / HVAC / Electrical)',
    licenseCodes: [],
    keywords: ['plumb', 'hvac', 'heating', 'cooling', 'electric', 'roofing', 'contractor', 'construction', 'welding', 'painting', 'flooring', 'carpentry'],
  },
};

// ── In-memory cache ───────────────────────────────────────────────────────────
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

const _cache = new Map();
// Structure: _cache.get(cacheKey) = { data: [...], fetchedAt: Date.now() }

function _cacheKey(city, dataset) {
  return `${city}:${dataset}`;
}

function _isCacheValid(entry) {
  return entry && (Date.now() - entry.fetchedAt) < CACHE_TTL_MS;
}

function _setCache(key, data) {
  _cache.set(key, { data, fetchedAt: Date.now() });
}

function _getCache(key) {
  const entry = _cache.get(key);
  return _isCacheValid(entry) ? entry.data : null;
}

// ── HTTP fetch helper (native https, no deps) ─────────────────────────────────
function _fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      // Handle redirects (Milwaukee CDN sometimes redirects)
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return _fetchUrl(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} from ${url}`));
      }
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Request timeout')); });
  });
}

// ── CSV parser (no deps) ──────────────────────────────────────────────────────
// Handles quoted fields and embedded commas.
function _parseCSV(text) {
  const lines = text.split('\n').filter(l => l.trim());
  if (lines.length < 2) return [];

  function parseLine(line) {
    const fields = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
        else { inQuotes = !inQuotes; }
      } else if (ch === ',' && !inQuotes) {
        fields.push(current.trim());
        current = '';
      } else {
        current += ch;
      }
    }
    fields.push(current.trim());
    return fields;
  }

  const headers = parseLine(lines[0]);
  const records = [];
  for (let i = 1; i < lines.length; i++) {
    const values = parseLine(lines[i]);
    if (values.length < 2) continue;
    const record = {};
    headers.forEach((h, idx) => { record[h] = values[idx] || ''; });
    records.push(record);
  }
  return records;
}

// ── Normalizer ────────────────────────────────────────────────────────────────
// Converts raw Milwaukee CSV row to a normalized GRIDHAND business object.
function _normalizeRecord(row, cityKey, industrySlug) {
  const src = CITY_DATA_SOURCES[cityKey];
  if (!src) return null;

  const f = src.datasets.business_licenses.fields;

  const houseNr  = (row[f.houseNr] || '').trim();
  const dir      = (row[f.streetDir] || '').trim();
  const street   = (row[f.street] || '').trim();
  const stType   = (row[f.streetType] || '').trim();
  const address  = [houseNr, dir, street, stType].filter(Boolean).join(' ');

  const name = (row[f.name] || row[f.corp] || '').trim();
  const expDate = row[f.expDate] || '';
  const now = new Date();
  const exp = expDate ? new Date(expDate) : null;
  const isActive = exp ? exp > now : true;

  return {
    name,
    corporateName: (row[f.corp] || '').trim(),
    address,
    city: src.name,
    state: src.state,
    zip: '',           // Milwaukee license data does not include ZIP
    industry: industrySlug || 'unknown',
    industryLabel: INDUSTRY_MAP[industrySlug]?.label || 'Unknown',
    licenseType: (row[f.licenseType] || '').trim(),
    licenseCode: (row[f.licenseCode] || '').trim(),
    licenseEffective: (row[f.effDate] || '').trim(),
    licenseExpires: expDate.trim(),
    isActive,
    phone: '',         // Not available in Milwaukee license data
    lat: null,         // Not in this dataset; enrich via Google Maps if needed
    lng: null,
    capacity: (row[f.capacity] || '').trim(),
    source: 'milwaukee_open_data',
  };
}

// ── n8n primary fetch ─────────────────────────────────────────────────────────
/**
 * Attempt to fetch raw records from the n8n city-data webhook.
 * n8n workflow receives the query params and returns normalized records.
 * Returns null if webhook is not configured or the call fails — caller falls back to CSV.
 *
 * @param {string} cityKey    - e.g. 'milwaukee'
 * @param {string} datasetKey - e.g. 'business_licenses'
 * @param {object} [extra]    - Additional context to pass to n8n (industry, limit, etc.)
 * @returns {Promise<Array|null>} Raw records array, or null on miss/failure
 */
async function _fetchViaN8n(cityKey, datasetKey, extra = {}) {
  if (!N8N_CITY_DATA_WEBHOOK) return null;

  const src = CITY_DATA_SOURCES[cityKey];
  const payload = {
    city:       src?.name || cityKey,
    state:      src?.state || '',
    dataset:    datasetKey,
    resourceId: src?.datasets?.[datasetKey]?.resourceId || null,
    portalUrl:  src?.baseUrl || null,
    ...extra,
  };

  console.log(`[city-data] Routing ${cityKey}/${datasetKey} through n8n webhook`);

  return new Promise((resolve) => {
    try {
      const body = JSON.stringify(payload);
      const webhookUrl = new URL(N8N_CITY_DATA_WEBHOOK);
      const options = {
        hostname: webhookUrl.hostname,
        port:     webhookUrl.port || 443,
        path:     webhookUrl.pathname + (webhookUrl.search || ''),
        method:   'POST',
        headers:  {
          'Content-Type':   'application/json',
          'Content-Length': Buffer.byteLength(body),
          'User-Agent':     'GRIDHAND-CityData/1.0',
        },
      };

      const req = https.request(options, (res) => {
        if (res.statusCode !== 200) {
          console.warn(`[city-data] n8n webhook returned ${res.statusCode} — falling back to direct`);
          return resolve(null);
        }
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          try {
            const json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            // n8n workflow must return { records: [...] } or a plain array
            const records = Array.isArray(json) ? json : json?.records;
            if (!Array.isArray(records)) {
              console.warn(`[city-data] n8n response missing records array — falling back to direct`);
              return resolve(null);
            }
            console.log(`[city-data] n8n returned ${records.length} records for ${cityKey}/${datasetKey}`);
            resolve(records);
          } catch (parseErr) {
            console.warn(`[city-data] n8n response parse error — falling back to direct:`, parseErr.message);
            resolve(null);
          }
        });
        res.on('error', (err) => {
          console.warn(`[city-data] n8n response error — falling back to direct:`, err.message);
          resolve(null);
        });
      });

      req.on('error', (err) => {
        console.warn(`[city-data] n8n request error — falling back to direct:`, err.message);
        resolve(null);
      });

      req.setTimeout(15000, () => {
        req.destroy();
        console.warn(`[city-data] n8n webhook timeout — falling back to direct`);
        resolve(null);
      });

      req.write(body);
      req.end();
    } catch (err) {
      console.warn(`[city-data] n8n fetch setup failed — falling back to direct:`, err.message);
      resolve(null);
    }
  });
}

// ── Load + cache full dataset ─────────────────────────────────────────────────
async function _loadDataset(cityKey, datasetKey) {
  const cKey = _cacheKey(cityKey, datasetKey);
  const cached = _getCache(cKey);
  if (cached) return cached;

  const src = CITY_DATA_SOURCES[cityKey];
  if (!src) throw new Error(`Unknown city: ${cityKey}`);

  const dataset = src.datasets[datasetKey];
  if (!dataset) throw new Error(`Dataset "${datasetKey}" not configured for ${cityKey}`);

  // 1. Try n8n webhook first
  const n8nRecords = await _fetchViaN8n(cityKey, datasetKey);
  if (n8nRecords) {
    _setCache(cKey, n8nRecords);
    return n8nRecords;
  }

  // 2. Fall back to direct CSV download
  // TODO: route through n8n when N8N_CITY_DATA_WEBHOOK is configured
  const url = `${src.baseUrl}${dataset.downloadPath}`;
  const csvText = await _fetchUrl(url);
  const records = _parseCSV(csvText);

  _setCache(cKey, records);
  return records;
}

// ── Scoring / matching helper ─────────────────────────────────────────────────
function _matchesIndustry(row, industrySlug) {
  const industry = INDUSTRY_MAP[industrySlug];
  if (!industry) return false;

  const licCode = (row['LIC_TYPE'] || '').toUpperCase();
  const tradeName = (row['TRADE_NAME'] || '').toLowerCase();
  const corpName  = (row['CORP_NAME'] || '').toLowerCase();
  const combined  = `${tradeName} ${corpName}`;

  // License code match (most precise — used for restaurant/bar)
  if (industry.licenseCodes.length > 0 && industry.licenseCodes.includes(licCode)) {
    return true;
  }

  // Keyword match (for industries not license-coded in this dataset)
  if (industry.keywords.some(kw => combined.includes(kw))) {
    return true;
  }

  return false;
}

// ── Active license filter ─────────────────────────────────────────────────────
function _isActiveRecord(row) {
  const expDate = row['EXP_DATE'];
  if (!expDate) return true;
  return new Date(expDate) > new Date();
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * getBusinessesByIndustry(city, industry, options)
 *
 * Returns businesses in the given city that match the industry slug.
 *
 * @param {string} city     - City key from CITY_DATA_SOURCES (e.g. 'milwaukee')
 * @param {string} industry - Industry slug from INDUSTRY_MAP (e.g. 'restaurant', 'auto', 'salon')
 * @param {object} options  - { limit: number, activeOnly: boolean, keyword: string }
 * @returns {Promise<Array>} - Normalized business objects
 */
async function getBusinessesByIndustry(city, industry, options = {}) {
  const cityKey = city.toLowerCase();
  const { limit = 100, activeOnly = true, keyword = null } = options;

  if (!CITY_DATA_SOURCES[cityKey]) {
    throw new Error(`City "${city}" is not configured. Supported: ${Object.keys(CITY_DATA_SOURCES).join(', ')}`);
  }
  if (!INDUSTRY_MAP[industry]) {
    throw new Error(`Industry "${industry}" is not configured. Supported: ${Object.keys(INDUSTRY_MAP).join(', ')}`);
  }

  const records = await _loadDataset(cityKey, 'business_licenses');

  let filtered = records.filter(row => {
    if (activeOnly && !_isActiveRecord(row)) return false;
    if (!_matchesIndustry(row, industry)) return false;
    if (keyword) {
      const kw = keyword.toLowerCase();
      const name = `${row['TRADE_NAME']} ${row['CORP_NAME']}`.toLowerCase();
      if (!name.includes(kw)) return false;
    }
    return true;
  });

  if (limit > 0) filtered = filtered.slice(0, limit);

  return filtered.map(row => _normalizeRecord(row, cityKey, industry));
}

/**
 * getBusinessProfile(city, businessName, address)
 *
 * Looks up a specific business by name (fuzzy) and optional address fragment.
 * Returns the best match or null.
 *
 * @param {string} city         - City key (e.g. 'milwaukee')
 * @param {string} businessName - Trade name or corp name to search
 * @param {string} [address]    - Optional address fragment for disambiguation
 * @returns {Promise<object|null>}
 */
async function getBusinessProfile(city, businessName, address = '') {
  const cityKey = city.toLowerCase();

  if (!CITY_DATA_SOURCES[cityKey]) {
    throw new Error(`City "${city}" is not configured.`);
  }

  const records = await _loadDataset(cityKey, 'business_licenses');

  const nameQuery   = businessName.toLowerCase().trim();
  const addrQuery   = address.toLowerCase().trim();

  // Score each record — exact > contains > word partial
  const scored = records.map(row => {
    const tradeName = (row['TRADE_NAME'] || '').toLowerCase();
    const corpName  = (row['CORP_NAME']  || '').toLowerCase();
    const houseNr   = (row['HOUSE_NR']   || '').toLowerCase();
    const street    = (row['STREET']     || '').toLowerCase();
    const rowAddr   = `${houseNr} ${street}`.trim();

    let score = 0;

    if (tradeName === nameQuery || corpName === nameQuery) score += 100;
    else if (tradeName.includes(nameQuery) || corpName.includes(nameQuery)) score += 60;
    else {
      const words = nameQuery.split(/\s+/);
      const matchedWords = words.filter(w => tradeName.includes(w) || corpName.includes(w));
      score += matchedWords.length * 10;
    }

    if (addrQuery && rowAddr.includes(addrQuery)) score += 40;

    return { row, score };
  });

  const best = scored
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)[0];

  if (!best) return null;

  // Detect industry from the matched record
  const industry = Object.keys(INDUSTRY_MAP).find(slug => _matchesIndustry(best.row, slug)) || 'unknown';
  return _normalizeRecord(best.row, cityKey, industry);
}

/**
 * refreshCache(city)
 *
 * Force-evicts the in-memory cache for a city and re-fetches all datasets.
 * Called by the /trigger/city-data-refresh endpoint.
 *
 * @param {string} [city] - City key to refresh, or 'all' / omit to refresh all cities
 * @returns {Promise<{ refreshed: string[], recordCounts: object }>}
 */
async function refreshCache(city = 'all') {
  const targets = city === 'all'
    ? Object.keys(CITY_DATA_SOURCES)
    : [city.toLowerCase()];

  const refreshed = [];
  const recordCounts = {};

  for (const cityKey of targets) {
    if (!CITY_DATA_SOURCES[cityKey]) continue;

    // Evict all dataset entries for this city
    for (const key of _cache.keys()) {
      if (key.startsWith(`${cityKey}:`)) _cache.delete(key);
    }

    // Re-fetch business licenses
    try {
      const records = await _loadDataset(cityKey, 'business_licenses');
      recordCounts[cityKey] = records.length;
      refreshed.push(cityKey);
    } catch (err) {
      recordCounts[cityKey] = `ERROR: ${err.message}`;
    }
  }

  return { refreshed, recordCounts };
}

/**
 * getSupportedCities()
 * @returns {string[]} List of configured city keys
 */
function getSupportedCities() {
  return Object.keys(CITY_DATA_SOURCES);
}

/**
 * getSupportedIndustries()
 * @returns {Array<{ slug, label, keywords }>}
 */
function getSupportedIndustries() {
  return Object.entries(INDUSTRY_MAP).map(([slug, def]) => ({
    slug,
    label: def.label,
    keywords: def.keywords,
    licenseCodes: def.licenseCodes,
  }));
}

module.exports = {
  getBusinessesByIndustry,
  getBusinessProfile,
  refreshCache,
  getSupportedCities,
  getSupportedIndustries,
  CITY_DATA_SOURCES,
  INDUSTRY_MAP,
  // Internal — exposed for testing
  _fetchViaN8n,
};
