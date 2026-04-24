# Honcho: `honcho start` from repo root (venv activated).
# Ctrl+C stops all processes.
#
# The `queue` process MUST come first - the gateway sees
# QUEUE_MANAGER_ENABLED=true and connects to it on startup.  When
# QUEUE_MANAGER_ENABLED is unset or set to false the gateway falls
# back to an in-process bus (handy for local debugging without the
# broker).
queue: open-pawlet-queue-manager
gateway: QUEUE_MANAGER_ENABLED=true console gateway
server: console server
web: console web dev
