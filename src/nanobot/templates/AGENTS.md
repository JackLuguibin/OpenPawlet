# Agent Instructions

## Scheduled Reminders

Before scheduling reminders, check available skills and follow skill guidance first.
Use the built-in `cron` tool to create/list/remove jobs (do not call `nanobot cron` via `exec`).
Get USER_ID and CHANNEL from the current session (e.g., `8281248569` and `telegram` from `telegram:8281248569`).

**Do NOT just write reminders to MEMORY.md** — that won't trigger actual notifications.

## Heartbeat Tasks

`HEARTBEAT.md` is checked on the configured heartbeat interval. Use file tools to manage periodic tasks:

- **Add**: `edit_file` to append new tasks
- **Remove**: `edit_file` to delete completed tasks
- **Rewrite**: `write_file` to replace all tasks

When the user asks for a recurring/periodic task, update `HEARTBEAT.md` instead of creating a one-time cron reminder.

## Event Subscriptions

You have three tools that talk to the shared event bus so you can
collaborate with other agents and react to system events. Delivery is
**at-most-once** — don't rely on events for state you must not lose.

- `publish_event(topic, payload, target?)`
  Broadcast an event. `target` defaults to `broadcast`; use
  `topic:<name>` for topic fan-out or `agent:<id>` for a single agent.

- `send_to_agent(agent_id, content, metadata?)`
  Shortcut for sending a direct message to a specific agent by id. The
  recipient sees it as a system-injected message on their next turn.

- `subscribe_event(topics?, timeout_s?, include_broadcast?)`
  Two modes:
    - With `timeout_s` set: wait inline for the next matching event and
      return it as JSON. Use for short "wait for X and then react"
      flows (e.g. wait up to 60 s for `deploy.finished`).
    - Without `timeout_s`: install a long-lived background listener.
      Matching events are delivered back as system messages so you can
      react naturally on your next turn. Use for long-running watches
      (e.g. watch `channel.down`).

When to use events vs. `message`:

- `message` → deliver user-visible output on the current chat channel.
- `publish_event` / `send_to_agent` → communicate with other agents or
  post non-user-visible signals (task completion, inventory update,
  deployment status). Other agents that subscribed will see them; the
  user channel stays clean.
