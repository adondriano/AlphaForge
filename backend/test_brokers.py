"""Broker provider, vault and execution-facade tests.

The Exness signing test is the important one: it checks AlphaForge's signature
against the RFC 8032 test vector Exness publishes, so the trickiest part of the
integration is verified without anyone's real credentials.
"""

from __future__ import annotations

import base64
import os
import socket

import httpx
import pytest

from services import brokers
from services.broker_service import BrokerService, brokers_service
from services.broker_vault import (
    VaultError,
    decrypt_credentials,
    encrypt_credentials,
    masked,
    public_row,
)
from services.brokers.base import instrument_class, shadow_fill


@pytest.fixture(autouse=True)
def _isolate_status_cache():
    """BrokerService caches checks module-wide; keep that out of other tests."""
    import services.broker_service as module

    module.invalidate_status_cache()
    yield
    module.invalidate_status_cache()
from services.brokers.exness import (
    DEFAULT_GATEWAY,
    ExnessError,
    ExnessProvider,
    load_signing_key,
    sign_headers,
)

# ---------------------------------------------------------------------------
# Exness signing — official test vector (RFC 8032 Test 1 public test key)
# ---------------------------------------------------------------------------
VECTOR_KEY_HEX = (
    "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60"
    "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a"
)
VECTOR_PEM = (
    "-----BEGIN PRIVATE KEY-----\n"
    "MC4CAQAwBQYDK2VwBCIEIJ1hsZ3v/VpguoRK9JLsLMREScVpezJpGXA7rAMcrn9g\n"
    "-----END PRIVATE KEY-----\n"
)
VECTOR_API_KEY = "exnsk-synthetic-example"
VECTOR_TIMESTAMP = 1773656070123
VECTOR_PATH = "/v1/trading/access-point?account_id=123456"
EXPECTED_DATA = (
    "eyJhcGlfa2V5IjoiZXhuc2stc3ludGhldGljLWV4YW1wbGUiLCJpZGVtcG90ZW5jeV9rZXkiOiIi"
    "LCJ0aW1lc3RhbXAiOjE3NzM2NTYwNzAxMjMsInNpZ25fdmVyc2lvbiI6MSwibWV0aG9kIjoiR0VU"
    "IiwicGF0aCI6Ii92MS90cmFkaW5nL2FjY2Vzcy1wb2ludD9hY2NvdW50X2lkPTEyMzQ1NiIsImJv"
    "ZHlfaGFzaCI6IjQ3REVRcGo4SEJTYS1fVEltVy01SkNldVFlUmttNU5NcEpXWkczaFN1RlUifQ"
)
EXPECTED_SIGN = (
    "l-H_Acia8YoTjKFMg-3fon3NOEX8TalNVA7c01DQ9dHb7pVBJC4y06qC-DbpETzh1KToiOprqEV6uzN3t69ICQ"
)


def test_exness_signing_matches_official_vector():
    key = load_signing_key(VECTOR_KEY_HEX)
    headers = sign_headers(
        VECTOR_API_KEY, key, "GET", VECTOR_PATH, b"", timestamp_ms=VECTOR_TIMESTAMP
    )
    assert headers["EXN-DATA"] == EXPECTED_DATA
    assert headers["EXN-SIGN"] == EXPECTED_SIGN
    assert headers["EXN-TIMESTAMP"] == str(VECTOR_TIMESTAMP)
    assert headers["EXN-SIGN-VERSION"] == "1"
    # Signed GETs must send the idempotency key header, empty.
    assert headers["EXN-IDEMPOTENCY-KEY"] == ""


def test_pem_key_produces_the_same_signature_as_hex():
    from_hex = sign_headers(
        VECTOR_API_KEY, load_signing_key(VECTOR_KEY_HEX), "GET", VECTOR_PATH,
        b"", timestamp_ms=VECTOR_TIMESTAMP,
    )
    from_pem = sign_headers(
        VECTOR_API_KEY, load_signing_key(VECTOR_PEM), "GET", VECTOR_PATH,
        b"", timestamp_ms=VECTOR_TIMESTAMP,
    )
    assert from_hex == from_pem


def test_headers_are_unpadded_base64url():
    key = load_signing_key(VECTOR_KEY_HEX)
    headers = sign_headers(VECTOR_API_KEY, key, "GET", VECTOR_PATH, timestamp_ms=1)
    for name in ("EXN-DATA", "EXN-SIGN"):
        assert "=" not in headers[name]
        # Must survive a strict base64url decode.
        base64.urlsafe_b64decode(headers[name] + "=" * (-len(headers[name]) % 4))


def test_body_hash_changes_with_the_body():
    key = load_signing_key(VECTOR_KEY_HEX)
    empty = sign_headers(VECTOR_API_KEY, key, "POST", "/v1/x", b"", timestamp_ms=1)
    filled = sign_headers(VECTOR_API_KEY, key, "POST", "/v1/x", b'{"a":1}', timestamp_ms=1)
    assert empty["EXN-SIGN"] != filled["EXN-SIGN"]


def test_load_signing_key_rejects_bad_input():
    for bad in ("", "nonsense", "abcd" * 10):
        with pytest.raises(Exception):
            load_signing_key(bad)


def test_load_signing_key_rejects_a_mismatched_public_half():
    """A seed whose public half does not match would sign for a phantom key."""
    raw = bytearray(bytes.fromhex(VECTOR_KEY_HEX))
    raw[63] ^= 0x01  # flip a bit in the trailing public half
    with pytest.raises(Exception, match="public half"):
        load_signing_key(bytes(raw).hex())


# ---------------------------------------------------------------------------
# registry
# ---------------------------------------------------------------------------
def test_registry_exposes_every_provider_with_fields():
    for provider in brokers.all_providers():
        assert provider.id and provider.label
        assert provider.fields, f"{provider.id} has no credential fields"
        for field in provider.fields:
            assert field.key and field.label


def test_unknown_provider_is_not_an_error():
    assert brokers.get("nope") is None
    assert brokers.get("") is None
    assert brokers.get("EXNESS") is not None  # ids are case-insensitive


# ---------------------------------------------------------------------------
# validation + capability warnings
# ---------------------------------------------------------------------------
def test_missing_credentials_are_reported_by_label():
    exness = brokers.get("exness")
    assert "Account ID" in exness.validate({})
    assert exness.validate({}) is not None


def test_exness_rejects_a_non_numeric_account_id():
    exness = brokers.get("exness")
    assert exness.validate({"account_id": "abc", "api_key": "k",
                            "private_key": VECTOR_KEY_HEX})


def test_exness_accepts_well_formed_credentials():
    exness = brokers.get("exness")
    assert exness.validate({
        "account_id": "123456",
        "api_key": "exnsk-x",
        "private_key": VECTOR_KEY_HEX,
        "gateway": "https://mt-gateway.example.com",
        "ws_url": "wss://mt-ws.example.com",
    }) is None


def test_indices_warn_on_exness_but_not_forex():
    exness = brokers.get("exness")
    assert exness.warnings_for("NAS100"), "Exness has no index products"
    assert exness.warnings_for("XAUUSD") == []
    assert exness.warnings_for("EURUSD") == []


def test_instrument_classification():
    assert instrument_class("XAUUSD") == "metal"
    assert instrument_class("EURUSD") == "forex"
    assert instrument_class("NAS100") == "index"
    assert instrument_class("BTCUSD") == "crypto"
    assert instrument_class("") == "unknown"


# ---------------------------------------------------------------------------
# symbol translation
# ---------------------------------------------------------------------------
def test_oanda_symbol_translation():
    from services.brokers.oanda import from_oanda, to_oanda

    assert to_oanda("XAUUSD") == "XAU_USD"
    assert to_oanda("eurusd") == "EUR_USD"
    assert from_oanda("XAU_USD") == "XAUUSD"


# ---------------------------------------------------------------------------
# vault
# ---------------------------------------------------------------------------
@pytest.fixture(autouse=True)
def stable_credential_key(monkeypatch):
    monkeypatch.setenv("ALPHAFORGE_CRED_KEY", "dGVzdC1jcmVkZW50aWFsLWtleS0xMjM0NQ==")


def test_vault_roundtrip():
    creds = {"api_key": "exnsk-1", "private_key": VECTOR_KEY_HEX}
    assert decrypt_credentials(encrypt_credentials(creds)) == creds


def test_vault_uses_a_fresh_nonce_each_time():
    creds = {"api_key": "x"}
    assert encrypt_credentials(creds) != encrypt_credentials(creds)


def test_vault_detects_tampering():
    blob = bytearray(base64.b64decode(encrypt_credentials({"api_key": "secret"})))
    blob[-1] ^= 0x01
    with pytest.raises(VaultError):
        decrypt_credentials(base64.b64encode(bytes(blob)).decode())


def test_vault_fails_loudly_when_the_key_changes(monkeypatch):
    """Rotating ALPHAFORGE_CRED_KEY must invalidate, not silently mangle."""
    blob = encrypt_credentials({"api_key": "secret"})
    monkeypatch.setenv("ALPHAFORGE_CRED_KEY", "Y29tcGxldGVseS1kaWZmZXJlbnQta2V5")
    with pytest.raises(VaultError, match="credential key"):
        decrypt_credentials(blob)


def test_masked_leaves_only_the_tail():
    out = masked({"api_key": "exnsk-abcdef1234"})
    assert out["api_key"].endswith("1234")
    assert "abcdef" not in out["api_key"]


def test_public_row_never_leaks_the_ciphertext():
    row = {
        "id": "1", "user_id": "u", "provider": "exness",
        "credentials": "SUPER-SECRET-CIPHERTEXT",
    }
    publicised = public_row(row)
    assert "SUPER-SECRET-CIPHERTEXT" not in str(publicised)
    assert "credentials" not in publicised


# ---------------------------------------------------------------------------
# execution facade: shadow vs halted
# ---------------------------------------------------------------------------
class _FakeVault:
    """A vault that always returns one connection, so resolution succeeds."""

    enabled = True
    last_error = None

    def __init__(self, creds=None):
        self._creds = creds or {}

    def get(self, connection_id, user_id):
        return {
            "id": "conn-1",
            "user_id": user_id,
            "provider": "exness",
            "credentials": self._creds,
        }

    def list_for(self, user_id):
        return [{"id": "conn-1"}]

    def touch(self, *args, **kwargs):
        pass


def test_no_connection_shadows(monkeypatch):
    """Nothing configured: paper fills are the intended default."""
    service = BrokerService()

    class _Empty:
        enabled = False
        last_error = None

        def get(self, *a, **k):
            return None

        def list_for(self, *a, **k):
            return []

        def touch(self, *a, **k):
            pass

    monkeypatch.setattr("services.broker_service.vault", _Empty())
    result = service.place_order(
        {"symbol": "XAUUSD", "side": "buy", "volume": 0.01}, user_id="u1"
    )
    assert result["executed"] is False
    assert result["mode"] == "shadow"


def test_broken_connection_halts_instead_of_paper_filling(monkeypatch):
    """The bug this guards: a dead broker must not look like a working trade."""
    service = BrokerService()
    monkeypatch.setattr(
        "services.broker_service.vault",
        _FakeVault({"account_id": "not-a-number", "api_key": "x", "private_key": "y"}),
    )
    result = service.place_order(
        {"symbol": "XAUUSD", "side": "buy", "volume": 0.01}, user_id="u1"
    )
    assert result["executed"] is False
    assert result["mode"] == "halted"
    assert result["reason"]


def test_halted_order_is_never_reported_as_executed(monkeypatch):
    class _DeadProvider(ExnessProvider):
        def place_order(self, creds, order):
            return {"executed": False, "mode": "live", "ticket": None}

    monkeypatch.setattr("services.broker_service.vault", _FakeVault())
    monkeypatch.setitem(brokers._PROVIDERS, "exness", _DeadProvider())
    service = BrokerService()
    result = service.place_order({"symbol": "XAUUSD"}, user_id="u1")
    assert result["mode"] == "halted"
    assert result["executed"] is False


def test_resolution_requires_a_user():
    service = BrokerService()
    monkeypatch_vault = _FakeVault()
    import services.broker_service as module

    original = module.vault
    module.vault = monkeypatch_vault
    try:
        with pytest.raises(Exception, match="Sign in"):
            service.resolve(None, None)
    finally:
        module.vault = original


def test_unsupported_symbol_is_halted_not_shadowed(monkeypatch):
    """Indices on Exness must not be silently paper-filled either."""
    service = BrokerService()
    monkeypatch.setattr(
        "services.broker_service.vault",
        _FakeVault({
            "account_id": "123456",
            "api_key": "exnsk-x",
            "private_key": VECTOR_KEY_HEX,
            "gateway": "https://mt-gateway.example.com",
            "ws_url": "wss://mt-ws.example.com",
        "ws_url": "wss://mt-ws.example.com",
        }),
    )
    result = service.place_order(
        {"symbol": "NAS100", "side": "buy", "volume": 0.01}, user_id="u1"
    )
    assert result["mode"] == "halted"
    assert "indices" in result["reason"]


# ---------------------------------------------------------------------------
# Exness error diagnostics
#
# A bare "401" tells the user nothing. These pin the behaviour that turns an
# Exness error response into a specific, actionable next step.
# ---------------------------------------------------------------------------

class _FakeResponse:
    """Just enough of httpx.Response for ``_error_text``."""

    def __init__(self, status_code: int, body: str = "", payload=None):
        self.status_code = status_code
        self.text = body
        self._payload = payload

    def json(self):
        if self._payload is None:
            raise ValueError("no json")
        return self._payload


def _error(status_code: int, body: str = "", payload=None) -> str:
    return ExnessProvider._error_text(_FakeResponse(status_code, body, payload))


@pytest.mark.parametrize(
    "code,expected",
    [
        (1000, "AUTH_INVALID_API_KEY"),
        (1001, "AUTH_INVALID_SIGNATURE"),
        (1002, "AUTH_PERMISSION_DENIED"),
    ],
)
def test_auth_codes_are_named_and_explained(code, expected):
    """Each public auth code must surface its name and what to change."""
    text = _error(401, payload={"error": {"code": code, "error_message": "nope"}})

    assert str(code) in text, f"code {code} missing from {text!r}"
    assert expected in text, f"expected {expected} in {text!r}"
    assert "nope" in text


def test_auth_hint_distinguishes_the_three_failures():
    """The three 401s need three different fixes, so they must not read alike."""
    messages = {
        code: _error(401, payload={"error": {"code": code}})
        for code in (1000, 1001, 1002)
    }
    assert len(set(messages.values())) == 3

    assert "region-limited" in messages[1000]
    assert "private key" in messages[1001]
    assert "scope" in messages[1002]


def test_bare_401_blames_the_gateway_not_the_key():
    """An empty 401 body means we reached the wrong host, not a bad key."""
    text = _error(401)

    assert "Exness 401" in text
    assert "Gateway URL" in text
    # The actionable advice: a host the user can actually type, whether or
    # not their Personal Area renders the per-account DNS widget.
    assert "api.exness.com" in text


def test_401_with_unparsable_body_still_gives_guidance():
    text = _error(401, body="<html>unauthorized</html>")

    assert "Gateway URL" in text
    assert "unauthorized" in text


def test_403_mentions_scopes():
    text = _error(403, payload={"error": {"code": 1002}})
    assert "scope" in text


def test_code_is_reported_when_present_without_a_message():
    text = _error(401, payload={"error": {"code": 1001}})
    assert "(1001)" in text


def test_missing_gateway_is_called_out_on_discovery_failure(monkeypatch):
    """Blank Gateway URL + failure => say the default is only an example."""
    provider = ExnessProvider()

    def boom(*args, **kwargs):
        raise ExnessError("Exness 401")

    monkeypatch.setattr(provider, "_request", boom)
    monkeypatch.delenv("EXNESS_TEST", raising=False)

    creds = {
        "account_id": "123456",
        "api_key": "exnsk-x",
        "private_key": VECTOR_KEY_HEX,
    }
    with pytest.raises(ExnessError) as excinfo:
        provider._access_point(creds)

    message = str(excinfo.value)
    assert "Gateway URL" in message
    assert "gateway.exness.com" in message
    assert "api.exness.com" in message


def test_supplied_gateway_failure_does_not_blame_the_default(monkeypatch):
    """When the user did supply a gateway, don't second-guess it."""
    provider = ExnessProvider()

    def boom(*args, **kwargs):
        raise ExnessError("Exness 401")

    monkeypatch.setattr(provider, "_request", boom)

    creds = {
        "account_id": "123456",
        "api_key": "exnsk-x",
        "private_key": VECTOR_KEY_HEX,
        "gateway": "https://mine.example.com",
        "ws_url": "wss://mine.example.com",
    }
    with pytest.raises(ExnessError) as excinfo:
        provider._access_point(creds)

    assert "No Gateway URL" not in str(excinfo.value)
    assert "built-in example" not in str(excinfo.value)


def test_failure_reason_is_persisted_with_the_connection(monkeypatch):
    """A failed check must store *why*, not just the word "error".

    Knowing a connection is in "error" tells the user nothing they can act on.
    The reason has to survive the request so it can be read from the UI or the
    database later instead of being reproduced.
    """
    service = BrokerService()
    recorded = {}

    class _RecordingVault(_FakeVault):
        def touch(self, connection_id, status, error=None):
            recorded.update(connection_id=connection_id, status=status, error=error)

    monkeypatch.setattr("services.broker_service.vault", _RecordingVault())

    class _BrokenProvider:
        id = "exness"
        label = "Exness"
        unsupported = ()

        @staticmethod
        def status(creds):
            return {
                "available": False,
                "connected": False,
                "mode": "unavailable",
                "reason": "Exness 401 (1001): bad signature",
            }

        @staticmethod
        def warnings_for(creds):
            return []

    import services.broker_service as module
    monkeypatch.setitem(module.brokers._PROVIDERS, "exness", _BrokenProvider)

    service.status(None, "u1")

    assert recorded["status"] == "error"
    assert recorded["error"] == "Exness 401 (1001): bad signature"
    assert recorded["connection_id"] == "conn-1"


def test_successful_check_clears_the_stored_reason(monkeypatch):
    """Reconnecting must not leave a stale error attached to the row."""
    service = BrokerService()
    recorded = {}

    class _RecordingVault(_FakeVault):
        def touch(self, connection_id, status, error=None):
            recorded.update(status=status, error=error)

    monkeypatch.setattr("services.broker_service.vault", _RecordingVault())

    class _WorkingProvider:
        id = "exness"
        label = "Exness"
        unsupported = ()

        @staticmethod
        def status(creds):
            return {"available": True, "connected": True, "mode": "live"}

        @staticmethod
        def warnings_for(creds):
            return []

    import services.broker_service as module
    monkeypatch.setitem(module.brokers._PROVIDERS, "exness", _WorkingProvider)

    service.status(None, "u1")

    assert recorded["status"] == "connected"
    assert recorded["error"] is None


# ---------------------------------------------------------------------------
# Exception reporting
#
# "[Errno 16] Device or resource busy" reached the UI with no class, no
# location and nothing to search for. Failures must carry enough to find.
# ---------------------------------------------------------------------------

def test_describe_exception_names_the_class_and_location():
    """A bare errno is undiagnosable; the type and frame make it findable."""
    from services.brokers.base import describe_exception

    try:
        raise OSError(16, "Device or resource busy")
    except OSError as exc:
        text = describe_exception(exc)

    assert "OSError" in text
    assert "[Errno 16] Device or resource busy" in text
    assert "test_brokers.py" in text
    assert "in test_describe_exception_names_the_class_and_location" in text


def test_describe_exception_includes_the_chained_cause():
    from services.brokers.base import describe_exception

    try:
        try:
            raise ValueError("root cause")
        except ValueError as inner:
            raise RuntimeError("outer") from inner
    except RuntimeError as exc:
        text = describe_exception(exc)

    assert "RuntimeError: outer" in text
    assert "ValueError: root cause" in text


def test_describe_exception_survives_a_message_less_exception():
    from services.brokers.base import describe_exception

    try:
        raise KeyboardInterrupt()
    except KeyboardInterrupt as exc:
        text = describe_exception(exc)

    assert text.startswith("KeyboardInterrupt")


def test_unreachable_default_gateway_is_named_not_just_the_errno(monkeypatch):
    """A transport failure must say the gateway was a placeholder."""
    provider = ExnessProvider()

    def boom(*args, **kwargs):
        raise OSError(16, "Device or resource busy")

    monkeypatch.setattr(provider, "_request", boom)

    creds = {
        "account_id": "123456",
        "api_key": "exnsk-x",
        "private_key": VECTOR_KEY_HEX,
    }
    with pytest.raises(ExnessError) as excinfo:
        provider._access_point(creds)

    text = str(excinfo.value)
    assert "Could not reach the gateway" in text
    assert "OSError" in text                 # the class, not just the errno
    assert "test_brokers.py" in text         # and where it came from
    assert "example value" in text           # and that the host is not real
    assert "will never connect" in text


def test_unreachable_supplied_gateway_names_the_host(monkeypatch):
    """With a real gateway supplied, report it rather than blaming keys."""
    provider = ExnessProvider()

    def boom(*args, **kwargs):
        raise OSError(16, "Device or resource busy")

    monkeypatch.setattr(provider, "_request", boom)

    creds = {
        "account_id": "123456",
        "api_key": "exnsk-x",
        "private_key": VECTOR_KEY_HEX,
        "gateway": "https://mine.example.com",
        "ws_url": "wss://mine.example.com",
    }
    with pytest.raises(ExnessError) as excinfo:
        provider._access_point(creds)

    text = str(excinfo.value)
    assert "mine.example.com" in text
    assert "OSError" in text
    assert "no Gateway URL was given" not in text


# ---------------------------------------------------------------------------
# transient network failures
# ---------------------------------------------------------------------------
def test_a_busy_resolver_is_transient():
    """EBUSY out of getaddrinfo is worth an immediate retry.

    It arrives in bursts: a serverless instance resolving several hosts at
    once gets it, then answers the same name milliseconds later. Treating it
    as fatal reported a reachable broker as down, over and over, at whatever
    rate the UI happened to be polling.
    """
    from services.brokers.base import is_transient_network_error

    assert is_transient_network_error(OSError(16, "Device or resource busy"))
    assert is_transient_network_error(
        socket.gaierror(socket.EAI_AGAIN, "Temporary failure in name resolution")
    )
    assert is_transient_network_error(httpx.ConnectError("all connection attempts failed"))


def test_a_timeout_is_not_retried():
    """Retrying a timeout only doubles how long the caller waits for it."""
    from services.brokers.base import is_transient_network_error

    assert not is_transient_network_error(httpx.ReadTimeout("too slow"))
    assert not is_transient_network_error(ExnessError("AUTH_INVALID_API_KEY"))
    assert not is_transient_network_error(OSError(2, "No such file or directory"))


def test_retry_transient_recovers_from_a_busy_resolver(monkeypatch):
    from services.brokers import base

    calls = []

    def flaky():
        calls.append(1)
        if len(calls) < 3:
            raise httpx.ConnectError("busy")
        return "ok"

    monkeypatch.setattr(base.time, "sleep", lambda *_: None)
    assert base.retry_transient(flaky) == "ok"
    assert len(calls) == 3


def test_retry_transient_never_masks_a_real_error(monkeypatch):
    """A genuine rejection must fail on the first try, unchanged."""
    from services.brokers import base

    calls = []

    def broken():
        calls.append(1)
        raise ExnessError("AUTH_INVALID_SIGNATURE")

    monkeypatch.setattr(base.time, "sleep", lambda *_: None)
    with pytest.raises(ExnessError):
        base.retry_transient(broken)
    assert len(calls) == 1


def test_exness_retries_a_busy_resolver(monkeypatch):
    """The retry has to be wired into the call that actually fails."""
    import services.brokers.exness as exness
    from services.brokers import base

    monkeypatch.setattr(base.time, "sleep", lambda *_: None)
    attempts = {"n": 0}

    class _Client:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def request(self, *_args, **_kwargs):
            attempts["n"] += 1
            if attempts["n"] < 3:
                raise httpx.ConnectError("busy")
            return httpx.Response(200, json={"access_point": "https://ap.example.com"})

    monkeypatch.setattr(exness.httpx, "Client", lambda *_a, **_k: _Client())

    provider = ExnessProvider()
    creds = {
        "account_id": "retry-1",
        "api_key": "exnsk-x",
        "private_key": VECTOR_KEY_HEX,
        "gateway": "https://mine.example.com",
        "ws_url": "wss://mine.example.com",
    }
    assert provider._access_point(creds) == "https://ap.example.com"
    assert attempts["n"] == 3


def test_status_reports_the_class_for_unexpected_failures(monkeypatch):
    """A provider raising something odd must not surface a bare errno."""
    import services.broker_service as module

    class _ExplodingProvider:
        id = "exness"
        label = "Exness"
        unsupported = ()

        @staticmethod
        def status(creds):
            raise OSError(16, "Device or resource busy")

        @staticmethod
        def warnings_for(creds):
            return []

    monkeypatch.setattr("services.broker_service.vault", _FakeVault())
    monkeypatch.setitem(module.brokers._PROVIDERS, "exness", _ExplodingProvider)

    result = BrokerService().status(None, "u1")
    assert "OSError" in result["reason"]
    assert "Device or resource busy" in result["reason"]
    assert "test_brokers.py" in result["reason"]


# ---------------------------------------------------------------------------
# The example host
#
# The placeholder read like a real address and was pasted in, then failed as an
# opaque ConnectError. It must be rejected before it is ever stored.
# ---------------------------------------------------------------------------

def test_placeholder_gateway_is_rejected_before_saving():
    """Storing the example host is never useful — refuse it at validation."""
    provider = ExnessProvider()
    creds = {
        "account_id": "123456",
        "api_key": "exnsk-x",
        "private_key": VECTOR_KEY_HEX,
        "gateway": "https://gateway.exness.com",
        "ws_url": "wss://ws.api.exness.com",
    }
    problem = provider.validate(creds)
    assert problem is not None
    assert "example value" in problem
    assert "api.exness.com" in problem


def test_placeholder_gateway_is_rejected_with_trailing_slash():
    """A cosmetic difference must not smuggle the example past the check."""
    provider = ExnessProvider()
    creds = {
        "account_id": "123456",
        "api_key": "exnsk-x",
        "private_key": VECTOR_KEY_HEX,
        "gateway": "https://gateway.exness.com/",
        "ws_url": "wss://ws.api.exness.com/",
    }
    assert provider.validate(creds) is not None


def test_a_real_gateway_passes_validation():
    """Anything that is not the example host is accepted here."""
    provider = ExnessProvider()
    creds = {
        "account_id": "123456",
        "api_key": "exnsk-x",
        "private_key": VECTOR_KEY_HEX,
        "gateway": "https://mt-gateway.example.com",
        "ws_url": "wss://mt-ws.example.com",
    }
    assert provider.validate(creds) is None


def test_pasted_placeholder_gets_the_hint_on_connect(monkeypatch):
    """If it slips through to connect time, still say it was the example."""
    provider = ExnessProvider()

    def boom(*args, **kwargs):
        raise OSError(16, "Device or resource busy")

    monkeypatch.setattr(provider, "_request", boom)
    creds = {
        "account_id": "123456",
        "api_key": "exnsk-x",
        "private_key": VECTOR_KEY_HEX,
        "gateway": "https://gateway.exness.com",
        "ws_url": "wss://ws.api.exness.com",
    }
    with pytest.raises(ExnessError) as excinfo:
        provider._access_point(creds)

    text = str(excinfo.value)
    assert "example value" in text
    assert "will never connect" in text


def test_gateway_field_is_required():
    """The Gateway is needed for discovery, so the form must ask for it —
    but it must offer the public host rather than a made-up template."""
    field = next(f for f in ExnessProvider.fields if f.key == "gateway")
    assert field.required is True
    # A real, typeable host. A "<template>" placeholder sent users hunting
    # for a value Exness only shows to some accounts.
    assert field.placeholder == "https://api.exness.com"
    assert "gateway.exness.com" not in (field.placeholder or "")


def test_the_public_gateway_is_accepted_not_mistaken_for_a_placeholder():
    """The one host Exness publishes is the value we now recommend, so the
    example-host guard must not reject it. It differs from the example by a
    single subdomain, which is exactly the kind of near-miss that guard was
    written for."""
    from services.brokers.exness import is_placeholder_gateway

    assert is_placeholder_gateway("https://api.exness.com") is False
    assert is_placeholder_gateway("https://gateway.exness.com") is True

    provider = ExnessProvider()
    creds = {
        "account_id": "123456",
        "api_key": "exnsk-x",
        "private_key": VECTOR_KEY_HEX,
        "gateway": "https://api.exness.com",
    }
    assert provider.validate(creds) is None


def test_blanks_are_still_reported_as_missing():
    provider = ExnessProvider()
    creds = {
        "account_id": "123456",
        "api_key": "exnsk-x",
        "private_key": VECTOR_KEY_HEX,
    }
    assert "Gateway URL" in provider.validate(creds)


def test_websocket_field_is_optional_and_says_so():
    """The stream host is discovered from the Access Point, so the form must
    not ask the user for something they have no way of finding."""
    field = next(f for f in ExnessProvider.fields if f.key == "ws_url")
    assert field.required is False
    assert "blank" in (field.help or "").lower()


def test_example_websocket_url_is_rejected_before_saving():
    provider = ExnessProvider()
    creds = {
        "account_id": "123456",
        "api_key": "exnsk-x",
        "private_key": VECTOR_KEY_HEX,
        "gateway": "https://mt-gateway.example.com",
        "ws_url": "wss://ws.api.exness.com",
    }
    text = provider.validate(creds) or ""
    assert "example value" in text
    assert "WebSocket" in text


def test_ticks_follow_the_documented_contract(monkeypatch):
    """Host, path and subscription payload, exactly as Exness documents them.

    All three were wrong. The host was a hand-entered URL that does not exist
    in the product (and whose lookup failure read as a network fault); the
    path was /v1/ticks/... rather than /v1/server-events/...; and the
    subscription was {action, instruments} rather than the nested
    {subscribe: {event, instruments}}. Any one of them alone is a dead feed.
    """
    import asyncio
    import json
    import sys
    import types
    import uuid

    import services.brokers.exness as exness

    captured = {}

    class _Socket:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return False

        async def send(self, payload):
            captured["subscribe"] = json.loads(payload)

        async def recv(self):
            return json.dumps(
                {"instrument": "XAUUSD", "bid": 1.0, "ask": 1.2, "timestamp": "0"}
            )

    class _Connect:
        def __init__(self, url, **kwargs):
            captured["url"] = url
            captured["subprotocol"] = kwargs.get("subprotocols")

        async def __aenter__(self):
            return _Socket()

        async def __aexit__(self, *_args):
            return False

    fake = types.ModuleType("websockets")
    fake.connect = lambda url, **kwargs: _Connect(url, **kwargs)
    monkeypatch.setitem(sys.modules, "websockets", fake)

    provider = ExnessProvider()
    monkeypatch.setattr(
        provider, "_access_point", lambda creds: "https://ap-abc.exness.com"
    )

    creds = {
        "account_id": "123456",
        "api_key": "exnsk-x",
        "private_key": VECTOR_KEY_HEX,
        "gateway": "https://mt-gateway.example.com",
    }
    ticks = provider._stream_ticks(creds, ["XAUUSD"], timeout=1.0)

    assert (
        captured["url"]
        == "wss://ap-abc.exness.com/v1/server-events/accounts/123456/ws/ticks"
    )
    assert captured["subprotocol"] == ["exness-ws-protocol"]
    payload = captured["subscribe"]
    # Exness documents this id as a UUID; a hand-rolled one risks rejection.
    assert uuid.UUID(payload["id"])
    assert payload["subscribe"] == {"event": "ticks", "instruments": ["XAUUSD"]}
    assert "XAUUSD" in ticks


def test_the_example_websocket_host_is_still_refused(monkeypatch):
    """An explicitly pasted example must not be dialled either."""
    provider = ExnessProvider()
    monkeypatch.setattr(
        provider, "_access_point", lambda creds: "https://ap-abc.exness.com"
    )
    creds = {
        "account_id": "123456",
        "api_key": "exnsk-x",
        "private_key": VECTOR_KEY_HEX,
        "gateway": "https://mt-gateway.example.com",
        "ws_url": "wss://ws.api.exness.com",
    }
    with pytest.raises(ExnessError) as excinfo:
        provider._stream_ticks(creds, ["XAUUSD"], timeout=1.0)
    assert "example value" in str(excinfo.value)


def test_a_rejected_subscription_reports_what_the_server_said(monkeypatch):
    """The symptom "no tick arrived" covered a rejected subscription, a closed
    market and a wrong symbol, and was indistinguishable among them because
    every non-tick message was discarded. Whatever the server says back must
    reach the user — it is the only place the reason exists."""
    import asyncio
    import json
    import sys
    import types

    import services.brokers.exness as exness

    refusal = json.dumps(
        {"error": {"code": "REQUEST_INVALID", "message": "unknown event: ticks"}}
    )

    class _Socket:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return False

        async def send(self, _payload):
            return None

        async def recv(self):
            return refusal

    class _Connect:
        def __init__(self, _url, **_kwargs):
            pass

        async def __aenter__(self):
            return _Socket()

        async def __aexit__(self, *_args):
            return False

    fake = types.ModuleType("websockets")
    fake.connect = lambda url, **kwargs: _Connect(url, **kwargs)
    monkeypatch.setitem(sys.modules, "websockets", fake)

    provider = ExnessProvider()
    monkeypatch.setattr(
        provider, "_access_point", lambda creds: "https://ap-abc.exness.com"
    )
    creds = {
        "account_id": "123456",
        "api_key": "exnsk-x",
        "private_key": VECTOR_KEY_HEX,
        "gateway": "https://api.exness.com",
    }

    notes: list = []
    ticks = provider._stream_ticks(creds, ["XAUUSD"], timeout=0.5, notes=notes)

    assert ticks == {}
    assert notes, "the server's refusal must not be thrown away"
    assert "REQUEST_INVALID" in notes[0]

    # And it has to reach the user, not just the caller.
    result = provider.price(creds, "XAUUSD")
    assert result["available"] is False
    assert "REQUEST_INVALID" in result["reason"]
    # The old wording blamed a field we now tell the user to leave blank.
    assert "WebSocket URL" not in result["reason"]


def test_the_weekend_is_named_and_the_reopening_is_the_next_sunday():
    """A closed market and a rejected subscription look identical from the
    outside: the socket connects, nothing arrives. Saying which day it reopens
    is the difference between 'it is broken' and 'come back at 22:00 UTC'."""
    from datetime import datetime, timezone

    from services.brokers.exness import _market_closed_note

    def at(text):
        return datetime.fromisoformat(text).replace(tzinfo=timezone.utc)

    # Mid-week is open.
    assert _market_closed_note(at("2026-11-04 12:00:00")) == ""
    assert _market_closed_note(at("2026-11-06 20:00:00")) == ""

    # Friday 21:00 UTC close, Sunday 22:00 UTC open (northern winter).
    assert "closed" in _market_closed_note(at("2026-11-06 21:30:00"))
    assert "closed" in _market_closed_note(at("2026-11-07 12:00:00"))
    assert "closed" in _market_closed_note(at("2026-11-08 10:00:00"))
    assert _market_closed_note(at("2026-11-08 23:00:00")) == ""

    # Saturday must reopen the very next day — an earlier version added a
    # whole week and promised a reopening seven days out.
    saturday = _market_closed_note(at("2026-11-07 12:00:00"))
    assert "Sun 22:00 UTC" in saturday
    assert "34.0h" in saturday

    # During US daylight saving the week opens an hour earlier in UTC.
    assert "Sun 21:00 UTC" in _market_closed_note(at("2026-07-04 20:30:00"))


def test_access_point_urls_become_stream_urls():
    from services.brokers.exness import _to_ws_url

    assert _to_ws_url("https://ap-abc.exness.com") == "wss://ap-abc.exness.com"
    assert _to_ws_url("http://localhost:8080") == "ws://localhost:8080"


def test_a_stream_failure_names_the_host_it_dialled(monkeypatch):
    """A transport error with no address in it is undebuggable."""
    provider = ExnessProvider()

    def boom(*_args, **_kwargs):
        raise OSError(16, "Device or resource busy")

    monkeypatch.setattr(provider, "_stream_ticks", boom)
    creds = {
        "account_id": "123456",
        "api_key": "exnsk-x",
        "private_key": VECTOR_KEY_HEX,
        "gateway": "https://mt-gateway.example.com",
        "ws_url": "wss://realtime.example.com",
    }
    reason = provider.price(creds, "XAUUSD")["reason"]
    assert "realtime.example.com" in reason
    assert "OSError" in reason


# ---------------------------------------------------------------------------
# Status caching
#
# A status check probes the broker live. Page loads must not pay that cost on
# every refresh, and the caller must not give up before the engine answers.
# ---------------------------------------------------------------------------

class _CountingProvider:
    """Counts how often the broker is actually contacted."""

    calls = 0

    id = "exness"
    label = "Exness"
    unsupported = ()

    @staticmethod
    def status(creds):
        _CountingProvider.calls += 1
        return {"available": True, "connected": True, "mode": "live"}

    @staticmethod
    def warnings_for(creds):
        return []


def test_status_is_probed_once_then_served_from_cache(monkeypatch):
    """Repeated page loads must not keep hitting the broker."""
    import services.broker_service as module

    _CountingProvider.calls = 0
    module.invalidate_status_cache()
    monkeypatch.setattr("services.broker_service.vault", _FakeVault())
    monkeypatch.setitem(module.brokers._PROVIDERS, "exness", _CountingProvider)

    service = BrokerService()
    first = service.status(None, "u1")
    second = service.status(None, "u1")

    assert _CountingProvider.calls == 1
    assert first["connected"] is True
    assert second["connected"] is True
    assert second.get("cached") is True


def test_invalidating_after_saving_forces_a_fresh_probe(monkeypatch):
    """Changing credentials must not keep showing the previous verdict."""
    import services.broker_service as module

    _CountingProvider.calls = 0
    module.invalidate_status_cache()
    monkeypatch.setattr("services.broker_service.vault", _FakeVault())
    monkeypatch.setitem(module.brokers._PROVIDERS, "exness", _CountingProvider)

    service = BrokerService()
    service.status(None, "u1")
    module.invalidate_status_cache("u1")
    service.status(None, "u1")

    assert _CountingProvider.calls == 2


def test_cache_is_per_user(monkeypatch):
    """One user's cached check must never be shown to another."""
    import services.broker_service as module

    _CountingProvider.calls = 0
    module.invalidate_status_cache()
    monkeypatch.setattr("services.broker_service.vault", _FakeVault())
    monkeypatch.setitem(module.brokers._PROVIDERS, "exness", _CountingProvider)

    service = BrokerService()
    service.status(None, "alice")
    service.status(None, "bob")

    assert _CountingProvider.calls == 2


def test_unauthenticated_calls_are_never_cached(monkeypatch):
    """With no user, resolution stops before the broker is ever contacted."""
    import services.broker_service as module

    _CountingProvider.calls = 0
    module.invalidate_status_cache()
    monkeypatch.setattr("services.broker_service.vault", _FakeVault())
    monkeypatch.setitem(module.brokers._PROVIDERS, "exness", _CountingProvider)

    first = BrokerService().status(None, None)
    second = BrokerService().status(None, None)

    assert _CountingProvider.calls == 0        # never reaches the broker
    assert first["connected"] is False
    assert second["connected"] is False
    assert second.get("cached") is None        # and nothing was cached


# ---------------------------------------------------------------------------
# Rendering a page must not depend on a live probe
# ---------------------------------------------------------------------------

class _StoredVault(_FakeVault):
    """A vault whose row carries the outcome of a previous check."""

    def __init__(self, last_status="connected", last_error="", checked="2026-10-31T22:09:30Z"):
        super().__init__({"account_id": "123456", "api_key": "exnsk-x", "private_key": VECTOR_KEY_HEX})
        self.row = {
            "id": "conn-1",
            "user_id": "u1",
            "provider": "exness",
            "last_status": last_status,
            "last_error": last_error,
            "last_checked_at": checked,
        }

    def list_for(self, user_id):
        return [self.row]

    def get(self, connection_id, user_id):
        row = dict(self.row)
        row["credentials"] = self._creds
        return row


def test_snapshot_does_not_contact_the_broker(monkeypatch):
    """Rendering the page must not trigger a live round trip."""
    import services.broker_service as module

    _CountingProvider.calls = 0
    monkeypatch.setattr("services.broker_service.vault", _StoredVault())
    monkeypatch.setitem(module.brokers._PROVIDERS, "exness", _CountingProvider)

    result = BrokerService().status(None, "u1", probe=False)

    assert _CountingProvider.calls == 0          # broker never contacted
    assert result["connected"] is True
    assert result["from_storage"] is True
    assert result["checked_at"] == "2026-10-31T22:09:30Z"


def test_snapshot_surfaces_the_stored_failure_reason(monkeypatch):
    """A previously recorded error must still be explained, not hidden."""
    import services.broker_service as module

    vault = _StoredVault(last_status="error", last_error="Exness 401 (1001)")
    monkeypatch.setattr("services.broker_service.vault", vault)
    monkeypatch.setitem(module.brokers._PROVIDERS, "exness", _CountingProvider)

    result = BrokerService().status(None, "u1", probe=False)

    assert result["connected"] is False
    assert result["reason"] == "Exness 401 (1001)"
    assert result["mode"] == "unavailable"


def test_snapshot_still_requires_a_signed_in_user(monkeypatch):
    """Convenience must not become a way to read someone else's state."""
    import services.broker_service as module

    monkeypatch.setattr("services.broker_service.vault", _StoredVault())
    monkeypatch.setitem(module.brokers._PROVIDERS, "exness", _CountingProvider)

    result = BrokerService().status(None, None, probe=False)
    assert result["connected"] is False
    assert "Sign in" in result["reason"]


def test_probe_is_still_available_when_credentials_change(monkeypatch):
    """Saving is the moment to ask the broker for real."""
    import services.broker_service as module

    _CountingProvider.calls = 0
    monkeypatch.setattr("services.broker_service.vault", _StoredVault())
    monkeypatch.setitem(module.brokers._PROVIDERS, "exness", _CountingProvider)

    BrokerService().status(None, "u1", probe=True)
    assert _CountingProvider.calls == 1
