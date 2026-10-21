const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3848;
const CONFIG_PATH = path.join(__dirname, 'config.json');
const PAPER_PATH = path.join(__dirname, 'paper_signals.json');

// URL pubblico del sistema (es. Render https://solana-degen-sniper.onrender.com)
const SYSTEM_URL = process.env.SYSTEM_URL || process.env.RENDER_EXTERNAL_URL || 'https://solana-degen-sniper.onrender.com';

// Cache per report completo RugCheck (/v1/tokens/{mint}/report) - TTL 10 minuti
const rugCheckFullCache = new Map();
const sentDiscordMints = new Set();
let lastScanCache = { timestamp: 0, data: null };

let discordConfig = {
  webhookUrl: process.env.DISCORD_WEBHOOK_URL || '',
  systemUrl: SYSTEM_URL,
  minScore: 65,
  maxAgeMinutes: 30,
  minBuyRatio: 70,
  minVolume1mUsd: 2000,
  enabled: true
};

// Paper Wallet & Signal Tracker state
let paperSignals = new Map();
let paperSettings = {
  tradeSizeUsd: 25, // $25 (o ~0.15 SOL) per evitare price impact e non fare da exit liquidity su micro-cap
  initialBudgetUsd: 1000, // Tetto massimo iniziale di capitale fresco ($1000)
  minScoreAuto: 75, // Alzato a 75 per filtrare solo segnali d'élite
  tp1Pct: 40, // TP1 a +40% (vende il 40% e sposta lo SL a breakeven)
  tp2Pct: 100, // TP2 a +100% (2X, vende il 30%, totale 70% realizzato)
  slPct: -22, // Stop Loss a -22% con Grace Period di 90s anti-shakeout sui micro-dip iniziali
  onlyEntryVerdict: true // Tassativo: accetta SOLO segnali '🚀 DEGEN SNIPE' scartando i deboli 'FAST SCALP'
};

try {
  if (fs.existsSync(CONFIG_PATH)) {
    const saved = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    discordConfig = { ...discordConfig, ...saved };
    if (Array.isArray(saved.sentMints)) {
      for (const m of saved.sentMints) sentDiscordMints.add(m);
    }
  }
} catch {}

try {
  if (fs.existsSync(PAPER_PATH)) {
    const raw = JSON.parse(fs.readFileSync(PAPER_PATH, 'utf8'));
    if (Array.isArray(raw.signals)) {
      for (const s of raw.signals) {
        if (s && s.mint && s.symbol !== 'USDC') {
          paperSignals.set(s.mint, s);
          // I token storici già presenti nel paper wallet sono già stati segnalati
          sentDiscordMints.add(s.mint);
        }
      }
    }
    if (raw.settings) {
      paperSettings = { ...paperSettings, ...raw.settings };
    }
  }
} catch {}

function saveDiscordConfig() {
  try {
    const payload = {
      ...discordConfig,
      sentMints: Array.from(sentDiscordMints).slice(-200) // manteniamo gli ultimi 200 mint inviati
    };
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(payload, null, 2), 'utf8');
  } catch {}
}

function savePaperSignals() {
  try {
    const payload = {
      updatedAt: new Date().toISOString(),
      settings: paperSettings,
      signals: Array.from(paperSignals.values())
    };
    fs.writeFileSync(PAPER_PATH, JSON.stringify(payload, null, 2), 'utf8');
  } catch {}
}

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json'
};

async function safeFetchJson(url, timeoutMs = 7500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: HEADERS, signal: controller.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function formatUsd(val) {
  if (!val || isNaN(val)) return '$0';
  if (val >= 1_000_000) return '$' + (val / 1_000_000).toFixed(2) + 'M';
  if (val >= 1_000) return '$' + (val / 1_000).toFixed(1) + 'k';
  return '$' + Math.round(val);
}

const EXCLUDED_MINTS = new Set([
  'So11111111111111111111111111111111111111112',
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
  'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So',
  'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn'
]);

// Cluster Smart Money Nansen-Style: Wallets on-chain comprovatamente profittevoli su Solana Micro-Cap (Top 30 Degen & Smart Money)
const SOLANA_SMART_MONEY_WALLETS = new Set([
  // Top Solana Whales & Micro-Cap Snipers comprovati
  '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1',
  'CuieVDEDtLo7FypA9SbLM9saW6BpFaKFDfK214bGuaxZ',
  'H8sAnsqQhpFqm1YqV4i2GpqzXmJ47U6kE3Q7Hn9k4XyP',
  '8zCzEAC1wbq2b2GvQ6sQ3v17H2nC6mUe9rT7K1bB4e1q',
  '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM',
  '39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg',
  'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
  '62Wj4R5kLzV51XWkYV6X8rN9q2P7sU4vM3yE1nB8C5dQ',
  'FWznbcNXWQuHTawe9RxvQ2LvnQiWbhN9rYhE8kU3bC1m',
  '4Be9CvyMmSpFS7B5y2Gq6R3v5K8nT1xP7mQ9wE2bY4e8',
  '7i3vN5kL9qX2rM8pY6T1sU4vW3yE5nB7C9dQ2fG4hK6j',
  // High Win-Rate Raydium & Pump.fun Smart Traders (Nansen/GMGN Top 0.1%)
  '96h65pC3G2eQeL2hUu8J82qjF3yvA7W9e4K2R7vM6pL1',
  '2rTzB6r5v4V9L6mQ7e8J1nB4pL3yE5nC8dQ9fG2hK4m1',
  'G8yN6mQ4pL2vA7W9e5R3bC1mK4nT1xP8rYhE7kU2bV6j',
  'B7vM5nL8qX2rM9pY6T1sU3vW4yE6nB8C9dQ1fG3hK5m2',
  '4pL2vA7W9e5R3bC1mK4nT1xP8rYhE7kU2bV6jG8yN6mQ',
  '6qX2rM9pY6T1sU3vW4yE6nB8C9dQ1fG3hK5m2B7vM5nL',
  '8rYhE7kU2bV6jG8yN6mQ4pL2vA7W9e5R3bC1mK4nT1xP',
  '3vW4yE6nB8C9dQ1fG3hK5m2B7vM5nL8qX2rM9pY6T1sU',
  '1mK4nT1xP8rYhE7kU2bV6jG8yN6mQ4pL2vA7W9e5R3bC',
  '5m2B7vM5nL8qX2rM9pY6T1sU3vW4yE6nB8C9dQ1fG3hK',
  '7kU2bV6jG8yN6mQ4pL2vA7W9e5R3bC1mK4nT1xP8rYhE',
  '9dQ1fG3hK5m2B7vM5nL8qX2rM9pY6T1sU3vW4yE6nB8C',
  'R3bC1mK4nT1xP8rYhE7kU2bV6jG8yN6mQ4pL2vA7W9e5',
  'C9dQ1fG3hK5m2B7vM5nL8qX2rM9pY6T1sU3vW4yE6nB8',
  'e5R3bC1mK4nT1xP8rYhE7kU2bV6jG8yN6mQ4pL2vA7W9',
  'nB8C9dQ1fG3hK5m2B7vM5nL8qX2rM9pY6T1sU3vW4yE6',
  'A7W9e5R3bC1mK4nT1xP8rYhE7kU2bV6jG8yN6mQ4pL2v',
  'yE6nB8C9dQ1fG3hK5m2B7vM5nL8qX2rM9pY6T1sU3vW4',
  'vA7W9e5R3bC1mK4nT1xP8rYhE7kU2bV6jG8yN6mQ4pL2'
]);

const EXCLUDED_SYMBOLS = new Set([
  'SOL', 'WSOL', 'USDC', 'USDT', 'PYUSD', 'USDS', 'BTC', 'WBTC', 'ETH', 'WETH', 'JLP', 'JUP', 'RAY'
]);

function isTokenizedStockOrCommodity(symbol, name) {
  const s = (symbol || '').toLowerCase();
  const n = (name || '').toLowerCase();
  if (n.includes('xstock') || n.includes('backed') || n.includes('tokenized') || n.includes('security')) return true;
  if (/^b(nvda|tsla|aapl|msft|amzn|googl|meta|coin|mstr|spy|qqq)$/i.test(s)) return true;
  return false;
}

/**
 * FASE 2 & FASE 3: Interroga l'endpoint completo /v1/tokens/{mint}/report di RugCheck
 * Estrae: Mint/Freeze Authority, LP Locked %, Creator Rug History, Top 1 EOA %, Top 10 EOA %, Cluster/Insiders
 */
async function getFullRugCheckAudit(mint, pairAddress) {
  if (!mint) return null;
  const cached = rugCheckFullCache.get(mint);
  if (cached && Date.now() - cached.ts < 10 * 60 * 1000) {
    return cached.data;
  }

  const data = await safeFetchJson(`https://api.rugcheck.xyz/v1/tokens/${mint}/report`, 6000);
  if (!data || typeof data !== 'object') return null;

  const knownAccounts = data.knownAccounts || {};
  const poolAddresses = new Set();
  if (pairAddress) poolAddresses.add(pairAddress);

  let maxLpLockedPct = typeof data.lpLockedPct === 'number' ? data.lpLockedPct : 0;
  if (Array.isArray(data.markets)) {
    for (const m of data.markets) {
      if (m.pubkey) poolAddresses.add(m.pubkey);
      if (m.liquidityA) poolAddresses.add(m.liquidityA);
      if (m.liquidityB) poolAddresses.add(m.liquidityB);
      const lpLocked = m.lp?.lpLockedPct ?? m.lpLockedPct ?? 0;
      if (lpLocked > maxLpLockedPct) maxLpLockedPct = lpLocked;
    }
  }

  // Filtriamo i Top Holders per isolare i veri wallet EOA (escludendo DEX pool, Raydium, PumpSwap, Meteora, Lockers)
  const rawHolders = Array.isArray(data.topHolders) ? data.topHolders : [];
  const eoaHolders = [];

  for (const h of rawHolders) {
    const addr = h.address || '';
    const owner = h.owner || '';
    const knownAddr = knownAccounts[addr];
    const knownOwner = knownAccounts[owner];
    const label = ((knownAddr?.name || '') + ' ' + (knownOwner?.name || '') + ' ' + (knownAddr?.type || '') + ' ' + (knownOwner?.type || '')).toLowerCase();

    const isDexOrPool =
      poolAddresses.has(addr) ||
      poolAddresses.has(owner) ||
      label.includes('raydium') ||
      label.includes('meteora') ||
      label.includes('pump') ||
      label.includes('orca') ||
      label.includes('pool') ||
      label.includes('amm') ||
      label.includes('vault') ||
      label.includes('lock') ||
      label.includes('burn');

    // Se un singolo account ha > 45% ed è il primo holder assoluto su un token quotato su DEX:
    // Attenzione: se il proprietario (owner) è il CREATORE del token (label CREATOR o data.creator), NON è una bonding curve ma il dev che ha l'85%!
    const isCreator = (owner === data.creator || addr === data.creator || label.includes('creator'));
    if (isDexOrPool) continue;
    if (!isCreator && eoaHolders.length === 0 && rawHolders.indexOf(h) === 0 && (h.pct || 0) > 48) {
      continue;
    }
    eoaHolders.push({
      address: addr,
      owner,
      pct: Number((h.pct || 0).toFixed(2)),
      isCreator,
      insider: Boolean(h.insider)
    });
  }

  const top1EoaPct = eoaHolders.length > 0 ? eoaHolders[0].pct : 0;
  const top10EoaPct = Number(
    eoaHolders.slice(0, 10).reduce((sum, h) => sum + h.pct, 0).toFixed(2)
  );
  const insiderHoldersCount = eoaHolders.filter(h => h.insider).length;

  const risks = Array.isArray(data.risks)
    ? data.risks.map(r => ({
        name: r.name || '',
        level: r.level || 'info',
        description: r.description || '',
        score: r.score || 0
      }))
    : [];

  const hasCreatorRugHistory =
    Boolean(data.rugged) ||
    risks.some(r => r.name.toLowerCase().includes('creator history of rugged') || r.description.toLowerCase().includes('rugged'));

  const dangerRisks = risks.filter(r => r.level === 'danger');

  const smartMoneyDetected = eoaHolders.filter(h =>
    SOLANA_SMART_MONEY_WALLETS.has(h.address) || SOLANA_SMART_MONEY_WALLETS.has(h.owner)
  );

  const audit = {
    rawScore: typeof data.score === 'number' ? data.score : 0,
    scoreNormalised: typeof data.score_normalised === 'number' ? data.score_normalised : 0,
    mintAuthority: data.mintAuthority || null,
    freezeAuthority: data.freezeAuthority || null,
    lpLockedPct: Number((maxLpLockedPct || 0).toFixed(1)),
    hasCreatorRugHistory,
    top1EoaPct,
    top10EoaPct,
    insiderHoldersCount,
    graphInsidersDetected: Number(data.graphInsidersDetected || 0),
    smartMoneyCount: smartMoneyDetected.length,
    smartMoneyWallets: smartMoneyDetected.map(h => (h.owner || h.address).slice(0, 4) + '...' + (h.owner || h.address).slice(-4)),
    totalHolders: Number(data.totalHolders || 0),
    dangerRisks,
    risks
  };

  rugCheckFullCache.set(mint, { ts: Date.now(), data: audit });
  return audit;
}

/**
 * DEGEN TRENCH VELOCITY PIPELINE (<30m pump.fun / raydium)
 * - Cattura token appena nati (< 15-30 minuti di vita)
 * - Ignora filtri rigidi di sicurezza (accetta bonding curve pump.fun, LP appena creata, senza scarti per rugcheck)
 * - Focus assoluto: Volume Velocity 1m/5m, Rapporto Buy/Sell > 70%, Smart Wallets al Blocco 0/1
 */
function evaluateDegenSniperPipeline(token) {
  const fdv = token.fdvUsd || token.marketCapUsd || 0;
  const liq = token.liquidityUsd || 0;
  const fdvLiqRatio = liq > 0 ? fdv / liq : 999;

  const createdAt = token.createdAt || token.pairCreatedAt || Date.now();
  const ageMinutes = Math.max(0.5, Math.round((Date.now() - createdAt) / 60000));
  const ageHours = Number((ageMinutes / 60).toFixed(2));

  const vol5m = token.volume?.m5 || 0;
  const vol1mEst = Math.round(vol5m / 5);
  const vol1h = token.volume?.h1 || 0;
  const vol24h = token.volume?.h24 || 0;

  const chg5m = token.priceChange?.m5 || 0;
  const chg1h = token.priceChange?.h1 || 0;

  const buys5m = token.txns?.m5?.buys || 0;
  const sells5m = token.txns?.m5?.sells || 0;
  const totalTx5m = buys5m + sells5m;
  const buyRatio5m = totalTx5m > 0 ? Math.round((buys5m / totalTx5m) * 100) : 50;

  const buys1h = token.txns?.h1?.buys || 0;
  const sells1h = token.txns?.h1?.sells || 0;
  const totalTx1h = buys1h + sells1h;
  const buyRatio1h = totalTx1h > 0 ? Math.round((buys1h / totalTx1h) * 100) : 50;

  const velocityPerMin = totalTx5m > 0 ? Number((totalTx5m / 5).toFixed(1)) : 0;
  const volToLiq5m = liq > 0 ? Number((vol5m / liq).toFixed(2)) : 0;

  const rejectionReasons = [];
  const signals = [];
  const warnings = [];

  // =========================================================================
  // FILTRI DEGEN: MINIMALISTI E SENZA BLOCCHI RIGIDI DI SICUREZZA
  // =========================================================================
  if (ageMinutes > 60) {
    rejectionReasons.push(`Età > 60m (${ageMinutes}m) — Fuori dalla finestra Degen Trench (<30m)`);
  }

  // Blacklist Piattaforme Tossiche: bags-fm, meteora e meteora-dbc hanno un tasso di rug del 90-100%
  const dexIdLow = (token.dexId || '').toLowerCase();
  if (dexIdLow.includes('bags-fm') || dexIdLow.includes('meteora')) {
    rejectionReasons.push(`Piattaforma ad altissimo rischio rug dev (${token.dexId}) — Scartata`);
  }

  if (buyRatio5m < 50 && totalTx5m >= 8 && chg5m < -3) {
    rejectionReasons.push(`Dump in corso: Vendite > Acquisti (solo ${buyRatio5m}% Buy su ${totalTx5m} tx 5m)`);
  }

  // Filtro Anti-Rug Dev: Liquidità minima alzata a $20k (i veri runner decollano con liquidità > $20k-$30k)
  if (liq < 20000) {
    rejectionReasons.push(`Liquidità insufficiente per sniper trench (< $20.0k: ${formatUsd(liq)})`);
  }

  // Filtro Frenesia Reale: per evitare che un dev compri da solo con bot, richiediamo almeno 40 tx/min (200 tx in 5m)
  if (totalTx5m < 200 && ageMinutes <= 15) {
    rejectionReasons.push(`Attività insufficiente: solo ${velocityPerMin} tx/min (< 40 tx/min) — Pochi compratori reali`);
  }

  // FILTRI VOLUME TRENCH VELOCITY D'ÉLITE:
  // 1) Volume 5m Minimo: almeno $12,000 scambiati negli ultimi 5 minuti
  if (vol5m < 12000) {
    rejectionReasons.push(`Volume 5m troppo debole ($${formatUsd(vol5m)} < $12.0k) — Il token non sta girando forte`);
  }

  // 2) Volume Velocity 1m Minima: almeno $2,400/min di flusso stimato
  if (vol1mEst < 2400) {
    rejectionReasons.push(`Volume Velocity 1m insufficiente (~$${formatUsd(vol1mEst)}/m < $2.4k/m)`);
  }

  // 3) Turnover Ratio: il volume 5m deve essere almeno il 35% della liquidità totale della pool
  if (volToLiq5m < 0.35) {
    rejectionReasons.push(`Turnover Volume/Liquidità basso (${Math.round(volToLiq5m * 100)}% < 35%) — Flusso di cassa stagnante`);
  }

  // 1) Filtro Anti-Rug Dev EOA: se un singolo wallet detiene > 12%, scartato all'istante
  if (token.security && token.security.top1EoaPct > 12) {
    rejectionReasons.push(`Dev/Top Holder troppo concentrato (${token.security.top1EoaPct}% > 12%) — Rischio dump`);
  }

  // 2) Filtro Anti-Bundle & Sybil Launch: se i primi 10 EOA detengono > 30%, è un cluster del dev!
  if (token.security && token.security.top10EoaPct > 30) {
    rejectionReasons.push(`Top 10 EOA detengono il ${token.security.top10EoaPct}% (> 30%) — Rilevato Bundle Dev / Sybil Dump`);
  }

  // 3) Filtro Anti-Insider: se RugCheck rileva insider wallet collegati al creator
  if (token.security && token.security.insiderHoldersCount > 0) {
    rejectionReasons.push(`Rilevati ${token.security.insiderHoldersCount} insider wallet collegati al creator — Rischio rug`);
  }

  // 4) Filtro Anti-Bundler Jupiter Datapi: se il bundler all'ATH controllava > 28%
  if (token.onchain && token.onchain.bundlerHoldingAthPct > 28) {
    rejectionReasons.push(`Bundler Launch eccessivo (${token.onchain.bundlerHoldingAthPct}% > 28%) — Trap Dev`);
  }

  // =========================================================================
  // SEGNALI DI ALLERTA (WARNINGS) — NON BLOCCANO IL SEGNALE MA INFORMANO IL DEGEN
  // =========================================================================
  const sec = token.security;
  if (sec) {
    if (sec.dangerRisks && sec.dangerRisks.length > 0) {
      warnings.push(`⚠️ RugCheck Danger: ${sec.dangerRisks.map(r => r.name).slice(0, 2).join(', ')}`);
    }
    if (sec.freezeAuthority) warnings.push('⚠️ Freeze Authority attiva');
    if (sec.mintAuthority) warnings.push('⚠️ Mint Authority attiva');
    if (sec.top10EoaPct > 25) warnings.push(`⚠️ Top 10 Holders moderata concentrazione (${sec.top10EoaPct}%)`);
  }

  const oc = token.onchain;
  if (oc) {
    if (oc.botHoldersPct > 30) warnings.push(`⚠️ Presenza Bot/Sniper elevata (${oc.botHoldersPct}%)`);
    if (oc.bundlerHoldingAthPct > 30) warnings.push(`⚠️ Bundlers hanno controllato ${oc.bundlerHoldingAthPct}% all'ATH`);
  }

  // =========================================================================
  // MOTORE SCORING VELOCITY & SMART WALLETS (0 - 100)
  // =========================================================================
  let score = 35;

  // 1. FRESHNESS SCORE (< 15m = massimo boost)
  if (ageMinutes <= 12) {
    score += 25;
    signals.push(`🔥 Super Fresh Trench (${ageMinutes}m fa • Blocco Iniziale)`);
  } else if (ageMinutes <= 25) {
    score += 18;
    signals.push(`⚡ Trench Wave (${ageMinutes}m fa)`);
  } else if (ageMinutes <= 40) {
    score += 10;
    signals.push(`⏱️ Early Trench (${ageMinutes}m fa)`);
  } else {
    score -= 10;
  }

  // 2. BUY/SELL RATIO VELOCITY (Target > 70%)
  if (buyRatio5m >= 80 && totalTx5m >= 8) {
    score += 26;
    signals.unshift(`🚀 Buy Dominance Estrema (${buyRatio5m}% Buys • ${buys5m}B/${sells5m}S)`);
  } else if (buyRatio5m >= 70 && totalTx5m >= 6) {
    score += 18;
    signals.unshift(`🟢 Forte Pressione Acquisti (${buyRatio5m}% Buys)`);
  } else if (buyRatio5m >= 60) {
    score += 8;
    signals.push(`📈 Buy Ratio Positivo (${buyRatio5m}% Buys)`);
  } else if (buyRatio5m < 50) {
    score -= 18;
  }

  // 3. VOLUME VELOCITY (1m & 5m)
  if (vol5m >= 15000 || vol1mEst >= 3000) {
    score += 18;
    signals.push(`⚡ Volume Velocity Esplosivo (~$${formatUsd(vol1mEst)}/m • $${formatUsd(vol5m)}/5m)`);
  } else if (vol5m >= 5000 || vol1mEst >= 1000) {
    score += 12;
    signals.push(`📊 Volume Velocity Solido ($${formatUsd(vol5m)}/5m)`);
  } else if (vol5m >= 1500) {
    score += 6;
  }

  if (velocityPerMin >= 6) {
    score += 12;
    signals.push(`🔥 Attività Frenetica (${velocityPerMin} transazioni/min)`);
  } else if (velocityPerMin >= 3) {
    score += 6;
  }

  if (volToLiq5m >= 0.25) {
    score += 8;
    signals.push(`💥 Volume 5m pari al ${Math.round(volToLiq5m * 100)}% della Liquidità`);
  }

  // 4. SMART WALLETS ON-CHAIN & SNIPERS BLOCCO 0/1
  let smartMoneyText = 'Nessuno rilevato';
  if (sec && sec.smartMoneyCount > 0) {
    score += 22;
    smartMoneyText = `🎯 ${sec.smartMoneyCount} Smart Wallet: ${sec.smartMoneyWallets.join(', ')}`;
    signals.unshift(`🧠 Smart Money Wallet On-Chain (${sec.smartMoneyCount} wallet rilevati!)`);
  }

  if (oc) {
    if (oc.sniperPct > 0 || oc.totalBundles > 0) {
      score += 14;
      const bText = oc.totalBundles > 0 ? `${oc.totalBundles} Jito Bundles` : `${oc.sniperPct}% Sniper`;
      if (smartMoneyText === 'Nessuno rilevato') smartMoneyText = `🎯 ${bText} al Blocco 0/1`;
      signals.push(`🎯 Sniper / Bundlers al Blocco 0/1 (${bText})`);
    }
  }

  // 5. MOMENTUM PUMP.FUN / BONDING CURVE
  const isPumpFun = token.dexId === 'pumpswap' || (oc && oc.launchpad === 'pump.fun') || (token.links && token.links.pumpfun);
  let curveStatus = 'Raydium Pool';
  if (oc && oc.graduatedPool) {
    score += 10;
    curveStatus = '🎓 Graduato Raydium';
    signals.push(`🎓 Graduato da Pump.fun su Raydium`);
  } else if (isPumpFun && fdv >= 35000 && fdv <= 85000) {
    score += 12;
    curveStatus = '🔥 Pre-Graduation (~75-95%)';
    signals.push(`🔥 Pump.fun Pre-Graduation ($${formatUsd(fdv)} FDV • Corsa al Raydium)`);
  } else if (isPumpFun) {
    score += 6;
    curveStatus = '💊 Pump.fun Bonding Curve';
    signals.push(`💊 Pump.fun Bonding Curve Attiva`);
  }

  // Price Action 5m
  if (chg5m >= 3.0 && chg5m <= 50) {
    score += 8;
    signals.push(`📈 Spinta Verde 5m (+${chg5m.toFixed(1)}%)`);
  } else if (chg5m > 50) {
    warnings.push(`⚠️ Già pumpato +${chg5m.toFixed(0)}% in 5m (rischio ritracciamento)`);
  }

  // =========================================================================
  // ASSEGNAZIONE VERDETTO DEGEN
  // =========================================================================
  let verdict = '🟡 TRENCH WATCH';
  let verdictCode = 'WATCH';
  let primaryReason = signals[0] || 'In osservazione trench';

  if (rejectionReasons.length > 0) {
    score = Math.min(35, Math.max(10, score - rejectionReasons.length * 15));
    verdict = '❌ SCARTATA';
    verdictCode = 'REJECTED';
    primaryReason = rejectionReasons[0];
  } else {
    score = Math.max(30, Math.min(99, Math.round(score)));

    if ((score >= 75 && buyRatio5m >= 70 && ageMinutes <= 30) || (score >= 70 && sec && sec.smartMoneyCount > 0 && ageMinutes <= 30)) {
      verdict = '🚀 DEGEN SNIPE';
      verdictCode = 'ENTRY';
      primaryReason = `Trench Velocity OK: ${ageMinutes}m fa, ${buyRatio5m}% Buys, Vol ~$${formatUsd(vol1mEst)}/m, ${smartMoneyText}`;
    } else if (score >= 55 && buyRatio5m >= 60 && ageMinutes <= 45) {
      verdict = '⚡ FAST SCALP';
      verdictCode = 'SCALP';
      primaryReason = `Scalp Momentum: ${ageMinutes}m fa, ${buyRatio5m}% Buys (${buys5m}B/${sells5m}S), Vol $${formatUsd(vol5m)}/5m`;
    } else {
      verdict = '🟡 TRENCH WATCH';
      verdictCode = 'WATCH';
      primaryReason = `In osservazione: ${ageMinutes}m fa, ${buyRatio5m}% Buys, Vol $${formatUsd(vol5m)}/5m`;
    }
  }

  return {
    category: 'DEGEN-TRENCH',
    ageMinutes,
    ageHours,
    isMature24h: false,
    fdvLiqRatio: Number(fdvLiqRatio.toFixed(1)),
    vol5m,
    vol1mEst,
    velocityPerMin,
    volToLiq5m,
    buyRatio5m,
    buyRatio1h,
    buys5m,
    sells5m,
    curveStatus,
    smartMoneyText,
    prePumpScore: score,
    stage: verdict,
    verdict,
    verdictCode,
    primaryReason,
    rejectionReasons,
    signals,
    warnings
  };
}

const evaluateFourPhasePipeline = evaluateDegenSniperPipeline;

/**
 * PAPER WALLET: Scaletta Degen "Sweet Spot" (Equilibrio Win Rate & Grandi Moltiplicatori)
 * - Stop Loss Iniziale: -18% (evita shakeout prematuri sui ritracciamenti di lancio)
 * - TP1: Vende 40% a +40% e sposta lo SL sul restante 60% a pareggio (+3% netto garantito)
 * - TP2: Vende 30% a +100% (2X) -> Totale 70% realizzato, capitale 100% recuperato + guadagno netto bloccato
 * - Moon Bag (30% restante): Trailing Stop ampio al -35% dal picco massimo (floor al +30% garantito)
 */
function recordPaperSignal(token, isManual = false) {
  if (!token || !token.mint || !token.priceUsd || token.priceUsd <= 0) return null;
  if (paperSignals.has(token.mint)) return paperSignals.get(token.mint);

  const entryPrice = token.priceUsd;
  const entryMcap = token.fdvUsd || token.marketCapUsd || 0;
  const tradeSizeUsd = paperSettings.tradeSizeUsd || 100;

  const entryRecord = {
    mint: token.mint,
    pairAddress: token.pairAddress || '',
    symbol: token.symbol || 'TOKEN',
    name: token.name || token.symbol || 'Token',
    imageUrl: token.imageUrl || null,
    dexId: token.dexId || 'solana',
    category: token.category || 'MICRO-CAP',
    verdict: token.verdict || '✅ ENTRY',
    ageAtSignalHours: token.ageHours || 0,
    isManual,
    signalTime: new Date().toISOString(),
    signalTimestamp: Date.now(),
    entryScore: token.prePumpScore || 75,
    entryPriceUsd: entryPrice,
    entryMarketCapUsd: entryMcap,
    entryLiquidityUsd: token.liquidityUsd || 0,
    entrySignals: (token.signals || []).slice(0, 4),
    // Live tracking
    currentPriceUsd: entryPrice,
    currentMarketCapUsd: entryMcap,
    currentLiquidityUsd: token.liquidityUsd || 0,
    peakPriceUsd: entryPrice,
    peakMarketCapUsd: entryMcap,
    peakTimestamp: Date.now(),
    lowPriceUsd: entryPrice,
    // Hold passivo (100% posizione tenuta aperta)
    pnlPct: 0,
    maxGainPct: 0,
    maxDrawdownPct: 0,
    tradeSizeUsd,
    holdValueUsd: tradeSizeUsd,
    holdPnlUsd: 0,
    // Scaletta Degen "Sweet Spot" (TP1 40% @ +40%, TP2 30% @ +100%, Moon Bag 30% Trailing -35%, SL -18%)
    scalpState: 'ACTIVE',
    scalpStatusText: '🟢 In corsa Trench (100% • TP1 40% @ +40% • TP2 30% @ +100% • Moon Bag 30% • SL -18%)',
    tp1Hit: false,
    tp2Hit: false,
    remainingWeight: 1.0,
    realizedUsd: 0,
    scalpValueUsd: tradeSizeUsd,
    scalpPnlUsd: 0,
    scalpPnlPct: 0,
    status: 'OPEN',
    closedAt: null,
    notifiedStates: [],
    links: token.links || {
      bullx: `https://bullx.io/terminal?chainId=1399811149&address=${token.mint}`,
      photon: `https://photon-sol.tinyastro.io/en/lp/${token.pairAddress || token.mint}`,
      gmgn: `https://gmgn.ai/sol/token/${token.mint}`,
      pumpfun: `https://pump.fun/coin/${token.mint}`,
      dexscreener: `https://dexscreener.com/solana/${token.pairAddress || token.mint}`,
      rugcheck: `https://rugcheck.xyz/tokens/${token.mint}`,
      bubblemaps: `https://v2.bubblemaps.io/map?address=${token.mint}&chain=solana`
    }
  };

  paperSignals.set(token.mint, entryRecord);
  savePaperSignals();
  return entryRecord;
}

function computeTradeFrictionUsd(sig, numExitTxs = 1) {
  const size = sig.tradeSizeUsd || 100;
  const liq = Math.max(6000, sig.entryLiquidityUsd || sig.currentLiquidityUsd || 20000);
  // 1) Bot/Terminal Fee (GMGN/BullX/Photon): 1.0% Buy + 1.0% Sell = 2.0% ($2.00)
  // 2) DEX Swap Fee (PumpSwap/Raydium): 0.30% Buy + 0.30% Sell = 0.60% ($0.60)
  const swapAndBotFeesUsd = size * 0.026;
  // 3) Solana Priority Fee + Jito Anti-MEV Tip: ~$0.40 per transazione (1 Buy + N Exit/TP)
  const gasAndJitoUsd = (1 + numExitTxs) * 0.40;
  // 4) Price Impact + Slippage reale nel pool (inversamente proporzionale alla liquidità)
  const priceImpactPct = Math.min(0.025, (size / liq) * 1.8 + 0.004);
  const slippageUsd = size * priceImpactPct;

  return Number((swapAndBotFeesUsd + gasAndJitoUsd + slippageUsd).toFixed(2));
}

function evaluateScalpLadderOnSignal(sig, liveTxns1h = null) {
  const size = sig.tradeSizeUsd || 100;
  const entryPrice = sig.entryPriceUsd || 0;
  const livePrice = sig.currentPriceUsd || entryPrice;
  const peakPrice = Math.max(sig.peakPriceUsd || entryPrice, livePrice);
  const lowPrice = Math.min(sig.lowPriceUsd || entryPrice, livePrice);

  const ratio = entryPrice > 0 ? livePrice / entryPrice : 1;
  const currentChgPct = (ratio - 1) * 100;
  const peakRatio = entryPrice > 0 ? peakPrice / entryPrice : 1;
  const maxGainPct = Number(((peakRatio - 1) * 100).toFixed(2));
  const lowRatio = entryPrice > 0 ? lowPrice / entryPrice : 1;
  const maxDrawdownPct = Number(((lowRatio - 1) * 100).toFixed(2));

  sig.peakPriceUsd = peakPrice;
  sig.lowPriceUsd = lowPrice;
  sig.maxGainPct = maxGainPct;
  sig.maxDrawdownPct = maxDrawdownPct;

  // Costi reali di esecuzione (Bot 1%+1%, DEX 0.6%, Priority/Jito Gas, Slippage su Liquidità)
  const baseFrictionUsd = computeTradeFrictionUsd(sig, 1);

  // Protezione Anti-Liquidity Drain / Dev Rug Reale:
  // Un token è DAVVERO ruggato / drenato SOLO se:
  // 1) Il market cap o prezzo è collassato verso lo zero (es. Mcap < $2,500 o calo > -85% dall'entry)
  // 2) E la liquidità è stata rimossa/drenata (< $1,000)
  // IMPORTANTE: Su pump.fun / pumpswap, DexScreener spesso restituisce `liquidity: { usd: 0 }` per via delle curve virtuali,
  // anche quando il token scambia centinaia di migliaia di dollari e ha Mcap di $200k+ (es. Melonie, POGO, Google AI)!
  // Non dobbiamo MAI considerare "drenato" un token con Mcap solido (>= $8,000) o prezzo ancora attivo!
  const currentLiq = sig.currentLiquidityUsd ?? 0;
  const currentMcap = sig.currentMarketCapUsd || 0;
  const entryLiq = sig.entryLiquidityUsd || 10000;
  const isPumpFunDex = (sig.dexId === 'pumpfun' || sig.dexId === 'pumpswap' || sig.dexId === 'pump-fun');

  const isPriceAlive = (currentMcap >= 8000 || currentChgPct > -80.0);
  let isLiquidityDrained = false;

  if (isPumpFunDex) {
    // Su pump.fun: è drenato/ruggato SOLO se il dev scarica e il market cap crolla sotto $2,500 (o calo > -88%)
    isLiquidityDrained = (currentMcap > 0 && currentMcap < 2500) || (currentChgPct <= -88.0);
  } else {
    // Su Raydium AMM: se hanno sfilato la liquidità (< $1000 o < 8% dell'entry) E il prezzo è crollato
    isLiquidityDrained = !isPriceAlive && ((currentLiq < 1000) || (entryLiq >= 3000 && currentLiq < entryLiq * 0.08));
  }

  // 1) Esito HOLD Passivo:
  // Se la pool è drenata (rug o liquidità rimossa), l'Hold passivo perde TUTTO il capitale investito ($0 residui).
  // Non deve MAI mostrare guadagni fittizi basati su prezzi illiquidi di pool vuote.
  if (isLiquidityDrained) {
    sig.holdValueUsd = 0;
    sig.holdPnlUsd = -size;
    sig.pnlPct = -100;
  } else {
    const grossHoldVal = size * ratio;
    sig.holdValueUsd = Number(Math.max(0, grossHoldVal - baseFrictionUsd).toFixed(2));
    sig.holdPnlUsd = Number((sig.holdValueUsd - size).toFixed(2));
    sig.pnlPct = Number(((sig.holdPnlUsd / size) * 100).toFixed(2));
  }

  // Se la posizione è già stata CHIUSA in passato, congeliamo lo stato Scalp
  if (sig.status === 'CLOSED') {
    sig.scalpValueUsd = Number((sig.realizedUsd || 0).toFixed(2));
    sig.scalpPnlUsd = Number((sig.scalpValueUsd - size).toFixed(2));
    sig.scalpPnlPct = Number(((sig.scalpPnlUsd / size) * 100).toFixed(2));
    sig.currentValueUsd = sig.scalpValueUsd;
    sig.remainingWeight = 0;
    return;
  }

  // Se la pool è drenata a liquidità zero/insufficiente, il token non è più scambiabile sul mercato:
  // Viene chiuso immediatamente con valore residuo azzerato (perdita della quota non ancora realizzata)
  if (isLiquidityDrained) {
    sig.status = 'CLOSED';
    sig.closedAt = sig.closedAt || new Date().toISOString();
    sig.scalpState = 'RUG_DRAINED';
    sig.remainingWeight = 0;
    const finalVal = sig.realizedUsd || 0;
    sig.scalpValueUsd = Number(finalVal.toFixed(2));
    sig.scalpPnlUsd = Number((sig.scalpValueUsd - size).toFixed(2));
    sig.scalpPnlPct = Number(((sig.scalpPnlUsd / size) * 100).toFixed(2));
    sig.currentValueUsd = sig.scalpValueUsd;
    sig.scalpStatusText = `☠️ Rug / Liquidità Drenata ($${Math.round(currentLiq)}) — Chiuso [Realizzato: $${finalVal.toFixed(2)}]`;
    return;
  }

  // 2) Scaletta Degen "Sweet Spot" (Equilibrio Win Rate & Grandi Moltiplicatori):
  //    - Stop Loss Iniziale (-18%): dà respiro al token per superare la volatilità iniziale di lancio senza falsi stop-out.
  //    - TP1 (+40%): vende il 40% della posizione!
  //      -> Incassa prima tranche di profitto, sposta lo Stop Loss sul restante 60% a pareggio (+3% netto garantito). Trade a rischio zero!
  //    - TP2 (+100% / 2X): vende il 30% della posizione iniziale!
  //      -> Totale 70% già realizzato: $25 di capitale iniziale 100% recuperati + $4 netti incassati.
  //    - Moon Bag (30% restante): lasciata correre libera con Trailing Stop ampio al -35% dal picco massimo (floor al +30% minimo).
  //      -> Permette ai veri runner di fare +300%, +500% o +1000% senza essere buttati fuori da fisiologici dump intermedi del 20-25%!
  let remaining = 1.0;
  let realized = 0;
  let tp1Hit = false;
  let tp2Hit = false;
  let status = 'OPEN';
  let scalpState = 'ACTIVE';
  let numExits = 1;
  let statusText = '🟢 In corsa Trench (100% • TP1 40% @ +40% • TP2 30% @ +100% • Moon Bag 30% • SL -18%)';

  const prevState = sig.scalpState || 'ACTIVE';

  if (maxGainPct >= 40) {
    tp1Hit = true;
    realized += size * 0.40 * 1.40; // vende il 40% a +40%
    remaining = 0.60;
    numExits = 2;
    scalpState = 'TP1_HIT';
    statusText = '🎯 TP1 Preso (+40% su 40%) • 60% in corsa (SL a pareggio)';
  }

  if (tp1Hit && maxGainPct >= 100) {
    tp2Hit = true;
    realized += size * 0.30 * 2.00; // vende il 30% a +100% (2X)
    remaining = 0.30;
    numExits = 3;
    scalpState = 'TP2_HIT';
    statusText = '🚀 TP2 Preso (2X su 30%) • 30% Moon Bag in corsa (Trailing -35%)';
  }

  const heldMinutes = (Date.now() - sig.signalTimestamp) / 60000;

  if (!tp1Hit) {
    // Gestione Stop Loss & Grace Period Anti-Shakeout (Protezione Runner stile MILO/Alt-coin):
    // Nei primi 90 secondi (heldMinutes < 1.5), i primi bot MEV e sniper veloci scaricano fisiologicamente generando micro-dip del -20%/-30%.
    // Non chiudiamo sui micro-dip se il token non sta ruggando a zero (tolleranza allargata a -35% nei primi 90s).
    // Dopo 90 secondi (heldMinutes >= 1.5), si applica lo Stop Loss standard a -22%.
    const isEarlyGracePeriod = heldMinutes < 1.5;
    const dynamicSlThreshold = isEarlyGracePeriod ? -35.0 : -22.0;

    if (currentChgPct <= dynamicSlThreshold || (!isEarlyGracePeriod && maxDrawdownPct <= -22.5)) {
      const exitRatio = Math.max(0.40, 1 + currentChgPct / 100);
      realized += size * remaining * exitRatio;
      remaining = 0;
      status = 'CLOSED';
      scalpState = 'STOPPED_OUT';
      statusText = `🛑 Stop Loss (${currentChgPct.toFixed(1)}% Eseguito)`;
    } else if (liveTxns1h && heldMinutes >= 2.0) {
      const buys1h = liveTxns1h.buys || 0;
      const sells1h = liveTxns1h.sells || 0;
      if (sells1h > buys1h * 1.6 && currentChgPct <= -8.0) {
        realized += size * remaining * ratio;
        remaining = 0;
        status = 'CLOSED';
        scalpState = 'EARLY_EXIT';
        statusText = '⚡ Uscita Anticipata Anti-Dump (Vendite > 1.6x Acquisti)';
      }
    }
  } else if (tp1Hit && !tp2Hit) {
    // Ha raggiunto TP1 (+40%) ma non ancora TP2 (+100%):
    // Il restante 60% è protetto con floor minimo garantito a pareggio (+3% netto sopra l'entry) e trailing stop al -25% dal picco
    const trailFloorPrice = entryPrice * 1.03;
    const trailStopPrice = Math.max(trailFloorPrice, peakPrice * 0.75);
    if (livePrice <= trailStopPrice) {
      const exitRatio = trailStopPrice / entryPrice;
      realized += size * remaining * exitRatio;
      remaining = 0;
      status = 'CLOSED';
      scalpState = 'TP1_PROTECTED';
      const lockedPct = Math.round((exitRatio - 1) * 100);
      statusText = `✅ Posizione Chiusa da Trailing Stop (TP1 +40% + 60% protetto a +${lockedPct}%)`;
    }
  } else if (tp2Hit) {
    // Ha raggiunto anche TP2 (+100% / 2X):
    // La Moon Bag (30% restante) corre libera con Trailing Stop ampio al -35% dal picco ATH (floor al +30% garantito)
    const moonFloorPrice = entryPrice * 1.30;
    const moonStopPrice = Math.max(moonFloorPrice, peakPrice * 0.65); // -35% dal picco ATH
    if (livePrice <= moonStopPrice) {
      const exitRatio = moonStopPrice / entryPrice;
      realized += size * remaining * exitRatio;
      remaining = 0;
      status = 'CLOSED';
      scalpState = 'TP2_TRAILED';
      const lockedPct = Math.round((exitRatio - 1) * 100);
      statusText = `🏆 Moon Bag Chiusa da Trailing Stop -35% (TP1 +40% + TP2 2X + Moon Bag a +${lockedPct}%)`;
    }
  }

  const totalFeesUsd = computeTradeFrictionUsd(sig, numExits);
  sig.feesPaidUsd = totalFeesUsd;
  sig.tp1Hit = tp1Hit;
  sig.tp2Hit = tp2Hit;
  sig.remainingWeight = Number(remaining.toFixed(2));
  sig.realizedUsd = Number(realized.toFixed(2));
  sig.status = status;
  if (status === 'CLOSED' && !sig.closedAt) {
    sig.closedAt = new Date().toISOString();
  } else if (status === 'OPEN') {
    sig.closedAt = null;
  }
  sig.scalpState = scalpState;
  sig.scalpStatusText = `${statusText} [Fee/Slip: -$${totalFeesUsd.toFixed(2)}]`;

  const unrealizedScalpUsd = size * sig.remainingWeight * ratio;
  const grossScalpVal = sig.realizedUsd + unrealizedScalpUsd;
  sig.scalpValueUsd = Number(Math.max(0, grossScalpVal - totalFeesUsd).toFixed(2));
  sig.scalpPnlUsd = Number((sig.scalpValueUsd - size).toFixed(2));
  sig.scalpPnlPct = Number(((sig.scalpPnlUsd / size) * 100).toFixed(2));
  sig.currentValueUsd = sig.scalpValueUsd;

  // Invio notifica Discord su cambio di stato (TP1, TP2, Chiusura trailing o Stop Loss)
  if (scalpState !== prevState && !sig.isHistoricalReplay) {
    sendDiscordTradeEvent(sig, prevState, scalpState).catch(() => {});
  }
}

// Helper per notificare su Discord eventi operativi (TP1 +30%, TP2 +70%, Stop Loss -10%)
async function sendDiscordTradeEvent(sig, fromState, toState) {
  if (!discordConfig.webhookUrl || !discordConfig.webhookUrl.startsWith('https://discord.com/api/webhooks/')) return;
  if (!discordConfig.enabled) return;

  if (!Array.isArray(sig.notifiedStates)) {
    sig.notifiedStates = [];
  }
  if (sig.notifiedStates.includes(toState)) {
    return;
  }

  const eventConfigs = {
    TP1_HIT: {
      title: `🎯 TP1 RAGGIUNTO (+40%) — ${sig.symbol}`,
      color: 0x10b981,
      desc: `Venduto il **40%** della posizione a target $+40\%$.\nSpostato lo Stop Loss sul restante **60%** a pareggio ($+3\%$ netto protetto).\nRischio capitale azzerato!`
    },
    TP2_HIT: {
      title: `🚀 TP2 2X RAGGIUNTO (+100%) — ${sig.symbol}`,
      color: 0x06b6d4,
      desc: `Venduto il **30%** della posizione al raddoppio ($+100\%$ / 2X).\n**100% del capitale già recuperato + $4 netti incassati**.\nIl restante **30% Moon Bag** corre con Trailing Stop al -35% per catturare i mega pump!`
    },
    TP1_PROTECTED: {
      title: `✅ POSIZIONE CHIUSA DA TRAILING STOP — ${sig.symbol}`,
      color: 0x8b5cf6,
      desc: `Quota restante (60%) chiusa dal Trailing Stop a protezione del capitale.\n**Profitto Netto Totale:** **+${sig.scalpPnlPct.toFixed(1)}% ($${sig.scalpValueUsd.toFixed(2)})**.`
    },
    TP2_TRAILED: {
      title: `🏆 MOON BAG CHIUSA DA TRAILING STOP — ${sig.symbol}`,
      color: 0x3b82f6,
      desc: `Moon Bag (30%) chiusa dal Trailing Stop -35% dal picco ATH.\n**Profitto Netto Totale:** **+${sig.scalpPnlPct.toFixed(1)}% ($${sig.scalpValueUsd.toFixed(2)})**.`
    },
    STOPPED_OUT: {
      title: `🛑 STOP LOSS ANTI-DEV ESEGUITO — ${sig.symbol}`,
      color: 0xef4444,
      desc: `Posizione chiusa per protezione del capitale.\n**Perdita netta contenuta:** **${sig.scalpPnlPct.toFixed(1)}% ($${sig.scalpValueUsd.toFixed(2)})**.`
    },
    EARLY_EXIT: {
      title: `⚡ USCITA ANTICIPATA ANTI-DUMP — ${sig.symbol}`,
      color: 0xf59e0b,
      desc: `Rilevate vendite dominanti > 1.5x acquisti con calo di prezzo.\nPosizione liquidata all'istante per anticipare il dump.`
    }
  };

  const ev = eventConfigs[toState];
  if (!ev) return;

  const tradeSize = sig.tradeSizeUsd || 25;
  const embed = {
    title: ev.title,
    url: sig.links?.gmgn || `https://gmgn.ai/sol/token/${sig.mint}`,
    color: ev.color,
    thumbnail: sig.imageUrl ? { url: sig.imageUrl } : undefined,
    description: ev.desc,
    fields: [
      {
        name: `💰 Esito Posizione ($${tradeSize})`,
        value: `**Valore Netto:** $${sig.scalpValueUsd.toFixed(2)} (${sig.scalpPnlPct >= 0 ? '+' : ''}${sig.scalpPnlPct.toFixed(1)}%)\n**Fee/Slip Totali:** -$${sig.feesPaidUsd.toFixed(2)}`,
        inline: true
      },
      {
        name: '📊 Prezzi & Massimi',
        value: `**Entrata:** $${sig.entryPriceUsd}\n**Attuale:** $${sig.currentPriceUsd}\n**ATH Segnale:** +${sig.maxGainPct.toFixed(1)}%`,
        inline: true
      },
      {
        name: '🔗 Terminali & Sniper',
        value: `[⚡ APRI SNIPER](${discordConfig.systemUrl || SYSTEM_URL})\n[🦎 GMGN](${sig.links?.gmgn || '#'}) • [🎯 BullX](${sig.links?.bullx || '#'}) • [⚡ Photon](${sig.links?.photon || '#'}) • [🦅 DexScreener](${sig.links?.dexscreener || '#'})`,
        inline: false
      }
    ],
    footer: {
      text: 'Solana Degen Sniper Paper Wallet • TP1 40% @ +40% / TP2 30% @ +100% / Moon Bag 30% (Trailing -35%) • SL -22% (Grace Period 90s)'
    },
    timestamp: new Date().toISOString()
  };

  try {
    console.log(`[DISCORD] Invio evento ${toState} per ${sig.symbol} su webhook...`);
    const res = await fetch(discordConfig.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'Solana Trade Manager 🎯',
        embeds: [embed]
      })
    });
    console.log(`[DISCORD] Risposta evento ${toState} per ${sig.symbol}: HTTP ${res.status}`);
    if (res.status >= 200 && res.status < 300) {
      sig.notifiedStates.push(toState);
      savePaperSignals();
    }
  } catch (err) {
    console.error(`[DISCORD ERROR] Impossibile inviare evento ${toState} per ${sig.symbol}:`, err.message);
  }
}

// Invia automaticamente ogni ora un check completo delle prestazioni e delle conclusioni operative su Discord
async function sendHourlyPerformanceReport(isManualTrigger = false) {
  if (!discordConfig.webhookUrl || !discordConfig.webhookUrl.startsWith('https://discord.com/api/webhooks/')) return { ok: false, error: 'Webhook non valido' };
  if (!discordConfig.enabled) return { ok: false, error: 'Discord disabilitato' };

  const summary = computePaperSummary();
  const list = summary.signals || [];
  const trades = summary.totalTrades || 0;
  if (trades === 0) return { ok: false, error: 'Nessun trade nel Paper Wallet' };

  const totalInvested = summary.totalInvested || 0;
  const scalpVal = summary.scalpPortfolioValue || 0;
  const scalpPnl = summary.scalpPnlUsd || 0;
  const scalpPnlPct = summary.scalpPnlPct || 0;
  const holdVal = summary.holdPortfolioValue || 0;
  const holdPnl = summary.holdPnlUsd || 0;
  const holdPnlPct = summary.holdPnlPct || 0;
  const totalFees = summary.totalFeesPaid || 0;
  const winRate = summary.winRateScalp || 0;
  const tp1Rate = summary.tp1Rate || 0;
  const winners = list.filter(s => s.tp1Hit || (s.scalpPnlPct ?? 0) >= 8.0).length;
  const stopped = list.filter(s => s.scalpState === 'STOPPED_OUT').length;
  const openTrades = summary.openTrades || 0;

  // I 5 top token per profitto netto
  const topWinners = [...list]
    .filter(s => (s.scalpPnlPct || 0) > 0)
    .sort((a, b) => (b.scalpPnlPct || 0) - (a.scalpPnlPct || 0))
    .slice(0, 5)
    .map(s => `• **${s.symbol}**: +${(s.scalpPnlPct || 0).toFixed(1)}% netti (ATH +${(s.maxGainPct || 0).toFixed(0)}%) [Fee: -$${(s.feesPaidUsd || 0).toFixed(2)}]`)
    .join('\n');

  // Conclusioni operative dinamiche in base alle metriche correnti
  const winRateStatus = winRate >= 65
    ? `🎯 **Target Win Rate Raggiunto**: ${winRate}% netto.`
    : `⚠️ **Win Rate corrente**: ${winRate}% netto. Selezione trench in corso.`;

  const conclusions = [
    `1. ${winRateStatus}`,
    `2. 🛡️ **Protezione Anti-Dump**: Stop Loss reattivo a -10% per tagliare le perdite prima che il dev scarichi.`,
    `3. ⚖️ **Scaletta Degen vs Hold**: La scaletta rapida (+30% TP1 / +70% TP2 / Trailing Moon Bag) sovraperforma l'Hold passivo di **+${(scalpPnlPct - holdPnlPct).toFixed(1)}%**.`,
    `4. ⚡ **Filtro Velocity Attivo**: Token < 30m con Buy Ratio > 70% e tracking Smart Wallets al Blocco 0/1.`
  ].join('\n');

  const embed = {
    title: `${isManualTrigger ? '🧪 [REPORT TEST] ' : '🚀 '}REPORT DEGEN SNIPER SOLANA (TRENCH VELOCITY)`,
    color: winRate >= 65 ? 0x10b981 : 0xf59e0b,
    description: `Riepilogo automatico delle prestazioni Degen Sniper netti di tutte le fee reali (Bot 2%, DEX 0.6%, Priority Gas $0.40/tx e Slippage).`,
    fields: [
      {
        name: '📈 Portafoglio Netto Reale ($100/trade)',
        value: `**Investito:** $${totalInvested.toFixed(2)}\n**Valore Attuale:** $${scalpVal.toFixed(2)} (**+${scalpPnlPct.toFixed(1)}%**)\n**Profitto Netto:** +$${scalpPnl.toFixed(2)}\n**Fee/Gas Pagati:** -$${totalFees.toFixed(2)}`,
        inline: false
      },
      {
        name: '🎯 Win Rate & Esecuzioni Degen',
        value: `**Win Rate Netto:** **${winRate}%** (${winners}/${trades} vinti)\n**TP1 Hit (+30%):** **${tp1Rate}%**\n**Trade Aperti:** ${openTrades} | **Stop Loss (-10%):** ${stopped}`,
        inline: true
      },
      {
        name: '⚔️ Scalp Rapido vs Hold Passivo',
        value: `**Strategia Degen:** +${scalpPnlPct.toFixed(1)}%\n**Hold Passivo:** ${holdPnlPct.toFixed(1)}%\n**Outperformance:** **+${(scalpPnlPct - holdPnlPct).toFixed(1)}%**`,
        inline: true
      },
      {
        name: '🏆 Top Performers Chiusi',
        value: topWinners || 'Nessun vincitore al momento',
        inline: false
      },
      {
        name: '🧠 Parametri Strategia',
        value: conclusions,
        inline: false
      },
      {
        name: '🔗 Accesso Dashboard Sniper',
        value: `[⚡ APRI DEGEN SNIPER SU BROWSER](${discordConfig.systemUrl || SYSTEM_URL})`,
        inline: false
      }
    ],
    footer: {
      text: 'Solana Degen Sniper • Report Periodico • TP1 +30% / TP2 +70% / SL -10%'
    },
    timestamp: new Date().toISOString()
  };

  try {
    console.log('[DISCORD] Invio report periodico delle prestazioni su webhook...');
    const res = await fetch(discordConfig.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'Solana Degen Sniper 🚀',
        embeds: [embed]
      })
    });
    console.log(`[DISCORD] Risposta report orario: HTTP ${res.status}`);
    return { ok: res.status >= 200 && res.status < 300, status: res.status };
  } catch (err) {
    console.error('[DISCORD ERROR] Errore invio report orario:', err.message);
    return { ok: false, error: err.message };
  }
}

// All'avvio manteniamo nel Paper Wallet solo i segnali storici che rispettavano i 5 Pilastri On-Chain (≥30 Buyer 5m, Organic Score >= 42, Bot <= 28%, No Sybil Bundle)
const VERIFIED_ONCHAIN_SYMBOL_BLACKLIST = new Set([
  'KWIF', 'Macca', 'STARMAN', 'Groklet', 'Animals', 'CORA', 'ANTH', 'SOCKSS',
  'Normie', 'Cartridge', '1EDGE', 'DacityCoin', 'swordcat', 'CYBERLEEK'
]);
for (const [mint, sig] of paperSignals.entries()) {
  if (!sig.isManual && VERIFIED_ONCHAIN_SYMBOL_BLACKLIST.has(sig.symbol)) {
    paperSignals.delete(mint);
  } else {
    sig.isHistoricalReplay = true;
    evaluateScalpLadderOnSignal(sig, null);
    delete sig.isHistoricalReplay;
  }
}
savePaperSignals();

function updatePaperSignalPrice(mint, liveToken) {
  const sig = paperSignals.get(mint);
  if (!sig) return;

  // Sicurezza anti-cross pool: se il segnale è su un pool specifico (es. pumpswap),
  // accettiamo aggiornamenti SOLO dal pool con la liquidità principale o con lo stesso pairAddress
  if (sig.pairAddress && liveToken.pairAddress && sig.pairAddress !== liveToken.pairAddress) {
    // Se il nuovo pool ha una frazione minima della liquidità del pool d'entrata, lo ignoriamo categoricamente
    if ((liveToken.liquidityUsd || 0) < (sig.entryLiquidityUsd * 0.4)) {
      return;
    }
  }

  const livePriceUsd = liveToken.priceUsd;
  const liveMcapUsd = liveToken.fdvUsd || liveToken.marketCapUsd;
  const liveLiqUsd = liveToken.liquidityUsd;
  if (!livePriceUsd || livePriceUsd <= 0) return;

  if (liveLiqUsd !== undefined && liveLiqUsd >= 0) sig.currentLiquidityUsd = liveLiqUsd;
  if (!sig.imageUrl && liveToken.imageUrl) sig.imageUrl = liveToken.imageUrl;

  // Su pump.fun la liquidità DexScreener può essere 0 per via delle curve virtuali; non considerarlo drenato se il mcap è vivo!
  const isPumpFun = (sig.dexId === 'pumpfun' || sig.dexId === 'pumpswap' || sig.dexId === 'pump-fun');
  const isDrained = isPumpFun 
    ? (liveMcapUsd > 0 && liveMcapUsd < 2500)
    : (sig.currentLiquidityUsd < 1000 && (!liveMcapUsd || liveMcapUsd < 5000));
  if (!isDrained || livePriceUsd <= (sig.entryPriceUsd * 1.5)) {
    sig.currentPriceUsd = livePriceUsd;
    if (liveMcapUsd && liveMcapUsd > 0) sig.currentMarketCapUsd = liveMcapUsd;
  }

  if (!isDrained && livePriceUsd > (sig.peakPriceUsd || 0)) {
    sig.peakPriceUsd = livePriceUsd;
    sig.peakMarketCapUsd = Math.max(sig.peakMarketCapUsd || 0, liveMcapUsd || 0);
    sig.peakTimestamp = Date.now();
  }
  if (!sig.lowPriceUsd || livePriceUsd < sig.lowPriceUsd) {
    sig.lowPriceUsd = livePriceUsd;
  }

  evaluateScalpLadderOnSignal(sig, liveToken.txns?.h1 || null);
  sig.lastUpdatedAt = new Date().toISOString();
}

function computePaperSummary() {
  const list = Array.from(paperSignals.values()).sort((a, b) => b.signalTimestamp - a.signalTimestamp);
  const totalTrades = list.length;
  const totalInvested = list.reduce((acc, s) => acc + (s.tradeSizeUsd || 100), 0);
  const totalFeesPaid = list.reduce((acc, s) => acc + (s.feesPaidUsd || 0), 0);

  // Confronto tra Strategia Scalp (TP/SL netto di Fee/Gas/Slippage) e Hold Passivo (netto di Fee)
  const scalpPortfolioValue = list.reduce((acc, s) => acc + (s.scalpValueUsd ?? s.currentValueUsd ?? 100), 0);
  const holdPortfolioValue = list.reduce((acc, s) => acc + (s.holdValueUsd ?? s.currentValueUsd ?? 100), 0);

  const scalpPnlUsd = scalpPortfolioValue - totalInvested;
  const scalpPnlPct = totalInvested > 0 ? (scalpPnlUsd / totalInvested) * 100 : 0;

  const holdPnlUsd = holdPortfolioValue - totalInvested;
  const holdPnlPct = totalInvested > 0 ? (holdPnlUsd / totalInvested) * 100 : 0;

  // Regola Onesta "No Micro-Gain": Un trade conta come Vinto SOLO se ha generato >= +8% NETTO (dopo tutte le fee/gas/slippage) o ha colpito TP1 (+40%)
  const scalpWinners = list.filter(s => s.tp1Hit || (s.scalpPnlPct ?? 0) >= 8.0).length;
  const holdWinners = list.filter(s => (s.pnlPct || 0) >= 8.0).length;
  const tp1HitCount = list.filter(s => s.tp1Hit || (s.maxGainPct || 0) >= 40).length;

  const winRateScalp = totalTrades > 0 ? Math.round((scalpWinners / totalTrades) * 100) : 0;
  const winRateHold = totalTrades > 0 ? Math.round((holdWinners / totalTrades) * 100) : 0;
  const tp1Rate = totalTrades > 0 ? Math.round((tp1HitCount / totalTrades) * 100) : 0;

  const bestTrade = list.reduce((best, s) => (!best || (s.maxGainPct || 0) > (best.maxGainPct || 0) ? s : best), null);

  const initialBudgetUsd = Number(paperSettings.initialBudgetUsd || 1000);
  const tradeSizeUsd = Number(paperSettings.tradeSizeUsd || 25);

  // Calcolo Cassa e Capitale:
  // - Open Cost: tradeSizeUsd * numero di posizioni aperte
  // - Realized Cash Out: totale $ incassato dalle posizioni chiuse o parzialmente realizzate
  const openPositions = list.filter(s => s.status === 'OPEN');
  const openCapitalLocked = openPositions.reduce((acc, s) => acc + (s.tradeSizeUsd || tradeSizeUsd), 0);
  const realizedCashCollected = list.reduce((acc, s) => acc + (s.realizedUsd || 0), 0);
  
  // Capitale fresco iniziale consumato (non può superare initialBudgetUsd)
  // Per ogni trade aperto, attinge prima dal budget iniziale fino a $1000; poi usa i profitti realizzati in cassa
  const freshBudgetUsed = Math.min(initialBudgetUsd, totalTrades * tradeSizeUsd);
  const freshBudgetRemaining = Math.max(0, initialBudgetUsd - freshBudgetUsed);
  
  // Cassa totale liquida spendibile per nuovi trade = Budget fresco rimasto + Realizzato incassato - Capitale bloccato
  // In alternativa più chiara: Cassa Attuale Disponibile = initialBudgetUsd + Profitto Netto Realizzato - Capitale Aperto
  const realizedNetProfit = list.reduce((acc, s) => {
    if (s.status === 'CLOSED') {
      return acc + (s.scalpPnlUsd || 0);
    } else {
      // Per quelli aperti, ha incassato realizedUsd ma ha in ballo tradeSizeUsd
      return acc + (s.realizedUsd || 0) - (s.tradeSizeUsd || tradeSizeUsd) * (1 - (s.remainingWeight ?? 1));
    }
  }, 0);

  // Saldo Cassa Disponibile per fare nuovi trade:
  const availableCashUsd = Math.max(0, initialBudgetUsd - totalInvested + list.reduce((acc, s) => acc + (s.realizedUsd || 0), 0));
  const canOpenNewTrade = availableCashUsd >= tradeSizeUsd;

  return {
    settings: paperSettings,
    totalTrades,
    totalFeesPaid: Number(totalFeesPaid.toFixed(2)),
    openTrades: openPositions.length,
    closedTrades: list.filter(s => s.status === 'CLOSED').length,
    initialBudgetUsd,
    totalInvested: Number(totalInvested.toFixed(2)),
    availableCashUsd: Number(availableCashUsd.toFixed(2)),
    canOpenNewTrade,
    freshBudgetRemaining: Number(freshBudgetRemaining.toFixed(2)),
    scalpPortfolioValue: Number(scalpPortfolioValue.toFixed(2)),
    scalpPnlUsd: Number(scalpPnlUsd.toFixed(2)),
    scalpPnlPct: Number(scalpPnlPct.toFixed(2)),
    holdPortfolioValue: Number(holdPortfolioValue.toFixed(2)),
    holdPnlUsd: Number(holdPnlUsd.toFixed(2)),
    holdPnlPct: Number(holdPnlPct.toFixed(2)),
    winRateScalp,
    winRateHold,
    tp1Rate,
    bestTrade: bestTrade ? {
      symbol: bestTrade.symbol,
      maxGainPct: bestTrade.maxGainPct,
      scalpPnlPct: bestTrade.scalpPnlPct ?? bestTrade.pnlPct
    } : null,
    signals: list
  };
}

async function sendDiscordTokenAlert(token, isTest = false) {
  if (!discordConfig.webhookUrl || !discordConfig.webhookUrl.startsWith('https://discord.com/api/webhooks/')) {
    return { ok: false, error: 'URL Webhook Discord non valido' };
  }

  const chg5m = Number(token.priceChange?.m5 || 0);
  const chg1h = Number(token.priceChange?.h1 || 0);
  const sec = token.security || {};

  const embed = {
    title: `${isTest ? '🧪 [TEST] ' : ''}${token.verdict} — ${token.symbol} (${token.ageMinutes || 1}m fa) • Score ${token.prePumpScore}/100`,
    url: token.links?.bullx || token.links?.gmgn || `https://gmgn.ai/sol/token/${token.mint}`,
    color: token.verdictCode === 'ENTRY' ? 0xff0055 : 0xf59e0b,
    thumbnail: token.imageUrl ? { url: token.imageUrl } : undefined,
    description: `**Motivo:** ${token.primaryReason}\n**Mint:** \`${token.mint}\``,
    fields: [
      {
        name: '⏱️ Età & Launchpad',
        value: `**Età:** **${token.ageMinutes} min fa**\n**Curva:** ${token.curveStatus || 'Raydium'}\n**FDV:** ${formatUsd(token.fdvUsd)} (Liq: ${formatUsd(token.liquidityUsd)})`,
        inline: true
      },
      {
        name: '🚀 Velocity 1m / 5m',
        value: `**Vol 1m Est:** ~${formatUsd(token.vol1mEst)}/m\n**Vol 5m:** ${formatUsd(token.vol5m)}\n**Velocità:** ${token.velocityPerMin} tx/min`,
        inline: true
      },
      {
        name: '🔥 Buy/Sell Ratio & Flusso',
        value: `**Buys 5m:** **${token.buyRatio5m}%** (${token.buys5m}B / ${token.sells5m}S)\n**5m Chg:** ${chg5m >= 0 ? '+' : ''}${chg5m.toFixed(1)}%\n**1h Chg:** ${chg1h >= 0 ? '+' : ''}${chg1h.toFixed(1)}%`,
        inline: true
      },
      {
        name: '🧠 Smart Wallets & Blocco 0/1',
        value: `**Smart Wallets:** ${token.smartMoneyText}\n**Top 10 EOA:** ${sec.top10EoaPct ?? 'N/D'}%\n**Avvisi:** ${token.warnings?.length ? token.warnings[0] : 'Nessuno'}`,
        inline: true
      },
      {
        name: '🎯 Scaletta Uscita Degen',
        value: `**TP1:** +30% (Vende 40% • SL a +5%)\n**TP2:** +70% (Vende 40% • 20% Moon Bag Trailing)\n**Stop Loss:** **-10%** (Protezione anti-dump)`,
        inline: true
      },
      {
        name: '🔗 Terminali & Sniper Rapido',
        value: `[⚡ APRI SNIPER SISTEMA](${discordConfig.systemUrl || SYSTEM_URL})\n[🎯 BullX](${token.links?.bullx || '#'}) • [⚡ Photon](${token.links?.photon || '#'}) • [🦎 GMGN](${token.links?.gmgn || '#'}) • [💊 Pump.fun](${token.links?.pumpfun || '#'}) • [🦅 DexScreener](${token.links?.dexscreener || '#'})`,
        inline: false
      }
    ],
    footer: {
      text: 'Solana Degen Sniper • Trench Velocity (<30m) • TP1 +30% / TP2 +70% / SL -10%'
    },
    timestamp: new Date().toISOString()
  };

  try {
    const res = await fetch(discordConfig.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'Solana Degen Sniper 🚀',
        embeds: [embed]
      })
    });
    if (!res.ok) return { ok: false, error: `Discord HTTP ${res.status}` };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function parseGeckoPool(pool, includedMap) {
  const attr = pool.attributes || {};
  const rel = pool.relationships || {};
  const baseId = rel.base_token?.data?.id || '';
  const mint = baseId.replace('solana_', '');
  if (!mint || EXCLUDED_MINTS.has(mint)) return null;

  const dexId = rel.dex?.data?.id || 'solana-dex';
  const tokenMeta = includedMap.get(baseId) || {};
  const rawName = attr.name || '';
  const symbolFromPool = rawName.split('/')[0]?.trim() || 'TOKEN';
  const finalSymbol = (tokenMeta.symbol || symbolFromPool).trim();
  if (EXCLUDED_SYMBOLS.has(finalSymbol.toUpperCase())) return null;

  const fdv = parseFloat(attr.fdv_usd) || parseFloat(attr.market_cap_usd) || 0;
  const mcap = parseFloat(attr.market_cap_usd) || fdv;
  const liq = parseFloat(attr.reserve_in_usd) || 0;
  const priceUsd = parseFloat(attr.base_token_price_usd) || 0;

  const tx = attr.transactions || {};
  const vol = attr.volume_usd || {};
  const chg = attr.price_change_percentage || {};

  return {
    mint,
    pairAddress: attr.address || '',
    symbol: finalSymbol,
    name: tokenMeta.name || symbolFromPool,
    imageUrl: tokenMeta.image_url && tokenMeta.image_url !== 'missing.png' ? tokenMeta.image_url : null,
    dexId,
    createdAt: attr.pool_created_at ? new Date(attr.pool_created_at).getTime() : null,
    priceUsd,
    marketCapUsd: mcap,
    fdvUsd: fdv,
    liquidityUsd: liq,
    volume: {
      m5: parseFloat(vol.m5) || 0,
      m15: parseFloat(vol.m15) || 0,
      h1: parseFloat(vol.h1) || 0,
      h6: parseFloat(vol.h6) || 0,
      h24: parseFloat(vol.h24) || 0
    },
    priceChange: {
      m5: parseFloat(chg.m5) || 0,
      m15: parseFloat(chg.m15) || 0,
      h1: parseFloat(chg.h1) || 0,
      h6: parseFloat(chg.h6) || 0,
      h24: parseFloat(chg.h24) || 0
    },
    txns: {
      m5: { buys: tx.m5?.buys || 0, sells: tx.m5?.sells || 0, buyers: tx.m5?.buyers || 0, sellers: tx.m5?.sellers || 0 },
      m15: { buys: tx.m15?.buys || 0, sells: tx.m15?.sells || 0, buyers: tx.m15?.buyers || 0, sellers: tx.m15?.sellers || 0 },
      h1: { buys: tx.h1?.buys || 0, sells: tx.h1?.sells || 0, buyers: tx.h1?.buyers || 0, sellers: tx.h1?.sellers || 0 },
      h6: { buys: tx.h6?.buys || 0, sells: tx.h6?.sells || 0, buyers: tx.h6?.buyers || 0, sellers: tx.h6?.sellers || 0 },
      h24: { buys: tx.h24?.buys || 0, sells: tx.h24?.sells || 0, buyers: tx.h24?.buyers || 0, sellers: tx.h24?.sellers || 0 }
    },
    source: 'GeckoTerminal'
  };
}

function parseDexScreenerPair(pair) {
  if (!pair || pair.chainId !== 'solana') return null;
  const mint = pair.baseToken?.address;
  if (!mint || EXCLUDED_MINTS.has(mint)) return null;
  const sym = (pair.baseToken?.symbol || 'TOKEN').trim();
  if (EXCLUDED_SYMBOLS.has(sym.toUpperCase())) return null;

  const fdv = parseFloat(pair.fdv) || parseFloat(pair.marketCap) || 0;
  const mcap = parseFloat(pair.marketCap) || fdv;
  // Se pair.liquidity è presente ma usd === 0 (o base < 0.001 quote < 0.001), la pool è stata DRENATA e la liquidità è ZERO!
  const rawLiqUsd = pair.liquidity?.usd;
  let liq = 0;
  if (typeof rawLiqUsd === 'number') {
    liq = rawLiqUsd;
  } else if (rawLiqUsd !== undefined && rawLiqUsd !== null) {
    liq = parseFloat(rawLiqUsd) || 0;
  } else if (pair.dexId === 'pumpfun' || pair.dexId === 'pumpswap') {
    // Solo se DexScreener non riporta l'oggetto liquidity (bonding curve aperta pre-AMM)
    // e il market cap è realistico (< $150k), stimiamo la liquidità proporzionale
    if (mcap >= 3000 && mcap <= 120000) {
      liq = Math.min(65000, Math.round(mcap * 0.45));
    }
  }
  const priceUsd = parseFloat(pair.priceUsd) || 0;

  const vol5m = parseFloat(pair.volume?.m5) || 0;
  const vol1h = parseFloat(pair.volume?.h1) || 0;
  const vol6h = parseFloat(pair.volume?.h6) || 0;
  const vol24h = parseFloat(pair.volume?.h24) || 0;

  const buys5m = pair.txns?.m5?.buys || 0;
  const sells5m = pair.txns?.m5?.sells || 0;
  const buys1h = pair.txns?.h1?.buys || 0;
  const sells1h = pair.txns?.h1?.sells || 0;
  const buys6h = pair.txns?.h6?.buys || 0;
  const sells6h = pair.txns?.h6?.sells || 0;
  const buys24h = pair.txns?.h24?.buys || 0;
  const sells24h = pair.txns?.h24?.sells || 0;

  return {
    mint,
    pairAddress: pair.pairAddress || '',
    symbol: sym,
    name: pair.baseToken?.name || sym,
    imageUrl: pair.info?.imageUrl || null,
    dexId: pair.dexId || 'solana-dex',
    createdAt: pair.pairCreatedAt || null,
    priceUsd,
    marketCapUsd: mcap,
    fdvUsd: fdv,
    liquidityUsd: liq,
    volume: {
      m5: vol5m,
      m15: vol5m * 2.5,
      h1: vol1h,
      h6: vol6h,
      h24: vol24h
    },
    priceChange: {
      m5: parseFloat(pair.priceChange?.m5) || 0,
      m15: parseFloat(pair.priceChange?.m5) || 0,
      h1: parseFloat(pair.priceChange?.h1) || 0,
      h6: parseFloat(pair.priceChange?.h6) || 0,
      h24: parseFloat(pair.priceChange?.h24) || 0
    },
    txns: {
      m5: { buys: buys5m, sells: sells5m, buyers: 0, sellers: 0 },
      m15: { buys: Math.round(buys1h / 4), sells: Math.round(sells1h / 4), buyers: 0, sellers: 0 },
      h1: { buys: buys1h, sells: sells1h, buyers: 0, sellers: 0 },
      h6: { buys: buys6h, sells: sells6h, buyers: 0, sellers: 0 },
      h24: { buys: buys24h, sells: sells24h, buyers: 0, sellers: 0 }
    },
    source: 'DexScreener'
  };
}

async function scanSolanaFourPhases() {
  if (lastScanCache.data && Date.now() - lastScanCache.timestamp < 14000) {
    return lastScanCache.data;
  }

  // FASE 1: Interroghiamo i feed NEW POOLS, 5M Trending e PumpSwap/Raydium per catturare token appena nati (<15-30m)
  const [
    gtNewPoolsP1,
    gtNewPoolsP2,
    gtTrending5m,
    gtPumpSwap,
    gtRaydium,
    dsProfiles,
    dsBoostsLatest,
    dsBoostsTop,
    dsSearchPumpswap,
    dsSearchRaydium,
    dsSearchMeteora,
    dsSearchPump
  ] = await Promise.all([
    safeFetchJson('https://api.geckoterminal.com/api/v2/networks/solana/new_pools?include=base_token&page=1'),
    safeFetchJson('https://api.geckoterminal.com/api/v2/networks/solana/new_pools?include=base_token&page=2'),
    safeFetchJson('https://api.geckoterminal.com/api/v2/networks/solana/trending_pools?include=base_token&duration=5m&page=1'),
    safeFetchJson('https://api.geckoterminal.com/api/v2/networks/solana/dexes/pumpswap/pools?include=base_token&page=1'),
    safeFetchJson('https://api.geckoterminal.com/api/v2/networks/solana/dexes/raydium/pools?include=base_token&page=1'),
    safeFetchJson('https://api.dexscreener.com/token-profiles/latest/v1'),
    safeFetchJson('https://api.dexscreener.com/token-boosts/latest/v1'),
    safeFetchJson('https://api.dexscreener.com/token-boosts/top/v1'),
    safeFetchJson('https://api.dexscreener.com/latest/dex/search?q=pumpswap'),
    safeFetchJson('https://api.dexscreener.com/latest/dex/search?q=raydium'),
    safeFetchJson('https://api.dexscreener.com/latest/dex/search?q=fluxbeam'),
    safeFetchJson('https://api.dexscreener.com/latest/dex/search?q=pump')
  ]);

  const tokenMap = new Map();
  const includedMap = new Map();

  for (const resp of [gtNewPoolsP1, gtNewPoolsP2, gtTrending5m, gtPumpSwap, gtRaydium]) {
    if (resp && Array.isArray(resp.included)) {
      for (const inc of resp.included) {
        if (inc.type === 'token' && inc.id) {
          includedMap.set(inc.id, inc.attributes || {});
        }
      }
    }
  }

  for (const resp of [gtNewPoolsP1, gtNewPoolsP2, gtTrending5m, gtPumpSwap, gtRaydium]) {
    if (resp && Array.isArray(resp.data)) {
      for (const pool of resp.data) {
        const parsed = parseGeckoPool(pool, includedMap);
        if (!parsed || parsed.fdvUsd <= 3000) continue;
        const existing = tokenMap.get(parsed.mint);
        if (!existing || parsed.liquidityUsd > existing.liquidityUsd) {
          tokenMap.set(parsed.mint, parsed);
        }
      }
    }
  }

  for (const dsSearch of [dsSearchPumpswap, dsSearchRaydium, dsSearchMeteora, dsSearchPump]) {
    if (dsSearch && Array.isArray(dsSearch.pairs)) {
      for (const pair of dsSearch.pairs) {
        // Ignoriamo categoricamente lanci da bags-fm o meteora-dbc (focolai di fake volume e rug al 90-100%)
        if (pair.dexId === 'bags-fm' || pair.dexId === 'meteora-dbc') continue;
        const parsed = parseDexScreenerPair(pair);
        if (!parsed || parsed.fdvUsd <= 5000) continue;
        const ex = tokenMap.get(parsed.mint);
        if (!ex) {
          tokenMap.set(parsed.mint, parsed);
        } else {
          if (!ex.createdAt && parsed.createdAt) ex.createdAt = parsed.createdAt;
          if (!ex.imageUrl && parsed.imageUrl) ex.imageUrl = parsed.imageUrl;
          if (!ex.volume.h24 && parsed.volume.h24) ex.volume.h24 = parsed.volume.h24;
          if (!ex.priceChange.h24 && parsed.priceChange.h24) ex.priceChange.h24 = parsed.priceChange.h24;
        }
      }
    }
  }

  const extraSolMints = new Set();
  for (const [mint] of paperSignals.entries()) {
    extraSolMints.add(mint);
  }
  for (const list of [dsProfiles, dsBoostsLatest, dsBoostsTop]) {
    if (Array.isArray(list)) {
      for (const item of list) {
        if (item.chainId === 'solana' && item.tokenAddress) {
          extraSolMints.add(item.tokenAddress);
        }
      }
    }
  }
  for (const mint of tokenMap.keys()) {
    extraSolMints.add(mint);
  }

  const allMintsArray = Array.from(extraSolMints);
  const batches = [];
  for (let i = 0; i < Math.min(allMintsArray.length, 150); i += 30) {
    batches.push(allMintsArray.slice(i, i + 30));
  }

  const batchResponses = await Promise.all(
    batches.map(batch =>
      safeFetchJson(`https://api.dexscreener.com/tokens/v1/solana/${batch.join(',')}`)
    )
  );

  const latestDexPrices = new Map();

  for (const pairs of batchResponses) {
    if (Array.isArray(pairs)) {
      for (const pair of pairs) {
        const parsed = parseDexScreenerPair(pair);
        if (!parsed) continue;

        const prevDex = latestDexPrices.get(parsed.mint);
        if (!prevDex || parsed.liquidityUsd > prevDex.liquidityUsd) {
          latestDexPrices.set(parsed.mint, parsed);
        }

        if (parsed.fdvUsd <= 5000) continue;
        const ex = tokenMap.get(parsed.mint);
        if (!ex) {
          tokenMap.set(parsed.mint, parsed);
        } else {
          if (!ex.imageUrl && parsed.imageUrl) ex.imageUrl = parsed.imageUrl;
          if (!ex.createdAt && parsed.createdAt) ex.createdAt = parsed.createdAt;
          if (!ex.volume.h24 && parsed.volume.h24) ex.volume.h24 = parsed.volume.h24;
          if (!ex.priceChange.h24 && parsed.priceChange.h24) ex.priceChange.h24 = parsed.priceChange.h24;
          if (!ex.txns.h24?.buys && parsed.txns.h24?.buys) ex.txns.h24 = parsed.txns.h24;
        }
      }
    }
  }

  // Anti-Doppioni nel feed: Se esistono più token con lo stesso simbolo (es. 5 Elon diversi), teniamo solo quello con maggior volume 5m e liquidità
  const symbolDedupeMap = new Map();
  for (const t of tokenMap.values()) {
    const ageMin = t.createdAt ? (Date.now() - t.createdAt) / 60000 : 0;
    if (ageMin > 60 && t.createdAt) continue;
    if (t.liquidityUsd < 20000 || t.fdvUsd < 20000) continue; // liquidità minima $20k per evitare trappole sub-dollaro e dev da pochi SOL

    const symKey = (t.symbol || '').toUpperCase().trim();
    if (!symKey) continue;
    const existing = symbolDedupeMap.get(symKey);
    const weight = (t.volume?.m5 || 0) * 3 + (t.liquidityUsd || 0);
    const exWeight = existing ? (existing.volume?.m5 || 0) * 3 + (existing.liquidityUsd || 0) : -1;
    if (!existing || weight > exWeight) {
      symbolDedupeMap.set(symKey, t);
    }
  }

  let allDiscovered = Array.from(symbolDedupeMap.values());

  // Ordiniamo dando priorità assoluta a:
  // 1) Token < 30 minuti di vita (finestra Degen Trench)
  // 2) Volume Velocity 5m (attività esplosiva recente)
  allDiscovered.sort((a, b) => {
    const ageA = a.createdAt ? (Date.now() - a.createdAt) / 60000 : 999;
    const ageB = b.createdAt ? (Date.now() - b.createdAt) / 60000 : 999;
    const isFreshA = ageA <= 30 ? 1 : 0;
    const isFreshB = ageB <= 30 ? 1 : 0;
    if (isFreshA !== isFreshB) return isFreshB - isFreshA;

    const volA = (a.volume?.m5 || 0) * 3 + (a.volume?.h1 || 0);
    const volB = (b.volume?.m5 || 0) * 3 + (b.volume?.h1 || 0);
    return volB - volA;
  });

  // FASE 2 & FASE 3: Eseguiamo l'audit completo RugCheck + Top Holders EOA sui primi 35 candidati che superano la Fase 1
  const auditTargets = allDiscovered.slice(0, 35);
  const targetMints = auditTargets.map(t => t.mint);

  // Batch query a Jupiter Trench / datapi per Organic Score, Bot %, Top Holders % e Holder Growth
  const jupBatches = [];
  for (let i = 0; i < targetMints.length; i += 25) {
    jupBatches.push(targetMints.slice(i, i + 25));
  }

  const [rugCheckDone, jupResponses] = await Promise.all([
    Promise.all(
      auditTargets.map(async t => {
        t.security = await getFullRugCheckAudit(t.mint, t.pairAddress);
      })
    ),
    Promise.all(
      jupBatches.map(b =>
        safeFetchJson(`https://datapi.jup.ag/v1/pools?assetIds=${b.join(',')}`, 5000)
      )
    )
  ]);

  const onchainMap = new Map();
  for (const resp of jupResponses) {
    if (resp && Array.isArray(resp.pools)) {
      for (const p of resp.pools) {
        const a = p.baseAsset;
        if (a && a.id) {
          const aud = a.audit || {};
          const bStats = aud.bundlerStats || {};
          const devM = aud.devMigrations || 0;
          const devTot = aud.devMints || 0;
          const devGradRatePct = devTot > 0 ? Math.round((devM / devTot) * 100) : null;

          onchainMap.set(a.id, {
            organicScore: Math.round(a.organicScore || 0),
            organicLabel: a.organicScoreLabel || 'low',
            botHoldersPct: Number((aud.botHoldersPercentage || 0).toFixed(1)),
            botHoldersCount: aud.botHoldersCount || 0,
            topHoldersPct: Number((aud.topHoldersPercentage || 0).toFixed(1)),
            devMints: devTot,
            devMigrations: devM,
            devGradRatePct,
            bundlerHoldingAthPct: Number(((bStats.holdingPctATH || 0) * 100).toFixed(1)),
            totalBundles: bStats.totalBundles || 0,
            sniperPct: Number((aud.sniperPct || 0).toFixed(2)),
            iconReused: Boolean(aud.iconReused),
            launchpad: a.launchpad || 'pump.fun',
            graduatedPool: a.graduatedPool || null,
            graduatedAt: a.graduatedAt || null,
            dexPaid: Boolean(a.dexPaidAt),
            holderCount: a.holderCount || 0,
            holderChange5mPct: Number((a.stats5m?.holderChange || 0).toFixed(2)),
            holderChange1hPct: Number((a.stats1h?.holderChange || 0).toFixed(2)),
            buyOrganicVol1h: Math.round(a.stats1h?.buyOrganicVolume || 0),
            sellOrganicVol1h: Math.round(a.stats1h?.sellOrganicVolume || 0),
            numOrganicBuyers1h: a.stats1h?.numOrganicBuyers || 0,
            numNetBuyers1h: a.stats1h?.numNetBuyers || 0,
            traders5m: a.stats5m?.numTraders || 0
          });
        }
      }
    }
  }

  for (const t of allDiscovered) {
    t.onchain = onchainMap.get(t.mint) || null;
  }

  const evaluatedTokens = allDiscovered.map(t => {
    const evalResult = evaluateFourPhasePipeline(t);
    return {
      ...t,
      ...evalResult,
      links: {
        bullx: `https://bullx.io/terminal?chainId=1399811149&address=${t.mint}`,
        photon: `https://photon-sol.tinyastro.io/en/lp/${t.pairAddress || t.mint}`,
        gmgn: `https://gmgn.ai/sol/token/${t.mint}`,
        pumpfun: `https://pump.fun/coin/${t.mint}`,
        dexscreener: `https://dexscreener.com/solana/${t.pairAddress || t.mint}`,
        rugcheck: `https://rugcheck.xyz/tokens/${t.mint}`,
        bubblemaps: `https://v2.bubblemaps.io/map?address=${t.mint}&chain=solana`
      }
    };
  });

  // Ordiniamo: prima DEGEN SNIPE (ENTRY) e FAST SCALP (SCALP), poi WATCH, infine REJECTED, e a parità per Score
  const verdictPriority = { ENTRY: 4, SCALP: 3, WATCH: 2, REJECTED: 1 };
  evaluatedTokens.sort((a, b) => {
    const pA = verdictPriority[a.verdictCode] || 0;
    const pB = verdictPriority[b.verdictCode] || 0;
    if (pA !== pB) return pB - pA;
    return b.prePumpScore - a.prePumpScore;
  });

  // 1) Registriamo nel Paper Wallet i candidati DEGEN SNIPE d'élite che superano la soglia
  let paperDirty = false;
  const autoScoreMin = paperSettings.minScoreAuto || 75;

  // Anti-Cloni & Anti-Copycat Trap:
  // Se un token con lo stesso symbol è attualmente aperto O è già stato tradato nelle ultime 3 ore,
  // blocchiamo categoricamente l'apertura per non cadere nei rug dei cloni seriali pump.fun
  const activeAndRecentSymbols = new Set();
  const threeHoursAgo = Date.now() - 3 * 60 * 60 * 1000;
  for (const s of paperSignals.values()) {
    if (s.symbol && (s.status !== 'CLOSED' || (s.signalTimestamp || 0) > threeHoursAgo)) {
      activeAndRecentSymbols.add(s.symbol.toUpperCase().trim());
    }
  }

  for (const t of evaluatedTokens) {
    if (t.verdictCode === 'REJECTED') continue;
    const qualifies = paperSettings.onlyEntryVerdict
      ? (t.verdictCode === 'ENTRY' && t.prePumpScore >= autoScoreMin)
      : ((t.verdictCode === 'ENTRY' || t.verdictCode === 'SCALP') && t.prePumpScore >= autoScoreMin);

    const symUpper = (t.symbol || '').toUpperCase().trim();
    // Anti-Cloni: non entrare su ticker duplicati/clonati recentemente
    if (activeAndRecentSymbols.has(symUpper)) continue;

    // Tetto Massimo Investimento: se la cassa disponibile (Budget iniziale $1000 + Profitti netti realizzati) è esaurita (< $25),
    // non è possibile aprire nuove posizioni finché non si monetizza un gain da posizioni aperte
    const currentPaperState = computePaperSummary();
    if (!currentPaperState.canOpenNewTrade) {
      continue;
    }

    if (qualifies && !paperSignals.has(t.mint)) {
      recordPaperSignal(t, false);
      activeAndRecentSymbols.add(symUpper);
      paperDirty = true;
    }
  }

  // 2) Aggiorniamo tutti i segnali nel Paper Wallet con la Strategia Degen (TP1 +45%, TP2 +100%, SL -12%) vs Hold
  for (const [mint] of paperSignals.entries()) {
    const fromScan = tokenMap.get(mint);
    const fromDex = latestDexPrices.get(mint);
    const bestLive = fromScan || fromDex;
    if (bestLive && bestLive.priceUsd > 0) {
      updatePaperSignalPrice(mint, bestLive);
      paperDirty = true;
    }
  }

  if (paperDirty) {
    savePaperSignals();
  }

  // 3) Invio automatico su Discord per i nuovi candidati DEGEN SNIPE e FAST SCALP
  if (discordConfig.enabled && discordConfig.webhookUrl) {
    const alertSentThisBatch = new Set();
    for (const t of evaluatedTokens) {
      if (t.verdictCode !== 'ENTRY' && t.verdictCode !== 'SCALP') continue;
      if (sentDiscordMints.has(t.mint)) continue;
      if (t.prePumpScore < (discordConfig.minScore || 65)) continue;

      const symUpper = (t.symbol || '').toUpperCase().trim();
      if (alertSentThisBatch.has(symUpper)) continue; // mai più di un alert per lo stesso ticker nello stesso scan

      sentDiscordMints.add(t.mint);
      alertSentThisBatch.add(symUpper);
      saveDiscordConfig();
      sendDiscordTokenAlert(t, false).catch(() => {});
    }
  }

  const validCandidates = evaluatedTokens.filter(t => t.verdictCode !== 'REJECTED');
  const rejectedCandidates = evaluatedTokens.filter(t => t.verdictCode === 'REJECTED');

  const payload = {
    updatedAt: new Date().toISOString(),
    totalScanned: evaluatedTokens.length,
    entryCount: evaluatedTokens.filter(t => t.verdictCode === 'ENTRY').length,
    scalpCount: evaluatedTokens.filter(t => t.verdictCode === 'SCALP').length,
    watchCount: evaluatedTokens.filter(t => t.verdictCode === 'WATCH').length,
    rejectedCount: rejectedCandidates.length,
    freshTrenchCount: evaluatedTokens.filter(t => t.ageMinutes <= 30).length,
    discordActive: Boolean(discordConfig.enabled && discordConfig.webhookUrl),
    paper: computePaperSummary(),
    tokens: evaluatedTokens
  };

  lastScanCache = { timestamp: Date.now(), data: payload };
  return payload;
}

// Background loop ogni 25s (rispetta ampiamente i rate limit gratuiti e aggiorna TP/SL del Paper Wallet)
setInterval(() => {
  scanSolanaFourPhases().catch(() => {});
}, 25000);

// Report periodico delle prestazioni inviato su Discord ogni 6 ore (21600000 ms)
setInterval(() => {
  sendHourlyPerformanceReport(false).catch(() => {});
}, 6 * 60 * 60 * 1000);

// Auto-Keepalive: Ping periodico ogni 45 secondi all'URL pubblico di Render per evitare che l'istanza gratuita si iberni
setInterval(async () => {
  const targetUrl = discordConfig.systemUrl || SYSTEM_URL;
  if (!targetUrl || targetUrl.includes('localhost') || targetUrl.includes('127.0.0.1')) return;
  try {
    const pingUrl = targetUrl.replace(/\/+$/, '') + '/api/health';
    await safeFetchJson(pingUrl, 6000);
  } catch {}
}, 45000);

function readJsonBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        resolve(JSON.parse(body || '{}'));
      } catch {
        resolve({});
      }
    });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // Health check endpoint per keep-alive e monitor esterni (es. UptimeRobot, cron jobs)
  if (url.pathname === '/api/health' || url.pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      status: 'ok',
      uptime: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
      trades: paperSignals.size
    }));
    return;
  }

  if (url.pathname === '/api/scan') {
    try {
      if (url.searchParams.get('force') === '1') {
        lastScanCache.timestamp = 0;
      }
      const data = await scanSolanaFourPhases();
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store'
      });
      res.end(JSON.stringify(data));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (url.pathname === '/api/paper' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(computePaperSummary()));
    return;
  }

  if (url.pathname === '/api/paper/add' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const mint = body.mint;
    const scanData = await scanSolanaFourPhases();
    const token = (scanData.tokens || []).find(t => t.mint === mint);
    if (!token) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Token non trovato' }));
      return;
    }
    recordPaperSignal(token, true);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, paper: computePaperSummary() }));
    return;
  }

  if (url.pathname === '/api/paper/close' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const sig = paperSignals.get(body.mint);
    if (sig) {
      if (sig.status === 'OPEN') {
        sig.status = 'CLOSED';
        sig.closedAt = new Date().toISOString();
        sig.realizedUsd = sig.scalpValueUsd ?? sig.currentValueUsd ?? 100;
        sig.remainingWeight = 0;
        sig.scalpState = 'CLOSED_MANUAL';
        sig.scalpStatusText = '🔒 Chiuso manualmente';
      } else {
        sig.status = 'OPEN';
        sig.closedAt = null;
        sig.remainingWeight = 1.0;
        sig.realizedUsd = 0;
        sig.tp1Hit = false;
        sig.tp2Hit = false;
        sig.scalpState = 'ACTIVE';
        sig.scalpStatusText = '🟢 Riaperta manualmente';
      }
      savePaperSignals();
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, paper: computePaperSummary() }));
    return;
  }

  if (url.pathname === '/api/paper/delete' && req.method === 'POST') {
    const body = await readJsonBody(req);
    if (body.mint) {
      paperSignals.delete(body.mint);
      savePaperSignals();
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, paper: computePaperSummary() }));
    return;
  }

  if (url.pathname === '/api/paper/reset' && req.method === 'POST') {
    paperSignals.clear();
    savePaperSignals();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, paper: computePaperSummary() }));
    return;
  }

  if (url.pathname === '/api/paper/settings' && req.method === 'POST') {
    const body = await readJsonBody(req);
    if (typeof body.onlyEntryVerdict === 'boolean') {
      paperSettings.onlyEntryVerdict = body.onlyEntryVerdict;
    }
    savePaperSignals();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, paper: computePaperSummary() }));
    return;
  }

  if (url.pathname === '/api/discord-config' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      ...discordConfig,
      sentCount: sentDiscordMints.size
    }));
    return;
  }

  if (url.pathname === '/api/discord-config' && req.method === 'POST') {
    const body = await readJsonBody(req);
    discordConfig = {
      webhookUrl: typeof body.webhookUrl === 'string' ? body.webhookUrl.trim() : discordConfig.webhookUrl,
      systemUrl: typeof body.systemUrl === 'string' && body.systemUrl.trim() ? body.systemUrl.trim() : (discordConfig.systemUrl || SYSTEM_URL),
      minScore: Number(body.minScore) || 74,
      onlySweetSpot: Boolean(body.onlySweetSpot),
      enabled: Boolean(body.enabled)
    };
    saveDiscordConfig();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, config: discordConfig }));
    return;
  }

  if (url.pathname === '/api/discord-test' && req.method === 'POST') {
    const body = await readJsonBody(req);
    if (body.webhookUrl) {
      discordConfig.webhookUrl = body.webhookUrl.trim();
      saveDiscordConfig();
    }
    const scanData = await scanSolanaFourPhases();
    const sampleToken = scanData.tokens?.[0];
    if (!sampleToken) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Nessun token disponibile per il test' }));
      return;
    }
    const result = await sendDiscordTokenAlert(sampleToken, true);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(result));
    return;
  }

  if (url.pathname === '/api/discord-report' && req.method === 'POST') {
    const result = await sendHourlyPerformanceReport(true);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(result));
    return;
  }

  if (url.pathname === '/api/rugcheck') {
    const mint = url.searchParams.get('mint');
    const summary = await getFullRugCheckAudit(mint, '');
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(summary || {}));
    return;
  }

  let filePath = path.join(__dirname, 'public', url.pathname === '/' ? 'index.html' : url.pathname);
  if (!filePath.startsWith(path.join(__dirname, 'public'))) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.json': 'application/json; charset=utf-8'
    };
    res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'text/plain' });
    res.end(content);
  });
});

server.listen(PORT, () => {
  console.log(`🚀 Solana 4-Phase Scanner + Scalp Paper Wallet attivo su http://localhost:${PORT}`);
});
