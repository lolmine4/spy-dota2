// Builds public/data/pool.json: every hero, plus every item sold in the in-game shop.
// Names come from Valve's dota2.com datafeed, the shop layout from the game files
// (mirrored by dotabuff/d2vpkr). Run `npm run build-data` after a patch adds heroes or items.
import { mkdir, writeFile } from 'node:fs/promises';

const FEED = 'https://www.dota2.com/datafeed';
const SHOPS_URL = 'https://raw.githubusercontent.com/dotabuff/d2vpkr/master/dota/scripts/shops.txt';
const CDN = 'https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react';
const OUT = new URL('../public/data/pool.json', import.meta.url);

// Main shop tabs plus the secret shop. Side shops repeat these; pregame and event tabs are not real shops.
const SHOP_TABS = [
  'consumables', 'attributes', 'weapons_armor', 'misc', 'secretshop',
  'basics', 'support', 'magics', 'defense', 'weapons', 'artifacts',
];
const ATTRS = ['str', 'agi', 'int', 'all'];

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

async function getText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.text();
}

// shops.txt is Valve KeyValues: "tab" { "item" "item_x" ... }. Only two levels deep, so a line scan is enough.
function parseShops(text) {
  const tabs = {};
  let depth = 0;
  let pending = null;
  let tab = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\/\/.*$/, '').trim();
    if (!line) continue;
    if (line === '{') {
      depth++;
      if (depth === 2) tab = pending;
      continue;
    }
    if (line === '}') {
      depth--;
      continue;
    }
    const m = line.match(/^"([^"]+)"\s*(?:"([^"]*)")?/);
    if (!m) continue;
    if (m[2] === undefined) pending = m[1];
    else if (depth === 2 && m[2].startsWith('item_')) (tabs[tab] ??= []).push(m[2]);
  }
  return tabs;
}

async function imageMissing(url) {
  const res = await fetch(url, { method: 'HEAD' });
  return !res.ok;
}

async function dropMissingImages(list, folder) {
  const missing = [];
  for (let i = 0; i < list.length; i += 16) {
    const batch = list.slice(i, i + 16);
    const flags = await Promise.all(batch.map((x) => imageMissing(`${CDN}/${folder}/${x.id}.png`)));
    batch.forEach((x, j) => flags[j] && missing.push(x));
  }
  if (missing.length) console.warn(`no ${folder} image, skipped:`, missing.map((x) => x.id).join(', '));
  return list.filter((x) => !missing.includes(x));
}

const [heroFeed, itemFeed, shopsText] = await Promise.all([
  getJson(`${FEED}/herolist?language=english`),
  getJson(`${FEED}/itemlist?language=english`),
  getText(SHOPS_URL),
]);

const heroes = heroFeed.result.data.heroes
  .map((h) => ({
    id: h.name.replace('npc_dota_hero_', ''),
    name: h.name_english_loc,
    attr: ATTRS[h.primary_attr] ?? 'all',
  }))
  .sort((a, b) => a.name.localeCompare(b.name));

const itemNames = new Map(itemFeed.result.data.itemabilities.map((i) => [i.name, i.name_english_loc]));
const shops = parseShops(shopsText);
const seen = new Set();
const items = [];
for (const tab of SHOP_TABS) {
  for (const key of shops[tab] ?? []) {
    const name = itemNames.get(key);
    if (seen.has(key) || !name) continue;
    seen.add(key);
    items.push({ id: key.replace('item_', ''), name });
  }
}

const pool = {
  updated: new Date().toISOString().slice(0, 10),
  heroes: await dropMissingImages(heroes, 'heroes'),
  items: await dropMissingImages(items, 'items'),
};

await mkdir(new URL('.', OUT), { recursive: true });
await writeFile(OUT, JSON.stringify(pool, null, 1) + '\n');
console.log(`pool.json: ${pool.heroes.length} heroes, ${pool.items.length} items`);
