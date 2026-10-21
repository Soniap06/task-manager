CREATE TABLE users (
    id TEXT PRIMARY KEY NOT NULL CHECK (length(trim(id)) > 0),
    display_name TEXT NOT NULL CHECK (length(trim(display_name)) > 0),
    github_login TEXT COLLATE NOCASE UNIQUE CHECK (github_login IS NULL OR length(trim(github_login)) > 0),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE TABLE projects (
    id TEXT PRIMARY KEY NOT NULL CHECK (length(trim(id)) > 0),
    github_repository_id INTEGER NOT NULL UNIQUE CHECK (github_repository_id > 0),
    installation_id INTEGER NOT NULL CHECK (installation_id > 0),
    owner TEXT NOT NULL COLLATE NOCASE CHECK (length(trim(owner)) > 0),
    name TEXT NOT NULL COLLATE NOCASE CHECK (length(trim(name)) > 0),
    base_branch TEXT NOT NULL CHECK (length(trim(base_branch)) > 0),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    UNIQUE (owner, name)
) STRICT;

CREATE TABLE employees (
    id TEXT PRIMARY KEY NOT NULL CHECK (length(trim(id)) > 0),
    user_id TEXT UNIQUE REFERENCES users(id) ON DELETE SET NULL,
    name TEXT NOT NULL CHECK (length(trim(name)) > 0),
    role TEXT NOT NULL CHECK (length(trim(role)) > 0),
    executor_type TEXT NOT NULL CHECK (executor_type IN ('human', 'ai_agent')),
    stack TEXT NOT NULL DEFAULT '[]' CHECK (CASE WHEN json_valid(stack) THEN json_type(stack) = 'array' ELSE 0 END),
    capacity INTEGER NOT NULL DEFAULT 0 CHECK (capacity >= 0),
    avatar_url TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE TABLE tasks (
    id TEXT PRIMARY KEY NOT NULL CHECK (length(trim(id)) > 0),
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    title TEXT NOT NULL CHECK (length(trim(title)) > 0),
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo', 'progress', 'review')),
    branch TEXT CHECK (branch IS NULL OR length(trim(branch)) > 0),
    pr_url TEXT,
    assignee_id TEXT REFERENCES employees(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE INDEX tasks_project_status ON tasks(project_id, status);
CREATE INDEX tasks_assignee ON tasks(assignee_id);

CREATE TABLE events (
    id TEXT PRIMARY KEY NOT NULL CHECK (length(trim(id)) > 0),
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
    event_type TEXT NOT NULL CHECK (length(trim(event_type)) > 0),
    payload_summary TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE INDEX events_project_created ON events(project_id, created_at);
