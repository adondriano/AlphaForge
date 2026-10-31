# Connecting a broker

AlphaForge reaches your broker over its public HTTP API. There is no terminal to
install, no background agent to keep alive and no tunnel to configure — the
engine on Vercel talks to the broker directly.

* * *

## 0. Read this first

Older versions of AlphaForge connected through **MetaTrader 5**. That path is
gone, and deliberately so:

```
MetaTrader5 is a Windows-only C extension that attaches to a terminal process
on the SAME machine via local IPC. It does not speak TCP.

    hosted engine (Linux)  ✗  cannot import it
                           ✗  cannot reach your terminal
```

Working around that needed a Windows agent, a Supabase relay and a heartbeat —
moving parts that only existed to work around one library. Brokers that publish
a real API do not have that problem:

```
┌──────────────┐   HTTPS   ┌──────────────┐   HTTPS   ┌──────────┐
│  dashboard   │ ────────► │  engine      │ ────────► │  broker  │
│  (Vercel)    │           │  (Vercel)    │           │  API     │
└──────────────┘           └──────────────┘           └──────────┘
     anywhere                  anywhere                 anywhere
```

You need **no local software at all** to trade live.

**What you need:** an account with a supported broker, API credentials for it,
and about five minutes.

* * *

## 1. Supported brokers

| Broker | How you authenticate | Notes |
| --- | --- | --- |
| **Exness** | Ed25519 request signing (API key + private key) | Exness Terminal accounts only — standard MT5 accounts cannot use it |
| **OANDA** | Bearer token | Best-documented. Practice and live hosts |
| **Capital.com** | Session token (re-auth each call) | Demo and live hosts |
| **IG** | Session token (re-auth each call) | Instruments are **epics**, e.g. `CS.D.XAUUSD.TODAY.IPO` |
| **cTrader** (IC Markets, Pepperstone, FxPro…) | OAuth bearer token | You register an app and complete the OAuth flow yourself |

Exness is the only one of these that does **not** route through MetaTrader, so
it is the cleanest fit for a hosted deployment.

> **⚠️ Exness availability.** Exness states the API is only available in certain
> regions as it rolls out, and only for **Exness Terminal** accounts — a standard
> MetaTrader account will not work even with correct keys. Log in to your
> Personal Area and look for an **API / Key Management** page. If it is not
> there, you are not eligible yet and should use a different broker from the
> table.

* * *

## 2. Connect in three steps

1. Open **Settings → Broker connection**.
2. Pick your broker from the dropdown.
3. Fill in the fields it asks for and press **Save & connect**.

The form is generated from each broker's own field descriptors, so it asks for
exactly what that broker needs and nothing else.

Behind the button, AlphaForge validates the credentials, stores them **encrypted**,
and then immediately tries a live call. You get one of three answers:

| Result | Meaning |
| --- | --- |
| `connected` | Credentials work and the account is reachable |
| `disconnected` | Saved, but the broker rejected them — the reason is shown |
| `halted` | A connection exists but is broken. **Trading stops** — see §5 |

* * *

## 3. Per-broker credential walkthrough

### Exness

1. Sign in to the [Exness Personal Area](https://www.exness.com/) and complete
   full KYC (proof of identity **and** proof of address).
2. Open the **API** page and create a key with trading access.
3. Copy three values:
   - **Account ID** — the numeric Exness Terminal account number
   - **API Key** — starts `exnsk-`
   - **Private Key** — shown once, either 128 hex characters or a PEM block
4. In AlphaForge, also copy the **Gateway URL** from the DNS widget in Key
   Management if one is shown. Otherwise the default is used.

> The private key is shown **once**. If you lose it, generate a new key pair —
> it cannot be recovered.

Security detail worth knowing: AlphaForge signs every request with Ed25519. The
payload covers the API key, timestamp, method, path and a SHA-256 of the body,
so a request cannot be tampered with in transit or replayed later. The
implementation is verified against Exness's published test vector — see
`backend/test_brokers.py::test_exness_signing_matches_official_vector`.

### OANDA

1. Log in to OANDA and open **Manage API Access**.
2. Generate a personal access token.
3. Copy your **Account ID** (`101-001-…`) and the token.
4. Leave **Environment** blank for the practice host; type `live` to trade real
   money.

OANDA names pairs with an underscore — `XAU_USD`, `EUR_USD`. AlphaForge
translates automatically, so keep using `XAUUSD` in your strategies.

### Capital.com

1. In the Capital.com web platform go to **Settings → API** and create an API key.
2. Generate a dedicated **API password** in the app.
3. Enter your email, that password, and the API key.
4. Leave **Environment** blank for demo; type `live` for real money.

Capital.com sessions lapse after a few idle minutes. Because the engine runs
serverless and cannot hold a session open, it re-authenticates at the start of
every call. Slightly slower, but a dead session is impossible.

### IG

1. In My Account → **Settings → API keys**, create a key.
2. Enter your IG **username** (not email), password and that key.
3. IG identifies instruments by **epic**, not ticker. Search for one in the
   symbol picker — for gold you will get something like
   `CS.D.XAUUSD.TODAY.IPO`.

### cTrader (IC Markets, Pepperstone, FxPro…)

cTrader has no simple API key. You register an app in the cTrader developer
portal, complete the OAuth flow once, and paste the result in:

- **API Base URL** — your broker's Open API host. It differs per broker and per
  environment, which is why it is required rather than guessed.
- **Access Token** — from the OAuth flow.
- **ctidTraderAccountId** — the numeric cTrader account id, not your login.

* * *

## 4. How your credentials are stored

These keys move real money, so they are handled differently from every other
setting:

- **Encrypted before they reach the database.** AES-256-GCM with a fresh nonce
  per write. GCM is authenticated, so a tampered row fails to decrypt rather
  than decrypting to garbage.
- **The key lives in the environment, never in the database.** Set
  `ALPHAFORGE_CRED_KEY`. A database dump on its own is useless without it.
- **Row-level security** restricts every connection to its owner.
- **Never returned to the browser.** The API strips the ciphertext before a row
  leaves the engine — see `broker_vault.public_row()`.

> **Rotating `ALPHAFORGE_CRED_KEY` invalidates every saved connection.** Users
> re-enter their credentials and that is it — no data loss, no silent breakage.
> Change it deliberately.

* * *

## 5. Two different offline states

This distinction matters, so it is worth stating plainly.

| Mode | Cause | What happens to orders |
| --- | --- | --- |
| `shadow` | **No** broker connection configured | Paper-filled, deterministically. This is the default studio experience |
| `halted` | A connection exists but is **broken** | **Orders stop.** No paper fill is substituted |

A dead broker must never look like a working one. If AlphaForge silently
paper-filled when your broker went down, a strategy would appear to trade
normally while placing nothing — and with a 3.5% daily drawdown limit and
emergency liquidation configured, a silent failure is exactly how a breach goes
unnoticed.

Halting is loud: the dashboard banner turns rose, the panel says why, and the
order result carries `mode: "halted"`.

* * *

## 6. Symbols your broker does not offer

Some brokers do not expose every asset class through their API. Exness, for
example, has no stock or index instruments.

AlphaForge **warns** rather than silently filtering. If a strategy targets
`NAS100` on Exness you will see:

> Exness does not offer indices and stocks through its API — NAS100 will not
> trade. Pick a forex, metal or crypto symbol.

and the order is **halted**, not paper-filled.

* * *

## 7. Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| "Sign in to connect a broker" | Connections are per account. Log in first |
| "Credential storage is not configured" | The engine needs `NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`. See §4 |
| "Could not decrypt stored credentials" | `ALPHAFORGE_CRED_KEY` changed. Re-enter the credentials |
| **`Exness 401` with no error code** | Almost always the **Gateway URL**. Exness issues the HTTPS Gateway per account in Key Management's DNS widget — there is no public default, and the placeholder in the form is only an example. Paste the exact value Exness shows |
| **`Exness 401 (1000)`** `AUTH_INVALID_API_KEY` | Exness does not recognise that API key. Re-copy the whole `exnsk-…` value with no stray spaces, confirm it is still active, and confirm eligibility (region-limited, Exness Terminal account only) |
| **`Exness 401 (1001)`** `AUTH_INVALID_SIGNATURE` | The private key does not belong to that API key. Exness shows the private key **once** — if it was not saved at creation, generate a new key pair and paste both halves in together |
| **`Exness 401 (1002)`** `AUTH_PERMISSION_DENIED` | The key exists but lacks the trading scope. Recreate it in Key Management with order and position permissions enabled |
| Saved but never connects (Exness) | Wrong Gateway URL, or the account is a standard MT5 account rather than an Exness Terminal account |
| Saved but never connects (OANDA) | Wrong environment. Blank = practice, `live` = real money |
| Exness live price never appears | Market data is stream-only. The `websockets` package must be installed and the WebSocket URL must be correct |
| "No tick arrived for X" | The symbol is not tradeable on that account, or the broker is closed |
| Orders return `settled: false` | Exness and cTrader acknowledge first and settle asynchronously. Check the broker's own app for the fill |
| Candles empty on Exness | Exness candle history is stream-only and that subscription is not verified in this build. Backtests use AlphaForge's own data |

* * *

## 8. Quick reference

**Endpoints**

```
GET    /api/brokers                      provider catalogue + credential fields
GET    /api/broker/status                connection state (authenticated)
GET    /api/broker/price?symbol=XAUUSD   live quote
GET    /api/broker/candles               candle history
GET    /api/broker/symbols               tradeable symbols
GET    /api/broker/connections           your saved connections
POST   /api/broker/connections           save + test
DELETE /api/broker/connections/{id}      remove
```

Broker endpoints require the caller's Supabase JWT in `Authorization`. Unlike
the strategy endpoints they will not take a `user_id` from the request body —
these keys move real money.

**Where the code lives**

```
backend/services/brokers/
├── base.py         the BrokerProvider contract + shared result shapes
├── exness.py       Ed25519 signing, Access Point discovery, REST + WS
├── oanda.py        v20 REST
├── capitalcom.py   session token
├── ig.py           session token + epics
├── ctrader.py      OAuth bearer
└── __init__.py     the registry — add a broker here and nowhere else
backend/services/broker_vault.py    AES-256-GCM credential storage
backend/services/broker_service.py  execution facade (shadow vs halted)
```

**Adding a broker** — subclass `BrokerProvider`, set `id`/`label`/`fields`,
implement the calls you support, and list the class in
`services/brokers/__init__.py`. The Settings form, the API and the engine pick
it up automatically.

* * *

## 9. Still stuck?

1. Check `/api/health` → `integrations.brokers` for the provider list and
   whether credential storage is enabled.
2. Confirm the credentials work against the broker's own API docs first. If they
   fail there, the problem is not AlphaForge.
3. Open an issue with the broker, the endpoint and the exact error text — but
   never your keys.
