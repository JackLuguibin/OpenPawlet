"""Tests for AWS Bedrock (Converse API) provider registration."""

from openpawlet.config.schema import BedrockProviderConfig, ProvidersConfig
from openpawlet.providers.bedrock_provider import BedrockProvider
from openpawlet.providers.registry import PROVIDERS


def test_bedrock_config_field_exists():
    """ProvidersConfig should expose a bedrock block with region/profile."""
    config = ProvidersConfig()
    assert hasattr(config, "bedrock")
    assert isinstance(config.bedrock, BedrockProviderConfig)


def test_bedrock_provider_in_registry():
    """Bedrock should use the native Converse backend in the registry."""
    specs = {s.name: s for s in PROVIDERS}
    assert "bedrock" in specs
    b = specs["bedrock"]
    assert b.backend == "bedrock"
    assert b.env_key == "AWS_BEARER_TOKEN_BEDROCK"
    assert b.is_direct is True


def test_bedrock_strip_model_prefix():
    assert BedrockProvider._strip_prefix("bedrock/global.anthropic.claude-3-5-sonnet") == (
        "global.anthropic.claude-3-5-sonnet"
    )
    assert BedrockProvider._strip_prefix("us.anthropic.claude-3-haiku") == "us.anthropic.claude-3-haiku"
