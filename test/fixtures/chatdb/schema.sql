-- The tables of Messages' ~/Library/Messages/chat.db that phone-alert replies
-- read, with the columns they use, named and typed as macOS names them. Tests
-- build a database from this and fill it with made-up conversations; nothing
-- here comes from a real Messages database.
CREATE TABLE handle (
  ROWID INTEGER PRIMARY KEY AUTOINCREMENT UNIQUE,
  id TEXT NOT NULL,
  country TEXT,
  service TEXT NOT NULL,
  uncanonicalized_id TEXT,
  person_centric_id TEXT,
  UNIQUE (id, service)
);
CREATE TABLE chat (
  ROWID INTEGER PRIMARY KEY AUTOINCREMENT,
  guid TEXT UNIQUE NOT NULL,
  style INTEGER,
  state INTEGER,
  account_id TEXT,
  properties BLOB,
  chat_identifier TEXT,
  service_name TEXT,
  room_name TEXT,
  account_login TEXT,
  is_archived INTEGER DEFAULT 0,
  display_name TEXT
);
CREATE TABLE message (
  ROWID INTEGER PRIMARY KEY AUTOINCREMENT,
  guid TEXT UNIQUE NOT NULL,
  text TEXT,
  replace INTEGER DEFAULT 0,
  service_center TEXT,
  handle_id INTEGER DEFAULT 0,
  subject TEXT,
  country TEXT,
  attributedBody BLOB,
  version INTEGER DEFAULT 0,
  type INTEGER DEFAULT 0,
  service TEXT,
  account TEXT,
  date INTEGER,
  date_read INTEGER,
  date_delivered INTEGER,
  is_delivered INTEGER DEFAULT 0,
  is_finished INTEGER DEFAULT 0,
  is_from_me INTEGER DEFAULT 0,
  is_read INTEGER DEFAULT 0,
  is_sent INTEGER DEFAULT 0,
  item_type INTEGER DEFAULT 0,
  group_title TEXT,
  associated_message_guid TEXT,
  associated_message_type INTEGER DEFAULT 0,
  thread_originator_guid TEXT
);
CREATE TABLE chat_handle_join (chat_id INTEGER REFERENCES chat (ROWID) ON DELETE CASCADE, handle_id INTEGER REFERENCES handle (ROWID) ON DELETE CASCADE, UNIQUE (chat_id, handle_id));
CREATE TABLE chat_message_join (chat_id INTEGER REFERENCES chat (ROWID) ON DELETE CASCADE, message_id INTEGER REFERENCES message (ROWID) ON DELETE CASCADE, message_date INTEGER DEFAULT 0, PRIMARY KEY (chat_id, message_id));
