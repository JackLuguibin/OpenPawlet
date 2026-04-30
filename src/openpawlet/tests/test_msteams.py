import json

import pytest

# Check optional msteams dependencies before running tests
try:
    from openpawlet.channels import msteams

    MSTEAMS_AVAILABLE = getattr(msteams, "MSTEAMS_AVAILABLE", False)
except ImportError:
    MSTEAMS_AVAILABLE = False

if not MSTEAMS_AVAILABLE:
    pytest.skip(
        "MSTeams dependencies not installed (PyJWT, cryptography). Run: pip install open-pawlet[msteams]",
        allow_module_level=True,
    )

import jwt
from cryptography.hazmat.primitives.asymmetric import rsa

import openpawlet.channels.msteams as msteams_module
from openpawlet.bus.events import OutboundMessage
from openpawlet.channels.msteams import ConversationRef, MSTeamsChannel


class DummyBus:
    def __init__(self):
        self.inbound = []

    async def publish_inbound(self, msg):
        self.inbound.append(msg)


class FakeResponse:
    def __init__(self, payload=None, *, should_raise=False):
        self._payload = payload or {}
        self._should_raise = should_raise

    def raise_for_status(self):
        if self._should_raise:
            raise RuntimeError("boom")
        return None

    def json(self):
        return self._payload


class FakeHttpClient:
    def __init__(self, payload=None, *, should_raise=False):
        self.payload = payload or {"access_token": "tok", "expires_in": 3600}
        self.should_raise = should_raise
        self.calls = []

    async def post(self, url, **kwargs):
        self.calls.append((url, kwargs))
        return FakeResponse(self.payload, should_raise=self.should_raise)

    async def aclose(self):
        return


@pytest.fixture
def make_channel(tmp_path, monkeypatch):
    monkeypatch.setattr("openpawlet.channels.msteams.get_workspace_path", lambda: tmp_path)

    def _make_channel(**config_overrides):
        config = {
            "enabled": True,
            "appId": "app-id",
            "appPassword": "secret",
            "tenantId": "tenant-id",
            "allowFrom": ["*"],
        }
        config.update(config_overrides)
        return MSTeamsChannel(config, DummyBus())

    return _make_channel


@pytest.mark.asyncio
async def test_handle_activity_personal_message_publishes_and_stores_ref(make_channel, tmp_path):
    ch = make_channel()

    activity = {
        "type": "message",
        "id": "activity-1",
        "text": "Hello from Teams",
        "serviceUrl": "https://smba.trafficmanager.net/amer/",
        "conversation": {
            "id": "conv-123",
            "conversationType": "personal",
        },
        "from": {
            "id": "29:user-id",
            "aadObjectId": "aad-user-1",
            "name": "Bob",
        },
        "recipient": {
            "id": "28:bot-id",
            "name": "openpawlet",
        },
        "channelData": {
            "tenant": {"id": "tenant-id"},
        },
    }

    await ch._handle_activity(activity)

    assert len(ch.bus.inbound) == 1
    msg = ch.bus.inbound[0]
    assert msg.channel == "msteams"
    assert msg.sender_id == "aad-user-1"
    assert msg.chat_id == "conv-123"
    assert msg.content == "Hello from Teams"
    assert msg.metadata["msteams"]["conversation_id"] == "conv-123"
    assert "conv-123" in ch._conversation_refs

    saved = json.loads(
        (tmp_path / "state" / "msteams_conversations.json").read_text(encoding="utf-8")
    )
    assert saved["conv-123"]["conversation_id"] == "conv-123"
    assert saved["conv-123"]["tenant_id"] == "tenant-id"
    # Prune-related metadata is now persisted alongside the rest of the ref.
    assert "updated_at" in saved["conv-123"]


def test_save_refs_prunes_stale_and_unsupported_refs(make_channel, tmp_path):
    """`_save_refs` should drop emulator/non-personal/expired refs from disk."""
    import time

    ch = make_channel()

    ch._conversation_refs = {
        "ok": ConversationRef(
            service_url="https://smba.trafficmanager.net/amer/",
            conversation_id="ok",
            conversation_type="personal",
            updated_at=time.time(),
        ),
        "emulator": ConversationRef(
            service_url="https://webchat.botframework.com/v3",
            conversation_id="emulator",
            conversation_type="personal",
            updated_at=time.time(),
        ),
        "group": ConversationRef(
            service_url="https://smba.trafficmanager.net/amer/",
            conversation_id="group",
            conversation_type="channel",
            updated_at=time.time(),
        ),
        "old": ConversationRef(
            service_url="https://smba.trafficmanager.net/amer/",
            conversation_id="old",
            conversation_type="personal",
            updated_at=time.time() - (60 * 24 * 60 * 60),  # 60 days ago
        ),
    }
    ch._save_refs()

    # In-memory state was pruned in place.
    assert set(ch._conversation_refs) == {"ok"}

    # Persisted file matches the in-memory state.
    saved = json.loads(
        (tmp_path / "state" / "msteams_conversations.json").read_text(encoding="utf-8")
    )
    assert set(saved) == {"ok"}


def test_load_refs_tolerates_legacy_records_without_updated_at(make_channel, tmp_path):
    """Older on-disk records (no `updated_at`) must still load cleanly."""
    refs_path = tmp_path / "state" / "msteams_conversations.json"
    refs_path.parent.mkdir(parents=True, exist_ok=True)
    refs_path.write_text(
        json.dumps(
            {
                "legacy": {
                    "service_url": "https://smba.trafficmanager.net/amer/",
                    "conversation_id": "legacy",
                    "bot_id": "28:bot-id",
                    "activity_id": "act-1",
                    "conversation_type": "personal",
                    "tenant_id": "tenant-id",
                }
            }
        ),
        encoding="utf-8",
    )

    ch = make_channel()

    assert "legacy" in ch._conversation_refs
    assert ch._conversation_refs["legacy"].updated_at is None


@pytest.mark.asyncio
async def test_handle_activity_ignores_group_messages(make_channel):
    ch = make_channel()

    activity = {
        "type": "message",
        "id": "activity-2",
        "text": "Hello group",
        "serviceUrl": "https://smba.trafficmanager.net/amer/",
        "conversation": {
            "id": "conv-group",
            "conversationType": "channel",
        },
        "from": {
            "id": "29:user-id",
            "aadObjectId": "aad-user-1",
            "name": "Bob",
        },
        "recipient": {
            "id": "28:bot-id",
            "name": "openpawlet",
        },
    }

    await ch._handle_activity(activity)

    assert ch.bus.inbound == []
    assert ch._conversation_refs == {}


@pytest.mark.asyncio
async def test_handle_activity_denied_sender_does_not_store_ref(make_channel, tmp_path):
    ch = make_channel(allowFrom=["allowed-user"])

    activity = {
        "type": "message",
        "id": "activity-denied",
        "text": "Hello from denied user",
        "serviceUrl": "https://smba.trafficmanager.net/amer/",
        "conversation": {
            "id": "conv-denied",
            "conversationType": "personal",
        },
        "from": {
            "id": "29:user-id",
            "aadObjectId": "aad-user-1",
            "name": "Bob",
        },
        "recipient": {
            "id": "28:bot-id",
            "name": "openpawlet",
        },
        "channelData": {
            "tenant": {"id": "tenant-id"},
        },
    }

    await ch._handle_activity(activity)

    assert ch.bus.inbound == []
    assert ch._conversation_refs == {}
    assert not (tmp_path / "state" / "msteams_conversations.json").exists()


@pytest.mark.asyncio
async def test_handle_activity_mention_only_uses_default_response(make_channel):
    ch = make_channel()

    activity = {
        "type": "message",
        "id": "activity-3",
        "text": "<at>OpenPawlet</at>",
        "serviceUrl": "https://smba.trafficmanager.net/amer/",
        "conversation": {
            "id": "conv-empty",
            "conversationType": "personal",
        },
        "from": {
            "id": "29:user-id",
            "aadObjectId": "aad-user-1",
            "name": "Bob",
        },
        "recipient": {
            "id": "28:bot-id",
            "name": "openpawlet",
        },
    }

    await ch._handle_activity(activity)

    assert len(ch.bus.inbound) == 1
    assert ch.bus.inbound[0].content == "Hi — what can I help with?"
    assert "conv-empty" in ch._conversation_refs


@pytest.mark.asyncio
async def test_handle_activity_mention_only_ignores_when_response_disabled(make_channel):
    ch = make_channel(mentionOnlyResponse="   ")

    activity = {
        "type": "message",
        "id": "activity-4",
        "text": "<at>OpenPawlet</at>",
        "serviceUrl": "https://smba.trafficmanager.net/amer/",
        "conversation": {
            "id": "conv-empty-disabled",
            "conversationType": "personal",
        },
        "from": {
            "id": "29:user-id",
            "aadObjectId": "aad-user-1",
            "name": "Bob",
        },
        "recipient": {
            "id": "28:bot-id",
            "name": "openpawlet",
        },
    }

    await ch._handle_activity(activity)

    assert ch.bus.inbound == []
    assert ch._conversation_refs == {}


def test_strip_possible_bot_mention_removes_generic_at_tags(make_channel):
    ch = make_channel()

    assert ch._strip_possible_bot_mention("<at>OpenPawlet</at> hello") == "hello"
    assert ch._strip_possible_bot_mention("hi <at>Some Bot</at> there") == "hi there"


def test_sanitize_inbound_text_normalizes_nbsp_entities(make_channel):
    ch = make_channel()
    activity = {"text": "Hello&nbsp;from&nbsp;Teams", "channelData": {}}
    assert ch._sanitize_inbound_text(activity) == "Hello from Teams"


def test_sanitize_inbound_text_keeps_normal_inline_message(make_channel):
    ch = make_channel()

    activity = {
        "text": "<at>OpenPawlet</at> normal inline message",
        "channelData": {},
    }

    assert ch._sanitize_inbound_text(activity) == "normal inline message"


def test_sanitize_inbound_text_normalizes_reply_wrapper_without_reply_metadata(make_channel):
    ch = make_channel()

    activity = {
        "text": "Reply wrapper \r\nQuoted prior message\r\n\r\nThis is a reply with quote test",
        "channelData": {},
    }

    assert ch._sanitize_inbound_text(activity) == (
        "User is replying to: Quoted prior message\nUser reply: This is a reply with quote test"
    )


def test_sanitize_inbound_text_structures_reply_quote_prefix(make_channel):
    ch = make_channel()

    activity = {
        "text": "Replying to Bob Smith\nactual reply text",
        "replyToId": "parent-activity",
        "channelData": {"messageType": "reply"},
    }

    assert (
        ch._sanitize_inbound_text(activity)
        == "User is replying to: Bob Smith\nUser reply: actual reply text"
    )


def test_sanitize_inbound_text_structures_live_reply_wrapper_shape(make_channel):
    ch = make_channel()

    activity = {
        "text": "Reply wrapper Got it. I’ll watch for the exact text reply with quote test and then inspect that turn specifically. Reply with quote test",
        "replyToId": "parent-activity",
        "channelData": {"messageType": "reply"},
    }

    assert ch._sanitize_inbound_text(activity) == (
        "User is replying to: Got it. I’ll watch for the exact text reply with quote test and then inspect that turn specifically.\n"
        "User reply: Reply with quote test"
    )


def test_normalize_teams_reply_quote_leaves_plain_text_test_phrase_untouched(make_channel):
    ch = make_channel()

    text = "Normal message ending with Reply with quote test"

    assert ch._normalize_teams_reply_quote(text) == text


def test_sanitize_inbound_text_structures_multiline_reply_wrapper_shape(make_channel):
    ch = make_channel()

    activity = {
        "text": (
            "Reply wrapper\r\n"
            "Understood — then the restart already happened, and the new Teams quote normalization should now be live. "
            "Next best step: • send one more real reply-with-quote message in Teams • I&rsquo…\r\n"
            "\r\n"
            "This is a reply with quote"
        ),
        "replyToId": "parent-activity",
        "channelData": {"messageType": "reply"},
    }

    assert ch._sanitize_inbound_text(activity) == (
        "User is replying to: Understood — then the restart already happened, and the new Teams quote normalization should now be live. "
        "Next best step: • send one more real reply-with-quote message in Teams • I’…\n"
        "User reply: This is a reply with quote"
    )


def test_sanitize_inbound_text_structures_exact_live_crlf_reply_wrapper_shape(make_channel):
    ch = make_channel()

    activity = {
        "text": (
            "Reply wrapper \r\n"
            "Please send one real reply-with-quote message in Teams. That single test should be enough now: "
            "• I’ll check the new MSTeams sanitized inbound text ... log • and compare it to the prompt…\r\n"
            "\r\n"
            "This is a reply with quote test"
        ),
        "replyToId": "parent-activity",
        "channelData": {"messageType": "reply"},
    }

    assert ch._sanitize_inbound_text(activity) == (
        "User is replying to: Please send one real reply-with-quote message in Teams. That single test should be enough now: "
        "• I’ll check the new MSTeams sanitized inbound text ... log • and compare it to the prompt…\n"
        "User reply: This is a reply with quote test"
    )


@pytest.mark.asyncio
async def test_get_access_token_uses_configured_tenant(make_channel):
    ch = make_channel(tenantId="tenant-123")
    fake_http = FakeHttpClient()
    ch._http = fake_http

    token = await ch._get_access_token()

    assert token == "tok"
    assert len(fake_http.calls) == 1
    url, kwargs = fake_http.calls[0]
    assert url == "https://login.microsoftonline.com/tenant-123/oauth2/v2.0/token"
    assert kwargs["data"]["client_id"] == "app-id"
    assert kwargs["data"]["client_secret"] == "secret"
    assert kwargs["data"]["scope"] == "https://api.botframework.com/.default"


@pytest.mark.asyncio
async def test_send_posts_to_conversation_with_reply_to_id_when_reply_in_thread_enabled(
    make_channel,
):
    """With ``reply_in_thread=True``, the threaded reply is delivered by
    POSTing to the conversation activities collection and carrying the
    parent ``activity_id`` inside ``replyToId``.  Posting to
    ``.../activities/{activity_id}`` returns 405 on production endpoints."""
    ch = make_channel(replyInThread=True)
    fake_http = FakeHttpClient()
    ch._http = fake_http
    ch._token = "tok"
    ch._token_expires_at = 9999999999
    ch._conversation_refs["conv-123"] = ConversationRef(
        service_url="https://smba.trafficmanager.net/amer/",
        conversation_id="conv-123",
        activity_id="activity-1",
    )

    await ch.send(OutboundMessage(channel="msteams", chat_id="conv-123", content="Reply text"))

    assert len(fake_http.calls) == 1
    url, kwargs = fake_http.calls[0]
    assert url == "https://smba.trafficmanager.net/amer/v3/conversations/conv-123/activities"
    assert kwargs["headers"]["Authorization"] == "Bearer tok"
    assert kwargs["json"]["text"] == "Reply text"
    assert kwargs["json"]["replyToId"] == "activity-1"


@pytest.mark.asyncio
async def test_send_posts_to_conversation_when_thread_reply_disabled(make_channel):
    ch = make_channel(replyInThread=False)
    fake_http = FakeHttpClient()
    ch._http = fake_http
    ch._token = "tok"
    ch._token_expires_at = 9999999999
    ch._conversation_refs["conv-123"] = ConversationRef(
        service_url="https://smba.trafficmanager.net/amer/",
        conversation_id="conv-123",
        activity_id="activity-1",
    )

    await ch.send(OutboundMessage(channel="msteams", chat_id="conv-123", content="Reply text"))

    assert len(fake_http.calls) == 1
    url, kwargs = fake_http.calls[0]
    assert url == "https://smba.trafficmanager.net/amer/v3/conversations/conv-123/activities"
    assert kwargs["headers"]["Authorization"] == "Bearer tok"
    assert kwargs["json"]["text"] == "Reply text"
    assert "replyToId" not in kwargs["json"]


@pytest.mark.asyncio
async def test_send_posts_to_conversation_when_thread_reply_enabled_but_no_activity_id(
    make_channel,
):
    ch = make_channel(replyInThread=True)
    fake_http = FakeHttpClient()
    ch._http = fake_http
    ch._token = "tok"
    ch._token_expires_at = 9999999999
    ch._conversation_refs["conv-123"] = ConversationRef(
        service_url="https://smba.trafficmanager.net/amer/",
        conversation_id="conv-123",
        activity_id=None,
    )

    await ch.send(OutboundMessage(channel="msteams", chat_id="conv-123", content="Reply text"))

    assert len(fake_http.calls) == 1
    url, kwargs = fake_http.calls[0]
    assert url == "https://smba.trafficmanager.net/amer/v3/conversations/conv-123/activities"
    assert kwargs["headers"]["Authorization"] == "Bearer tok"
    assert kwargs["json"]["text"] == "Reply text"
    assert "replyToId" not in kwargs["json"]


@pytest.mark.asyncio
async def test_send_raises_when_conversation_ref_missing(make_channel):
    ch = make_channel()
    ch._http = FakeHttpClient()

    with pytest.raises(RuntimeError, match="conversation ref not found"):
        await ch.send(OutboundMessage(channel="msteams", chat_id="missing", content="Reply text"))


@pytest.mark.asyncio
async def test_send_raises_delivery_failures_for_retry(make_channel):
    ch = make_channel()
    ch._http = FakeHttpClient(should_raise=True)
    ch._token = "tok"
    ch._token_expires_at = 9999999999
    ch._conversation_refs["conv-123"] = ConversationRef(
        service_url="https://smba.trafficmanager.net/amer/",
        conversation_id="conv-123",
        activity_id="activity-1",
    )

    with pytest.raises(RuntimeError, match="boom"):
        await ch.send(OutboundMessage(channel="msteams", chat_id="conv-123", content="Reply text"))


def _make_test_rsa_jwk(kid: str = "test-kid"):
    private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    public_key = private_key.public_key()
    jwk = json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(public_key))
    jwk["kid"] = kid
    jwk["use"] = "sig"
    jwk["kty"] = "RSA"
    jwk["alg"] = "RS256"
    return private_key, jwk


@pytest.mark.asyncio
async def test_validate_inbound_auth_accepts_observed_botframework_shape(make_channel):
    ch = make_channel(validateInboundAuth=True)

    private_key, jwk = _make_test_rsa_jwk()
    ch._botframework_jwks = {"keys": [jwk]}
    ch._botframework_jwks_expires_at = 9999999999

    service_url = "https://smba.trafficmanager.net/amer/tenant/"
    token = jwt.encode(
        {
            "iss": "https://api.botframework.com",
            "aud": "app-id",
            "serviceurl": service_url,
            "nbf": 1700000000,
            "exp": 4100000000,
        },
        private_key,
        algorithm="RS256",
        headers={"kid": jwk["kid"]},
    )

    await ch._validate_inbound_auth(
        f"Bearer {token}",
        {"serviceUrl": service_url},
    )


@pytest.mark.asyncio
async def test_validate_inbound_auth_rejects_service_url_mismatch(make_channel):
    ch = make_channel(validateInboundAuth=True)

    private_key, jwk = _make_test_rsa_jwk()
    ch._botframework_jwks = {"keys": [jwk]}
    ch._botframework_jwks_expires_at = 9999999999

    token = jwt.encode(
        {
            "iss": "https://api.botframework.com",
            "aud": "app-id",
            "serviceurl": "https://smba.trafficmanager.net/amer/tenant-a/",
            "nbf": 1700000000,
            "exp": 4100000000,
        },
        private_key,
        algorithm="RS256",
        headers={"kid": jwk["kid"]},
    )

    with pytest.raises(ValueError, match="serviceUrl claim mismatch"):
        await ch._validate_inbound_auth(
            f"Bearer {token}",
            {"serviceUrl": "https://smba.trafficmanager.net/amer/tenant-b/"},
        )


@pytest.mark.asyncio
async def test_validate_inbound_auth_rejects_missing_bearer_token(make_channel):
    ch = make_channel(validateInboundAuth=True)

    with pytest.raises(ValueError, match="missing bearer token"):
        await ch._validate_inbound_auth(
            "", {"serviceUrl": "https://smba.trafficmanager.net/amer/tenant/"}
        )


@pytest.mark.asyncio
async def test_start_logs_install_hint_when_pyjwt_missing(make_channel, monkeypatch):
    ch = make_channel()
    errors = []
    monkeypatch.setattr(msteams_module, "MSTEAMS_AVAILABLE", False)
    monkeypatch.setattr(
        msteams_module.logger, "error", lambda message, *args: errors.append(message.format(*args))
    )

    await ch.start()

    assert errors == ["PyJWT not installed. Run: pip install open-pawlet[msteams]"]


def test_msteams_default_config_includes_restart_notify_fields():
    cfg = MSTeamsChannel.default_config()

    assert cfg["validateInboundAuth"] is True
    assert "restartNotifyEnabled" not in cfg
    assert "restartNotifyPreMessage" not in cfg
    assert "restartNotifyPostMessage" not in cfg
