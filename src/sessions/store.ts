import { DatabaseSync } from "node:sqlite";

export type SessionEditorRole = "line" | "dev";
export type SessionMessageRole = "user" | "assistant";

export interface SessionMessage {
  role: SessionMessageRole;
  content: string;
}

export interface SessionRecord {
  id: number;
  project: string;
  sourceLabel: string;
  editorRole: SessionEditorRole;
  model: string;
  contextHash: string;
  createdAt: string;
  updatedAt: string;
  messages: SessionMessage[];
}

export interface SessionSummary extends Omit<SessionRecord, "messages"> {
  messageCount: number;
  preview: string;
}

export interface SessionStore {
  create(input: {
    project: string;
    sourceLabel: string;
    editorRole: SessionEditorRole;
    model: string;
    contextHash: string;
  }): SessionRecord;
  appendTurn(sessionId: number, user: string, assistant: string): void;
  get(sessionId: number): SessionRecord | null;
  list(project?: string, limit?: number): SessionSummary[];
  close(): void;
}

interface SessionRow {
  id: number | bigint;
  project: string;
  source_label: string;
  editor_role: SessionEditorRole;
  model: string;
  context_hash: string;
  created_at: string;
  updated_at: string;
}

interface SummaryRow extends SessionRow {
  message_count: number | bigint;
  preview: string;
}

export async function createSessionStore(path: string): Promise<SessionStore> {
  if (path !== ":memory:") {
    const directory = dirname(path);
    if (directory && directory !== ".") {
      await Deno.mkdir(directory, { recursive: true });
    }
  }

  const db = new DatabaseSync(path);
  try {
    db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
    `);

    const versionRow = db.prepare("PRAGMA user_version").get() as
      | { user_version: number | bigint }
      | undefined;
    const version = Number(versionRow?.user_version ?? 0);
    if (version > 1) {
      throw new Error(
        `Session database schema version ${version} is newer than supported version 1.`,
      );
    }

    db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project TEXT NOT NULL,
        source_label TEXT NOT NULL,
        editor_role TEXT NOT NULL CHECK (editor_role IN ('line', 'dev')),
        model TEXT NOT NULL,
        context_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS session_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(session_id, ordinal)
      );

      CREATE INDEX IF NOT EXISTS idx_sessions_project_updated
        ON sessions(project, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_session_messages_session
        ON session_messages(session_id, ordinal);
    `);
    if (version < 1) db.exec("PRAGMA user_version = 1");
  } catch (error) {
    db.close();
    throw error;
  }

  let closed = false;

  const store: SessionStore = {
    create(input): SessionRecord {
      const now = new Date().toISOString();
      const result = db.prepare(`
        INSERT INTO sessions (
          project, source_label, editor_role, model, context_hash,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.project,
        input.sourceLabel,
        input.editorRole,
        input.model,
        input.contextHash,
        now,
        now,
      );

      return {
        id: Number(result.lastInsertRowid),
        ...input,
        createdAt: now,
        updatedAt: now,
        messages: [],
      };
    },

    appendTurn(sessionId, user, assistant): void {
      const row = db.prepare(`
        SELECT COALESCE(MAX(ordinal), -1) AS ordinal
        FROM session_messages
        WHERE session_id = ?
      `).get(sessionId) as { ordinal: number | bigint } | undefined;
      const next = Number(row?.ordinal ?? -1) + 1;
      const now = new Date().toISOString();

      db.exec("BEGIN IMMEDIATE");
      try {
        const insert = db.prepare(`
          INSERT INTO session_messages (
            session_id, ordinal, role, content, created_at
          ) VALUES (?, ?, ?, ?, ?)
        `);
        insert.run(sessionId, next, "user", user, now);
        insert.run(sessionId, next + 1, "assistant", assistant, now);
        db.prepare(`
          UPDATE sessions SET updated_at = ? WHERE id = ?
        `).run(now, sessionId);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },

    get(sessionId): SessionRecord | null {
      const row = db.prepare(`
        SELECT id, project, source_label, editor_role, model, context_hash,
               created_at, updated_at
        FROM sessions
        WHERE id = ?
      `).get(sessionId) as SessionRow | undefined;
      if (!row) return null;

      const messages = db.prepare(`
        SELECT role, content
        FROM session_messages
        WHERE session_id = ?
        ORDER BY ordinal
      `).all(sessionId) as Array<{
        role: SessionMessageRole;
        content: string;
      }>;

      return {
        ...mapSessionRow(row),
        messages,
      };
    },

    list(project, limit = 20): SessionSummary[] {
      const where = project ? "WHERE s.project = ?" : "";
      const params = project ? [project, limit] : [limit];
      const rows = db.prepare(`
        SELECT
          s.id, s.project, s.source_label, s.editor_role, s.model,
          s.context_hash, s.created_at, s.updated_at,
          COUNT(m.id) AS message_count,
          COALESCE((
            SELECT content
            FROM session_messages first_message
            WHERE first_message.session_id = s.id
              AND first_message.role = 'user'
            ORDER BY first_message.ordinal
            LIMIT 1
          ), '') AS preview
        FROM sessions s
        JOIN session_messages m ON m.session_id = s.id
        ${where}
        GROUP BY s.id
        ORDER BY s.updated_at DESC
        LIMIT ?
      `).all(...params) as unknown as SummaryRow[];

      return rows.map((row) => ({
        ...mapSessionRow(row),
        messageCount: Number(row.message_count),
        preview: row.preview,
      }));
    },

    close(): void {
      if (closed) return;
      closed = true;
      db.close();
    },
  };

  return store;
}

function mapSessionRow(row: SessionRow): Omit<SessionRecord, "messages"> {
  return {
    id: Number(row.id),
    project: row.project,
    sourceLabel: row.source_label,
    editorRole: row.editor_role,
    model: row.model,
    contextHash: row.context_hash,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function dirname(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  const slash = normalized.lastIndexOf("/");
  if (slash === -1) return ".";
  if (slash === 0) return "/";
  return normalized.slice(0, slash);
}
