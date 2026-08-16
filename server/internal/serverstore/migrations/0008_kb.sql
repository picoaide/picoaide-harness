CREATE TABLE kb_folders (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, parent_id INTEGER DEFAULT 0, created_at DATETIME DEFAULT (datetime('now','localtime')));
CREATE TABLE kb_documents (id INTEGER PRIMARY KEY AUTOINCREMENT, folder_id INTEGER NOT NULL DEFAULT 0, title TEXT NOT NULL, content TEXT NOT NULL, content_type TEXT NOT NULL DEFAULT 'text', size INTEGER NOT NULL DEFAULT 0, source TEXT NOT NULL DEFAULT 'upload', created_by TEXT NOT NULL, created_at DATETIME DEFAULT (datetime('now','localtime')));
CREATE TABLE kb_folder_users (folder_id INTEGER NOT NULL, username TEXT NOT NULL, PRIMARY KEY(folder_id, username));
CREATE TABLE kb_folder_groups (folder_id INTEGER NOT NULL, group_id INTEGER NOT NULL, PRIMARY KEY(folder_id, group_id));
CREATE TABLE kb_audit_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL, action TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '', created_at DATETIME DEFAULT (datetime('now','localtime')));
CREATE VIRTUAL TABLE kb_fts USING fts5(title, content, content='kb_documents', content_rowid='id', tokenize='unicode61 remove_diacritics 2');
CREATE TRIGGER kb_ai AFTER INSERT ON kb_documents BEGIN INSERT INTO kb_fts(rowid, title, content) VALUES (new.id, new.title, new.content); END;
CREATE TRIGGER kb_ad AFTER DELETE ON kb_documents BEGIN INSERT INTO kb_fts(kb_fts, rowid, title, content) VALUES('delete', old.id, old.title, old.content); END;
CREATE TRIGGER kb_au AFTER UPDATE ON kb_documents BEGIN INSERT INTO kb_fts(kb_fts, rowid, title, content) VALUES('delete', old.id, old.title, old.content); INSERT INTO kb_fts(rowid, title, content) VALUES (new.id, new.title, new.content); END;
