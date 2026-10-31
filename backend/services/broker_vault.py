"""Encrypted storage for broker credentials.

These keys move real money, so they get treated differently from every other
setting in AlphaForge:

* **Encrypted before they touch the database.** AES-256-GCM, a fresh 96-bit
  nonce per write, the ciphertext stored base64. The table also has RLS so a
  row is only visible to its owner, and ``credentials`` is never serialised
  back to the browser.
* **Key comes from the environment, never the database.** ``ALPHAFORGE_CRED_KEY``
  wins; otherwise the key is derived from ``SUPABASE_SERVICE_ROLE_KEY`` so an
  existing deployment keeps working. A hard-coded development key is the last
  resort and logs a warning — losing that key means re-entering credentials,
  which is annoying, not dangerous.
* **Decrypted only for the duration of one call.** Nothing is cached in a
  module global, because on Vercel a cached secret in one instance is invisible
  to the next and would look like credentials randomly vanishing.

GCM is authenticated: a tampered ciphertext fails to decrypt rather than
decrypting to garbage.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import time
from typing import Any, Dict, List, Optional

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

TABLE = "broker_connections"

#: Deliberately obvious. Only used when no environment key is configured.
_DEV_KEY_MATERIAL = "alphaforge-development-credential-key"

_warned_about_dev_key = False


class VaultError(RuntimeError):
    """Raised when credentials cannot be read or written."""


def _key() -> bytes:
    """The 32-byte AES key. Resolution order is documented above."""
    global _warned_about_dev_key

    raw = (os.getenv("ALPHAFORGE_CRED_KEY") or "").strip()
    if not raw:
        raw = (os.getenv("SUPABASE_SERVICE_ROLE_KEY") or "").strip()
    if not raw:
        if not _warned_about_dev_key:
            _warned_about_dev_key = True
            print(
                "[broker_vault] ALPHAFORGE_CRED_KEY is not set — using the "
                "development credential key. Set it in production.",
                flush=True,
            )
        raw = _DEV_KEY_MATERIAL

    # Accept a base64 key or any plain string; hash to a fixed 32 bytes either way.
    try:
        decoded = base64.b64decode(raw, validate=True)
        if len(decoded) == 32:
            return decoded
    except Exception:
        pass
    return hashlib.sha256(raw.encode("utf-8")).digest()


# ---------------------------------------------------------------------------
# crypto
# ---------------------------------------------------------------------------
def encrypt_credentials(creds: Dict[str, Any]) -> str:
    """AES-256-GCM encrypt a credential dict into a base64 blob."""
    aes = AESGCM(_key())
    nonce = os.urandom(12)
    plaintext = json.dumps(creds, separators=(",", ":")).encode("utf-8")
    blob = nonce + aes.encrypt(nonce, plaintext, None)
    return base64.b64encode(blob).decode("ascii")


def decrypt_credentials(blob: str) -> Dict[str, Any]:
    """Reverse :func:`encrypt_credentials`. Raises :class:`VaultError`."""
    try:
        raw = base64.b64decode((blob or "").encode("ascii"), validate=True)
    except Exception as exc:
        raise VaultError("Stored credentials are not valid base64.") from exc
    if len(raw) < 13:
        raise VaultError("Stored credentials are truncated.")
    try:
        aes = AESGCM(_key())
        plaintext = aes.decrypt(raw[:12], raw[12:], None)
    except Exception as exc:
        # Includes the case where the key changed under an existing row.
        raise VaultError(
            "Could not decrypt stored credentials — the credential key may "
            "have changed. Re-enter them in Settings."
        ) from exc
    try:
        decoded = json.loads(plaintext.decode("utf-8"))
    except Exception as exc:
        raise VaultError("Decrypted credentials are not valid JSON.") from exc
    if not isinstance(decoded, dict):
        raise VaultError("Decrypted credentials are not an object.")
    return decoded


def masked(creds: Dict[str, Any]) -> Dict[str, str]:
    """A version safe to log or return: only the last four characters survive."""
    out: Dict[str, str] = {}
    for key, value in (creds or {}).items():
        text = str(value or "")
        out[key] = ("••••" + text[-4:]) if text else ""
    return out


# ---------------------------------------------------------------------------
# persistence
# ---------------------------------------------------------------------------
def public_row(row: Dict[str, Any]) -> Dict[str, Any]:
    """Strip the ciphertext before a row leaves the engine."""
    return {
        "id": row.get("id"),
        "user_id": row.get("user_id"),
        "provider": row.get("provider"),
        "label": row.get("label") or "",
        "last_status": row.get("last_status"),
        "last_error": row.get("last_error") or "",
        "last_checked_at": row.get("last_checked_at"),
        "created_at": row.get("created_at"),
        "updated_at": row.get("updated_at"),
    }


class BrokerVault:
    """Read/write ``broker_connections`` through the shared Supabase client."""

    def __init__(self) -> None:
        self._client = None
        self._last_error: Optional[str] = None

    def configure(self, client: Any) -> None:
        self._client = client

    @property
    def enabled(self) -> bool:
        return self._client is not None

    @property
    def last_error(self) -> Optional[str]:
        return self._last_error

    def _table(self):
        if self._client is None:
            raise VaultError("No Supabase client configured.")
        return self._client.table(TABLE)

    def list_for(self, user_id: str) -> List[Dict[str, Any]]:
        if not self._client:
            return []
        try:
            response = (
                self._table()
                .select("*")
                .eq("user_id", user_id)
                .order("updated_at", desc=True)
                .execute()
            )
        except Exception as exc:
            self._last_error = str(exc)
            return []
        return [public_row(dict(r)) for r in (response.data or [])]

    def get(self, connection_id: str, user_id: str) -> Optional[Dict[str, Any]]:
        """One row including decrypted credentials, or None."""
        if not self._client:
            return None
        try:
            response = (
                self._table()
                .select("*")
                .eq("id", connection_id)
                .eq("user_id", user_id)
                .limit(1)
                .execute()
            )
        except Exception as exc:
            self._last_error = str(exc)
            return None
        rows = response.data or []
        if not rows:
            return None
        row = dict(rows[0])
        try:
            row["credentials"] = decrypt_credentials(str(row.get("credentials") or ""))
        except VaultError as exc:
            row["error"] = str(exc)
        return row

    def save(
        self,
        user_id: str,
        provider: str,
        creds: Dict[str, Any],
        *,
        label: str = "",
        connection_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Insert or update one connection, returning the public row."""
        payload = {
            "user_id": user_id,
            "provider": provider,
            "label": label or "",
            "credentials": encrypt_credentials(creds),
            "updated_at": _now(),
        }
        try:
            if connection_id:
                response = (
                    self._table()
                    .update(payload)
                    .eq("id", connection_id)
                    .eq("user_id", user_id)
                    .execute()
                )
            else:
                response = self._table().upsert(
                    payload, on_conflict="user_id,provider"
                ).execute()
        except Exception as exc:
            raise VaultError(f"Could not save the connection: {exc}") from exc

        rows = response.data or []
        if not rows:
            raise VaultError("Supabase did not return the saved connection.")
        return public_row(dict(rows[0]))

    def delete(self, connection_id: str, user_id: str) -> bool:
        if not self._client:
            return False
        try:
            self._table().delete().eq("id", connection_id).eq("user_id", user_id).execute()
        except Exception as exc:
            self._last_error = str(exc)
            return False
        return True

    def touch(self, connection_id: str, status: str, error: Optional[str] = None) -> None:
        """Record the outcome of the last check — never the credentials.

        The reason is stored next to the status, not just the status word.
        Knowing only that a connection is in "error" is useless to the person
        trying to fix it: the message has to be readable later, from the UI or
        straight out of the database, without reproducing the failure.
        """
        if not self._client:
            return
        try:
            self._table().update(
                {
                    "last_status": status[:200],
                    "last_error": (error or "")[:500],
                    "last_checked_at": _now(),
                }
            ).eq("id", connection_id).execute()
        except Exception as exc:
            self._last_error = str(exc)
            # A missing last_error column must not lose the status update too.
            try:
                self._table().update(
                    {"last_status": status[:200], "last_checked_at": _now()}
                ).eq("id", connection_id).execute()
            except Exception:
                pass


def _now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


vault = BrokerVault()
