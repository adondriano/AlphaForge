"""Exness Public Trader API.

Exness is the one broker in the dropdown that does *not* route through
MetaTrader, so the hosted engine can reach it directly over HTTPS — no bridge
agent, no Windows machine, no relay.

Two hosts are involved. The **Gateway** only answers one question ("which
Access Point owns this account?") and answers it slowly, so the result is
cached. Everything else goes to the **Access Point**.

Request signing (EXN-* headers)
-------------------------------
Every request carries a JSON payload in ``EXN-DATA`` (base64url, no padding)
and its Ed25519 signature in ``EXN-SIGN``. The payload records the api key,
idempotency key, timestamp, sign version, method, path-with-query and the
SHA-256 of the body. The signature covers the *decoded* payload bytes, so the
payload must be serialised exactly once and those same bytes signed — any
re-serialisation produces a signature Exness rejects.

``sign_headers`` is verified against the RFC 8032 test vector published in the
Exness docs; see ``test_brokers.py::test_exness_signing_matches_official_vector``.
"""

from __future__ import annotations

import base64
import hashlib
import json
import re
import time
import uuid
from typing import Any, Dict, List, Optional, Tuple

import httpx

from .base import (
    MODE_LIVE,
    BrokerProvider,
    CredentialField,
    candles_result,
    describe_exception,
    instrument_class,
    now_iso,
    price_result,
    shadow_fill,
    unavailable,
)

#: SHA-256 of the empty byte sequence — the body hash for every GET.
EMPTY_BODY_HASH = "47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU"

#: Example only — this host is not a real Exness gateway and never connects.
#: Exness issues the Gateway per account in the DNS widget in Key Management
#: and there is no public default, so the field can only ever offer a shape to
#: copy. Because it is displayed as the field's placeholder it has also been
#: pasted in verbatim, so it is treated as "not supplied" everywhere below.
DEFAULT_GATEWAY = "https://gateway.exness.com"
SIGN_VERSION = 1

#: Market-data host. Also an example: if the DNS widget gives you a realtime
#: host, set it in the WebSocket URL field and this is never used.
DEFAULT_WS_URL = "wss://ws.api.exness.com"

GATEWAY_HINT = (
    "Exness issues the real Gateway per account in the DNS widget in Key "
    "Management, and there is no public default — paste that exact value into "
    "the Gateway URL field. https://gateway.exness.com is only an example and "
    "will never connect."
)

#: What to do about each public auth error, in plain language.
#:
#: A bare "401" is not actionable: it covers three distinct failures, each with
#: a different fix, and the only thing separating them is the error code in the
#: response body. These are surfaced verbatim so the user is told what to change
#: rather than merely that something is wrong.
AUTH_HINTS = {
    1000: (
        "AUTH_INVALID_API_KEY — Exness did not recognise this API key. Check you "
        "copied the whole 'exnsk-…' value with no stray spaces, that it is still "
        "active in Key Management, and that the account is eligible: the API is "
        "region-limited and needs an Exness Terminal account (a standard "
        "MetaTrader account will not work even with correct keys)."
    ),
    1001: (
        "AUTH_INVALID_SIGNATURE — this private key does not belong to that API "
        "key. Exness shows the private key only once, so if it was not saved "
        "when the key was created you must generate a fresh key pair and paste "
        "both halves in together."
    ),
    1002: (
        "AUTH_PERMISSION_DENIED — the key exists but lacks the trading scope. "
        "Recreate it in Key Management with order and position permissions "
        "enabled."
    ),
}

_HEX_KEY = re.compile(r"^[0-9a-fA-F]{128}$")
_ACCOUNT_ID = re.compile(r"^[1-9][0-9]*$")

# Access Point lookups are rate limited and stable, so cache them briefly.
_AP_CACHE: Dict[str, Tuple[str, float]] = {}
_AP_TTL_SECONDS = 900.0


class ExnessError(RuntimeError):
    """A rejected Exness call, carrying the public error code when present."""


def b64url(raw: bytes) -> str:
    """base64url without ``=`` padding, as Exness requires."""
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def load_signing_key(text: str):
    """Load an Ed25519 private key from 128 hex chars or a PKCS#8 PEM.

    Exness hands out keys as 128 hex characters: a 32-byte seed followed by the
    32-byte public half. The public half is checked against the seed so a
    truncated or mismatched key fails here instead of producing signatures the
    server silently rejects.
    """
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

    text = (text or "").strip()
    if not text:
        raise ExnessError("Private key is empty.")

    if text.startswith("-----BEGIN PRIVATE KEY-----"):
        key = serialization.load_pem_private_key(text.encode(), password=None)
        if not isinstance(key, Ed25519PrivateKey):
            raise ExnessError("Expected an Ed25519 private key.")
        return key

    if not _HEX_KEY.match(text):
        raise ExnessError(
            "Private key must be 128 hex characters or an unencrypted PKCS#8 PEM."
        )

    raw = bytes.fromhex(text)
    key = Ed25519PrivateKey.from_private_bytes(raw[:32])
    public = key.public_key().public_bytes(
        serialization.Encoding.Raw, serialization.PublicFormat.Raw
    )
    if public != raw[32:]:
        raise ExnessError("Private key public half does not match its seed.")
    return key


def sign_headers(
    api_key: str,
    private_key,
    method: str,
    path_with_query: str,
    body: bytes = b"",
    *,
    idempotency_key: str = "",
    timestamp_ms: Optional[int] = None,
) -> Dict[str, str]:
    """Build the six EXN-* headers for one request."""
    timestamp = int(timestamp_ms if timestamp_ms is not None else time.time() * 1000)
    payload = json.dumps(
        {
            "api_key": api_key,
            "idempotency_key": idempotency_key,
            "timestamp": timestamp,
            "sign_version": SIGN_VERSION,
            "method": method.upper(),
            "path": path_with_query,
            "body_hash": b64url(hashlib.sha256(body).digest()),
        },
        separators=(",", ":"),
        ensure_ascii=False,
    ).encode("utf-8")

    return {
        "EXN-API-KEY": api_key,
        "EXN-IDEMPOTENCY-KEY": idempotency_key,
        "EXN-TIMESTAMP": str(timestamp),
        "EXN-SIGN-VERSION": str(SIGN_VERSION),
        "EXN-DATA": b64url(payload),
        "EXN-SIGN": b64url(private_key.sign(payload)),
    }


def _base_url(value: str) -> str:
    """Keep only scheme+host. Signed paths must not inherit stray paths."""
    from urllib.parse import urlsplit

    parts = urlsplit((value or "").strip())
    if parts.scheme != "https" or not parts.hostname:
        raise ExnessError(f"Expected an HTTPS base URL, got {value!r}.")
    return f"https://{parts.netloc}"


def is_placeholder_gateway(value: str) -> bool:
    """True when the value is the example host rather than a real gateway.

    The placeholder is rendered as the field's placeholder, so it ends up
    pasted in as if it were a real value. Counting that as "supplied" let the
    exact failure it causes through without a hint.
    """
    from urllib.parse import urlsplit

    try:
        return (
            urlsplit((value or "").strip()).hostname
            == urlsplit(DEFAULT_GATEWAY).hostname
        )
    except Exception:
        return False


class ExnessProvider(BrokerProvider):
    id = "exness"
    label = "Exness"
    docs_url = "https://www.exness-api.com/"
    # The current API version does not expose stocks or indices.
    unsupported = ("index", "stock")

    fields = (
        CredentialField(
            key="account_id",
            label="Account ID",
            placeholder="15000044623",
            help="The numeric Exness Terminal account number — not an MT5 login.",
        ),
        CredentialField(
            key="api_key",
            label="API Key",
            placeholder="exnsk-…",
            help="Public key identifier from Exness → Personal Area → API.",
        ),
        CredentialField(
            key="private_key",
            label="Private Key",
            secret=True,
            placeholder="128 hex characters or -----BEGIN PRIVATE KEY-----",
            help="Shown once when you create the key. Stored encrypted.",
        ),
        CredentialField(
            key="gateway",
            label="Gateway URL",
            # A template rather than a plausible-looking host: the previous
            # placeholder read like a real address and got pasted in, which
            # then failed as an opaque transport error.
            placeholder="https://<gateway-from-key-management>",
            help=(
                "Required. The HTTPS Gateway shown in the DNS widget in "
                "Exness → Personal Area → Key Management. It is issued per "
                "account and there is no public default."
            ),
            required=True,
        ),
        CredentialField(
            key="ws_url",
            label="WebSocket URL",
            placeholder="wss://<ws-host-from-key-management>",
            help=(
                "Market data is stream-only. Override if the DNS widget gives "
                "you a different realtime host."
            ),
            required=False,
        ),
    )

    # ------------------------------------------------------------------
    # credentials
    # ------------------------------------------------------------------
    def validate(self, creds: Dict[str, Any]) -> Optional[str]:
        missing = self.missing_fields(creds)
        if missing:
            return f"Missing {', '.join(missing)}."
        account_id = str(creds.get("account_id") or "").strip()
        if not _ACCOUNT_ID.match(account_id) or int(account_id) > 2 ** 64 - 1:
            return "Account ID must be a positive number."
        # Catch the example host before it is stored. Left until connect time it
        # surfaces as an opaque transport error that looks like a network fault.
        gateway = str(creds.get("gateway") or "").strip()
        if gateway and is_placeholder_gateway(gateway):
            return f"Gateway URL is still the example value. {GATEWAY_HINT}"
        try:
            load_signing_key(str(creds.get("private_key") or ""))
        except ExnessError as exc:
            return str(exc)
        return None

    def _key(self, creds: Dict[str, Any]):
        return load_signing_key(str(creds.get("private_key") or ""))

    # ------------------------------------------------------------------
    # transport
    # ------------------------------------------------------------------
    def _access_point(self, creds: Dict[str, Any]) -> str:
        """Resolve (and cache) the Access Point that owns this account."""
        account_id = str(creds.get("account_id") or "").strip()
        cached = _AP_CACHE.get(account_id)
        if cached and (time.time() - cached[1]) < _AP_TTL_SECONDS:
            return cached[0]

        supplied = str(creds.get("gateway") or "").strip()
        gateway = _base_url(supplied or DEFAULT_GATEWAY)
        # A pasted example counts as no gateway at all, otherwise this failure
        # arrives with no hint — exactly as it did the first time.
        placeholder = not supplied or is_placeholder_gateway(gateway)
        path = f"/v1/trading/access-point?account_id={account_id}"
        try:
            data = self._request(creds, "GET", gateway, path)
        except ExnessError as exc:
            if placeholder:
                raise ExnessError(
                    f"{exc} — the Gateway URL is the example value, not a real "
                    f"gateway. {GATEWAY_HINT}"
                ) from exc
            raise
        except Exception as exc:
            # Not an API rejection at all — the host could not be reached. A
            # bare errno here («[Errno 16] Device or resource busy») tells
            # nobody anything, so name the cause and keep the detail.
            suffix = (
                f" — the Gateway URL is the example value, not a real gateway. "
                f"{GATEWAY_HINT}"
                if placeholder
                else ""
            )
            raise ExnessError(
                f"Could not reach the gateway ({gateway}): "
                f"{describe_exception(exc)}{suffix}"
            ) from exc
        value = data.get("access_point")
        if not isinstance(value, str) or not value:
            raise ExnessError("Access point discovery returned no access_point.")

        host = _base_url(value)
        _AP_CACHE[account_id] = (host, time.time())
        return host

    def _request(
        self,
        creds: Dict[str, Any],
        method: str,
        host: str,
        path_with_query: str,
        body: Optional[Dict[str, Any]] = None,
        *,
        idempotency_key: Optional[str] = None,
        timeout: float = 12.0,
    ) -> Dict[str, Any]:
        raw = b"" if body is None else json.dumps(body, separators=(",", ":")).encode()
        headers = sign_headers(
            str(creds.get("api_key") or "").strip(),
            self._key(creds),
            method,
            path_with_query,
            raw,
            idempotency_key=idempotency_key or ("" if method.upper() == "GET" else self._idem()),
        )
        if body is not None:
            headers["Content-Type"] = "application/json"

        # Signed headers must never be replayed at a redirect target.
        with httpx.Client(timeout=timeout, follow_redirects=False) as client:
            response = client.request(
                method.upper(),
                f"{host}{path_with_query}",
                headers=headers,
                content=raw or None,
            )

        if response.status_code >= 400:
            raise ExnessError(self._error_text(response))

        if not response.content:
            return {}
        try:
            decoded = response.json()
        except ValueError:
            raise ExnessError(f"Exness returned a non-JSON response ({response.status_code}).")
        if isinstance(decoded, dict) and decoded.get("error"):
            raise ExnessError(self._error_text(response, decoded))
        return decoded if isinstance(decoded, dict) else {"data": decoded}

    @staticmethod
    def _idem() -> str:
        return f"af-{uuid.uuid4().hex}"

    @staticmethod
    def _error_text(response: "httpx.Response", payload: Optional[Dict] = None) -> str:
        """Turn an Exness error response into something a human can act on.

        Reports the public code whenever one is present and attaches the
        matching fix from :data:`AUTH_HINTS`. When the body carries no code —
        a 401 with an empty body, typically — it says the likely cause instead
        of returning a blank message.
        """
        blob: Dict[str, Any] = {}
        try:
            blob = payload or response.json() or {}
        except ValueError:
            blob = {}
        if not isinstance(blob, dict):
            blob = {}

        raw_error = blob.get("error")
        error = raw_error if isinstance(raw_error, dict) else {}
        code = error.get("code") or blob.get("code")
        message = (
            error.get("error_message")
            or blob.get("error_message")
            or blob.get("message")
            or ""
        )
        body = (response.text or "").strip()[:200]

        try:
            code_int = int(code) if code is not None else None
        except (TypeError, ValueError):
            code_int = None

        head = f"Exness {response.status_code}"
        if code is not None:
            head += f" ({code})"
        if message:
            head += f": {message}"

        parts = [head]
        hint = AUTH_HINTS.get(code_int) if code_int is not None else None
        if hint:
            parts.append(hint)
        elif response.status_code == 401:
            # No parsable code. An empty 401 body usually means we reached the
            # wrong host entirely, not that the key is wrong.
            parts.append(
                "The Gateway URL is probably wrong. Exness issues a per-account "
                "HTTPS Gateway in Key Management (DNS widget) and there is no "
                "public default — paste the exact value shown there."
            )
        elif response.status_code == 403:
            parts.append(
                "The key authenticated but is not allowed to do this. Check its "
                "scopes in Key Management."
            )
        if body and not message:
            parts.append(f"Response: {body}")
        return " — ".join(parts)

    # ------------------------------------------------------------------
    # account
    # ------------------------------------------------------------------
    def status(self, creds: Dict[str, Any]) -> Dict[str, Any]:
        problem = self.validate(creds)
        if problem:
            return {"available": False, "connected": False, "mode": "unavailable",
                    "configured": False, "reason": problem}
        try:
            host = self._access_point(creds)
            account_id = str(creds.get("account_id") or "").strip()
            data = self._request(
                creds, "GET", host, f"/v1/configuration/accounts/{account_id}/account"
            )
        except Exception as exc:
            return {"available": False, "connected": False, "mode": "unavailable",
                    "configured": True, "reason": describe_exception(exc)}

        account = data.get("account") if isinstance(data.get("account"), dict) else data
        return {
            "available": True,
            "connected": True,
            "mode": MODE_LIVE,
            "configured": True,
            "provider": self.id,
            "account": {
                "login": account.get("account_id") or account_id,
                "server": "Exness",
                "balance": _num(account.get("balance")),
                "equity": _num(account.get("equity")),
                "margin": _num(account.get("margin")),
                "free_margin": _num(account.get("free_margin") or account.get("margin_free")),
                "currency": account.get("currency"),
                "leverage": _num(account.get("leverage")),
                "name": account.get("name") or account.get("account_name"),
                "broker": "Exness",
            },
            "via": "broker",
        }

    # ------------------------------------------------------------------
    # market data — Exness streams ticks; REST has no quote endpoint
    # ------------------------------------------------------------------
    def price(self, creds: Dict[str, Any], symbol: str) -> Dict[str, Any]:
        problem = self.validate(creds)
        if problem:
            return unavailable(problem, symbol=symbol)
        warning = self.warnings_for(symbol)
        if warning:
            return unavailable(warning[0], symbol=symbol)

        try:
            ticks = self._stream_ticks(creds, [symbol], timeout=4.0)
        except Exception as exc:
            return unavailable(describe_exception(exc), symbol=symbol)

        tick = ticks.get(symbol)
        if not tick:
            return unavailable(
                f"No tick arrived for {symbol}. Exness streams market data over "
                "WebSocket only — check the WebSocket URL in the connection settings.",
                symbol=symbol,
            )
        bid = float(tick.get("bid") or 0.0)
        ask = float(tick.get("ask") or 0.0)
        digits = int(tick.get("digits") or _digits_for(symbol))
        return price_result(symbol, bid, ask, digits, last=ask,
                            when=int(tick.get("timestamp") or 0), via="exness-ws")

    def candles(
        self,
        creds: Dict[str, Any],
        symbol: str,
        timeframe: str = "H1",
        count: int = 120,
    ) -> Dict[str, Any]:
        """Candles come from the same stream; without history we build nothing.

        Exness publishes candle history through the WebSocket feed. Until that
        subscription is confirmed against a live account this refuses to
        fabricate a series — an empty chart beats a chart of invented prices.
        """
        return unavailable(
            "Exness candle history is only available over the streaming feed and "
            "this build has not verified that subscription yet. Live price still "
            "works; backtests use AlphaForge's own data.",
            symbol=symbol,
            timeframe=timeframe,
            candles=[],
        )

    def symbols(self, creds: Dict[str, Any], needle: str = "") -> Dict[str, Any]:
        problem = self.validate(creds)
        if problem:
            return {"available": False, "symbols": [], "reason": problem}
        try:
            host = self._access_point(creds)
            account_id = str(creds.get("account_id") or "").strip()
            data = self._request(
                creds, "GET", host, f"/v1/configuration/accounts/{account_id}/instruments"
            )
        except Exception as exc:
            return {"available": False, "symbols": [], "reason": describe_exception(exc)}

        rows = data.get("instruments") or data.get("data") or []
        names = sorted({str(r.get("name") or r.get("instrument") or r) for r in rows if r})
        term = (needle or "").strip().lower()
        if term:
            names = [n for n in names if term in n.lower()]
        return {"available": True, "symbols": names[:500], "via": "broker"}

    # ------------------------------------------------------------------
    # trading
    # ------------------------------------------------------------------
    def place_order(self, creds: Dict[str, Any], order: Dict[str, Any]) -> Dict[str, Any]:
        problem = self.validate(creds)
        if problem:
            return shadow_fill(order, problem)

        symbol = str(order.get("symbol") or "").upper()
        warning = self.warnings_for(symbol)
        if warning:
            return shadow_fill(order, warning[0])

        side = "buy" if str(order.get("side") or "").lower() in {"buy", "long"} else "sell"
        body: Dict[str, Any] = {
            "instrument": symbol,
            "side": side,
            "volume": str(order.get("volume") or 0.01),
            "comment": "alphaforge",
        }
        if order.get("stop_loss"):
            body["stop_loss"] = str(order["stop_loss"])
        if order.get("take_profit"):
            body["take_profit"] = str(order["take_profit"])

        idem = self._idem()
        try:
            host = self._access_point(creds)
            account_id = str(creds.get("account_id") or "").strip()
            ack = self._request(
                creds,
                "POST",
                host,
                f"/v1/trading/accounts/{account_id}/positions",
                body,
                idempotency_key=idem,
                timeout=15.0,
            )
        except Exception as exc:
            return {**shadow_fill(order, describe_exception(exc)), "mode": "live"}

        return {
            # Exness ACKs first and settles asynchronously, so "executed" here
            # means "accepted by the broker", not "filled".
            "executed": True,
            "settled": False,
            "mode": MODE_LIVE,
            "ticket": ack.get("operation_id") or idem,
            "operation_id": ack.get("operation_id"),
            "client_request_id": ack.get("client_request_id") or idem,
            "symbol": symbol,
            "side": side,
            "volume": order.get("volume"),
            "price": order.get("price"),
            "status": ack.get("status"),
            "note": "Accepted by Exness; the fill arrives over server events.",
            "filled_at": now_iso(),
            "via": "broker",
        }

    # ------------------------------------------------------------------
    # websocket (optional dependency)
    # ------------------------------------------------------------------
    def _stream_ticks(
        self, creds: Dict[str, Any], symbols: List[str], timeout: float = 4.0
    ) -> Dict[str, Dict[str, Any]]:
        """Open a signed socket, collect the first tick per symbol, close.

        ``websockets`` is an optional dependency; when it is missing the caller
        gets a clear reason rather than an ImportError at import time.
        """
        import asyncio

        try:
            import websockets  # type: ignore
        except Exception as exc:  # pragma: no cover - depends on install
            raise ExnessError(
                "The `websockets` package is not installed, so Exness market "
                "data cannot be streamed. Install it to enable live quotes."
            ) from exc

        ws_url = str(creds.get("ws_url") or "").strip() or DEFAULT_WS_URL
        account_id = str(creds.get("account_id") or "").strip()
        path = f"/v1/ticks/accounts/{account_id}/ws/ticks"
        headers = sign_headers(
            str(creds.get("api_key") or "").strip(),
            self._key(creds),
            "GET",
            path,
            idempotency_key="",  # signed GET handshakes send an empty key
        )

        async def collect() -> Dict[str, Dict[str, Any]]:
            found: Dict[str, Dict[str, Any]] = {}
            deadline = asyncio.get_event_loop().time() + timeout
            async with websockets.connect(  # type: ignore
                f"{ws_url}{path}",
                additional_headers=headers,
                subprotocols=["exness-ws-protocol"],
                open_timeout=timeout,
            ) as socket:
                await socket.send(json.dumps({
                    "action": "subscribe",
                    "id": "alphaforge-1",
                    "instruments": symbols,
                }))
                while asyncio.get_event_loop().time() < deadline:
                    remaining = deadline - asyncio.get_event_loop().time()
                    if remaining <= 0:
                        break
                    try:
                        message = await asyncio.wait_for(socket.recv(), remaining)
                    except asyncio.TimeoutError:
                        break
                    payload = json.loads(message)
                    tick = payload.get("tick") or payload
                    name = str(tick.get("instrument") or tick.get("symbol") or "").upper()
                    if name in {s.upper() for s in symbols} and name not in found:
                        found[name] = tick
                    if len(found) == len(symbols):
                        break
            return found

        return asyncio.run(collect())


def _num(value: Any) -> Optional[float]:
    """Exness sends monetary values as decimal strings."""
    if value is None or value == "":
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _digits_for(symbol: str) -> int:
    kind = instrument_class(symbol)
    if kind == "forex":
        return 5
    if kind == "crypto":
        return 2
    return 3
