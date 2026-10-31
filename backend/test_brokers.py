"""Broker provider, vault and execution-facade tests.

The Exness signing test is the important one: it checks AlphaForge's signature
against the RFC 8032 test vector Exness publishes, so the trickiest part of the
integration is verified without anyone's real credentials.
"""

from __future__ import annotations

import base64
import os

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
    assert "no public default" in text


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
    assert "Key Management" in message


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
