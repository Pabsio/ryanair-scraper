// scrape.js — Daily Ryanair scraper → Google Sheets
// Runs via GitHub Actions, writes to a single Sheet tab

import { google } from 'googleapis';

// ─── CONFIG ──────────────────────────────────────────────────────────────────

const SHEET_ID   = '1SoO7kZuMf_LnI_4EPp4OqHyWvhVi85gLA9g6reyOcbo';
const SHEET_NAME = 'Ryanair';
const TOP_N      = 50; // resultados por aeropuerto+patrón

// ⚠️  PRUEBA: solo 1 aeropuerto para testear escritura en Sheet.
const ORIGINS = ['MAD'];

// Lista completa para cuando valides:
// const ORIGINS = [
//   'BER','MUC','FRA','CGN','HAM',  // Alemania
//   'VIE',                           // Austria
//   'ZRH','GVA',                     // Suiza
//   'FCO','MXP','BGY','VCE','NAP',  // Italia
//   'MAD','BCN','AGP','PMI','SVQ',  // España
//   'CDG','ORY','NCE','MRS',        // Francia
//   'WAW','KTW','WRO',              // Polonia
//   'STN','MAN','EDI','LGW',        // Reino Unido
//   'AMS',                           // Holanda
//   'CRL','BRU',                     // Bélgica
// ];

// ─── FECHA RANGE ─────────────────────────────────────────────────────────────

function getDateRange() {
  const now = new Date();
  const from = now.toISOString().split('T')[0];
  const end  = new Date(now.getFullYear(), now.getMonth() + 3, 0);
  const to   = end.toISOString().split('T')[0];
  return { from, to };
}

// ─── PATRONES ────────────────────────────────────────────────────────────────

function getPatterns() {
  const { from, to } = getDateRange();
  return [
  {
    label:     'Fin de semana',
    nightsMin: 2,
    nightsMax: 3,
    flyDays:   [4, 5],
    type:      'round',
    dateFrom:  from,
    dateTo:    to,
  },
];
}

// ─── DEDUP: top N por destino (mismo patrón que merge.js) ────────────────────

function deduplicateTop(fares, target = 50) {
  // Ordenar por precio
  const sorted = [...fares].sort((a, b) => a.precio - b.precio);

  const cards    = [];
  const seenDest = new Set();

  // Pasada 1: 1 resultado por destino IATA (el más barato)
  for (const f of sorted) {
    if (!seenDest.has(f.destino)) {
      seenDest.add(f.destino);
      cards.push({ ...f, alternativo: '' });
      if (cards.length >= target) break;
    }
  }

  // Pasada 2: rellena con fechas alternativas si faltan cards
  if (cards.length < target) {
    const usedIds = new Set(cards.map(c => `${c.destino}_${c.salida}`));
    for (const f of sorted) {
      if (cards.length >= target) break;
      const id = `${f.destino}_${f.salida}`;
      if (!usedIds.has(id)) {
        usedIds.add(id);
        cards.push({ ...f, alternativo: '+fechas' });
      }
    }
  }

  return cards;
}

// ─── RYANAIR API ─────────────────────────────────────────────────────────────

const BASE = 'https://www.ryanair.com';

const HEADERS = {
  'User-Agent':      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept':          'application/json, text/plain, */*',
  'Accept-Language': 'es-ES,es;q=0.9',
  'Referer':         'https://www.ryanair.com/es/es/',
  'Origin':          'https://www.ryanair.com',
};

function addDays(dateStr, n) {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + n);
  return d.toISOString().split('T')[0];
}

async function getDestinations(origin) {
  try {
    const url = `${BASE}/api/views/locate/searchWidget/routes/es/airport/${origin}`;
    const r   = await fetch(url, { headers: HEADERS });
    if (!r.ok) return [];
    const data = await r.json();
    return data
      .filter(x => !x.notOperatedByRyanair)
      .map(x => x.arrivalAirport?.code || x.arrivalAirport?.iataCode)
      .filter(Boolean);
  } catch { return []; }
}

async function getFares(origin, dest, pattern) {
  const p = new URLSearchParams({
    departureAirportIataCode:  origin,
    arrivalAirportIataCode:    dest,
    outboundDepartureDateFrom: pattern.dateFrom,
    outboundDepartureDateTo:   pattern.dateTo,
    adultPaxCount:             1,
    market:                    'es-es',
    searchMode:                'ALL',
    outboundDepartureTimeFrom: '00:00',
    outboundDepartureTimeTo:   '23:59',
  });

  if (pattern.type === 'round') {
    p.set('inboundDepartureDateFrom', addDays(pattern.dateFrom, pattern.nightsMin));
    p.set('inboundDepartureDateTo',   addDays(pattern.dateTo,   pattern.nightsMax));
    p.set('durationFrom', pattern.nightsMin);
    p.set('durationTo',   pattern.nightsMax);
    p.set('inboundDepartureTimeFrom', '00:00');
    p.set('inboundDepartureTimeTo',   '23:59');
  }

  const endpoint = pattern.type === 'oneway'
    ? `${BASE}/api/farfnd/v4/oneWayFares?${p}`
    : `${BASE}/api/farfnd/v4/roundTripFares?${p}`;

  try {
    const r = await fetch(endpoint, { headers: HEADERS });
    if (!r.ok) return [];
    const json = await r.json();
    return json.fares || [];
  } catch { return []; }
}

const CITY_MAP = {
  MAD:'Madrid',BCN:'Barcelona',AGP:'Málaga',PMI:'Palma',ALC:'Alicante',
  SVQ:'Sevilla',VLC:'Valencia',BIO:'Bilbao',ACE:'Lanzarote',TFS:'Tenerife Sur',
  LPA:'Gran Canaria',FUE:'Fuerteventura',IBZ:'Ibiza',FCO:'Roma',MXP:'Milán',
  VCE:'Venecia',NAP:'Nápoles',BGY:'Bergamo',PSA:'Pisa',BLQ:'Bolonia',
  CDG:'París',ORY:'París Orly',LYS:'Lyon',MRS:'Marsella',NCE:'Niza',
  LHR:'Londres',LGW:'Londres Gatwick',STN:'Londres Stansted',LTN:'Luton',
  EDI:'Edimburgo',MAN:'Mánchester',AMS:'Ámsterdam',BRU:'Bruselas',CRL:'Charleroi',
  BER:'Berlín',FRA:'Fráncfort',MUC:'Múnich',HAM:'Hamburgo',CGN:'Colonia',
  VIE:'Viena',ZRH:'Zúrich',GVA:'Ginebra',WAW:'Varsovia',KTW:'Katowice',WRO:'Wroclaw',
};

const COUNTRY_MAP = {
  PT:'Portugal',IT:'Italia',FR:'Francia',GB:'Reino Unido',DE:'Alemania',
  NL:'Países Bajos',BE:'Bélgica',AT:'Austria',CH:'Suiza',PL:'Polonia',
  HU:'Hungría',GR:'Grecia',IE:'Irlanda',MA:'Marruecos',RO:'Rumanía',ES:'España',
  HR:'Croacia',TR:'Turquía',MT:'Malta',
};

function guessCountry(iata) {
  const map = {
    LIS:'PT',OPO:'PT',FAO:'PT',FCO:'IT',MXP:'IT',VCE:'IT',NAP:'IT',BGY:'IT',
    CDG:'FR',ORY:'FR',LYS:'FR',MRS:'FR',NCE:'FR',LHR:'GB',LGW:'GB',STN:'GB',
    LTN:'GB',EDI:'GB',MAN:'GB',AMS:'NL',BRU:'BE',CRL:'BE',BER:'DE',FRA:'DE',
    MUC:'DE',HAM:'DE',CGN:'DE',VIE:'AT',ZRH:'CH',GVA:'CH',WAW:'PL',KTW:'PL',
    WRO:'PL',MAD:'ES',BCN:'ES',AGP:'ES',PMI:'ES',SVQ:'ES',
  };
  return map[iata] || '??';
}

function mapFare(f, origin, pattern) {
  const iata    = f.outbound?.arrivalAirport?.iataCode || f.arrivalAirport?.iataCode || '???';
  const depDate = f.outbound?.departureDate || f.departureDate;
  const retDate = f.inbound?.departureDate  || null;
  const price   = f.summary?.price?.value ?? f.outbound?.price?.value ?? f.price?.value ?? 0;

  // Noches: comparar solo fechas, sin horas
  const nights = (retDate && depDate)
    ? Math.round(
        (new Date(retDate.split('T')[0]) - new Date(depDate.split('T')[0])) / 86400000
      )
    : null;

  // País: extraer directamente de la API, fallback al mapa manual
  const ccApi = f.outbound?.arrivalAirport?.countryCode
             || f.arrivalAirport?.countryCode
             || guessCountry(iata);
  const pais  = COUNTRY_MAP[ccApi] || ccApi || '??';

  return {
    origen:      origin,
    destino:     iata,
    ciudad:      f.outbound?.arrivalAirport?.name || CITY_MAP[iata] || iata,
    pais,
    precio:      price,
    salida:      depDate,
    vuelta:      retDate || '',
    noches:      nights ?? '',
    patron:      pattern.label,
    tipo:        pattern.type === 'oneway' ? 'Solo ida' : 'Ida y vuelta',
    alternativo: '',
    capturado:   new Date().toISOString().split('T')[0],
  };
}

// ─── SCRAPER PRINCIPAL ───────────────────────────────────────────────────────

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function scrapeAll() {
  const patterns = getPatterns();
  const results  = [];
  const BS       = 5;

  for (const origin of ORIGINS) {
    console.log(`\n→ ${origin}`);
    const dests = await getDestinations(origin);
    console.log(`  ${dests.length} destinos`);

    for (const pattern of patterns) {
      console.log(`  [${pattern.label}]`);
      const fares = [];

      for (let i = 0; i < dests.length; i += BS) {
        const batch = dests.slice(i, i + BS);
        const batchResults = await Promise.all(
          batch.map(d => getFares(origin, d, pattern))
        );
        batchResults.forEach(fs => fares.push(...fs));
        await sleep(1000);
      }

      const mapped = fares
        .map(f => mapFare(f, origin, pattern))
        .filter(f => f.precio > 0)
        .filter(f => {
          if (!pattern.flyDays?.length) return true;
          return pattern.flyDays.includes(new Date(f.salida).getDay());
        });

      // Top 50 deduplicado por destino
      const top = deduplicateTop(mapped, TOP_N);
      console.log(`    ${mapped.length} resultados → ${top.length} top${TOP_N}`);
      results.push(...top);
    }

    await sleep(2000);
  }

  return results;
}

// ─── GOOGLE SHEETS ───────────────────────────────────────────────────────────

async function writeToSheet(rows) {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  console.log('SECRET length:', raw?.length);
  console.log('SECRET start:', raw?.substring(0, 50));
  let credentials;
  try {
    credentials = JSON.parse(raw);
  } catch {
    // Intentar base64
    const decoded = Buffer.from(raw, 'base64').toString('utf-8');
    credentials = JSON.parse(decoded);
  }

  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });

  const sheets = google.sheets({ version: 'v4', auth });

  // 1. Limpiar hoja
  await sheets.spreadsheets.values.clear({
    spreadsheetId: SHEET_ID,
    range:         `${SHEET_NAME}!A2:Z`,
  });

  if (rows.length === 0) {
    console.log('Sin resultados, hoja limpiada.');
    return;
  }

  // 2. Cabecera
  const header = ['Origen','Destino','Ciudad','País','Precio (€)','Salida','Vuelta','Noches','Patrón','Tipo','Alternativo','Capturado'];
  await sheets.spreadsheets.values.update({
    spreadsheetId:    SHEET_ID,
    range:            `${SHEET_NAME}!A1`,
    valueInputOption: 'RAW',
    requestBody: { values: [header] },
  });

  // 3. Datos en batches de 500
  const data = rows.map(r => [
    r.origen, r.destino, r.ciudad, r.pais, r.precio,
    r.salida, r.vuelta, r.noches, r.patron, r.tipo, r.alternativo, r.capturado,
  ]);

  const BATCH = 500;
  for (let i = 0; i < data.length; i += BATCH) {
    await sheets.spreadsheets.values.append({
      spreadsheetId:    SHEET_ID,
      range:            `${SHEET_NAME}!A2`,
      valueInputOption: 'RAW',
      requestBody: { values: data.slice(i, i + BATCH) },
    });
    await sleep(500);
  }

  console.log(`\n✓ ${rows.length} filas escritas en "${SHEET_NAME}"`);
}

// ─── ENTRY POINT ─────────────────────────────────────────────────────────────

(async () => {
  console.log('=== Ryanair Daily Scraper ===');
  console.log(new Date().toISOString());

  try {
    const results = await scrapeAll();
    console.log(`\nTotal resultados: ${results.length}`);
    await writeToSheet(results);
  } catch (err) {
    console.error('Error:', err);
    process.exit(1);
  }
})();
