CREATE TABLE webhook_deliveries (
    delivery_id TEXT PRIMARY KEY NOT NULL,
    received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;
