"""Matrix-nio sqlite store basename must stay colon-free for Windows filesystems."""


def test_matrix_safe_store_name_replaces_colons_in_user_id() -> None:
    user_id = "@bot:matrix.org"
    device_id = "DEV123"
    safe_store_name = user_id.replace(":", "_") + f"_{device_id}.db"
    assert safe_store_name == "@bot_matrix.org_DEV123.db"
