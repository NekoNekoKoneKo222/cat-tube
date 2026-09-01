const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL が設定されていません。Render の Environment Variables を確認してください。');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production'
    ? { rejectUnauthorized: false }
    : false
});

const uploadDir = path.join(__dirname, 'uploads');
fs.mkdirSync(uploadDir, { recursive: true });

const upload = multer({
  dest: uploadDir,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /^image\/(png|jpeg|jpg|gif|webp)$/.test(file.mimetype);
    cb(null, ok);
  }
});

const sessionMiddleware = session({
  store: new PgSession({
    pool,
    tableName: 'user_sessions',
    createTableIfMissing: true
  }),
  secret: process.env.SESSION_SECRET || 'CHANGE_THIS_SESSION_SECRET',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 1000 * 60 * 60 * 24 * 30
  }
});

app.use(sessionMiddleware);
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static(uploadDir));

function appendLog(fileName, text) {
  try {
    fs.appendFileSync(
      path.join(__dirname, fileName),
      `[${new Date().toISOString()}] ${text}\n`,
      'utf8'
    );
  } catch (error) {
    console.error(`ログ保存失敗: ${fileName}`, error.message);
  }
}

async function readAdminFile() {
  const file = path.join(__dirname, 'admin.txt');
  try {
    const raw = await fs.promises.readFile(file, 'utf8');
    return raw
      .split(/\r?\n/)
      .map(v => v.trim().toLowerCase())
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function isAdminUser(userId) {
  if (!userId) return false;

  const result = await pool.query(
    'SELECT is_admin, username FROM users WHERE id = $1',
    [userId]
  );

  if (!result.rowCount) return false;
  if (result.rows[0].is_admin === true) return true;

  const admins = await readAdminFile();
  return admins.includes(String(result.rows[0].username).toLowerCase());
}

async function requireAdmin(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'ログインが必要です' });
  }

  if (!(await isAdminUser(req.session.userId))) {
    return res.status(403).json({ error: '管理者権限が必要です' });
  }

  next();
}

const auth = (req, res, next) => {
  if (req.session.userId) return next();
  return res.status(401).json({ error: 'ログインが必要です' });
};

async function isRoomOwner(userId, roomId) {
  const result = await pool.query(
    'SELECT 1 FROM rooms WHERE id = $1 AND owner_id = $2',
    [roomId, userId]
  );
  return result.rowCount > 0;
}

async function isRoomMember(userId, roomId) {
  const result = await pool.query(
    'SELECT 1 FROM room_members WHERE room_id = $1 AND user_id = $2',
    [roomId, userId]
  );
  return result.rowCount > 0;
}

async function roomExists(roomId) {
  const result = await pool.query('SELECT 1 FROM rooms WHERE id = $1', [roomId]);
  return result.rowCount > 0;
}

async function isRoomBanned(userId, roomId) {
  const result = await pool.query(
    'SELECT 1 FROM room_bans WHERE room_id = $1 AND user_id = $2',
    [roomId, userId]
  );
  return result.rowCount > 0;
}

async function writeAdminLog({ adminId, action, roomId = null, targetUserId = null, messageId = null, detail = '' }) {
  await pool.query(
    `INSERT INTO admin_logs
      (admin_id, action, room_id, target_user_id, message_id, detail)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [adminId, action, roomId, targetUserId, messageId, detail]
  );

  appendLog(
    'adminlog.txt',
    JSON.stringify({
      adminId,
      action,
      roomId,
      targetUserId,
      messageId,
      detail
    })
  );
}

async function writeChatLog({ roomId, senderId, messageId, content, imageUrl = null, action = 'MESSAGE' }) {
  const roomResult = await pool.query('SELECT name FROM rooms WHERE id = $1', [roomId]);
  const userResult = await pool.query('SELECT username FROM users WHERE id = $1', [senderId]);

  const roomName = roomResult.rows[0]?.name || 'unknown';
  const username = userResult.rows[0]?.username || 'unknown';

  const entry = {
    action,
    roomId,
    roomName,
    userId: senderId,
    username,
    messageId,
    content: content || '',
    imageUrl,
    time: new Date().toISOString()
  };

  appendLog('chatlog.txt', JSON.stringify(entry));
}

/* ----------------------------------------
   Database initialization
----------------------------------------- */

async function db() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username VARCHAR(32) UNIQUE NOT NULL,
      display_name VARCHAR(64) NOT NULL,
      password_hash TEXT NOT NULL,
      avatar_url TEXT,
      bio TEXT DEFAULT '',
      is_admin BOOLEAN DEFAULT FALSE,
      is_banned BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      last_online TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS friendships (
      id SERIAL PRIMARY KEY,
      requester_id INT REFERENCES users(id) ON DELETE CASCADE,
      addressee_id INT REFERENCES users(id) ON DELETE CASCADE,
      status VARCHAR(20) NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(requester_id, addressee_id)
    );

    CREATE TABLE IF NOT EXISTS dm_rooms (
      id SERIAL PRIMARY KEY,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS dm_members (
      room_id INT REFERENCES dm_rooms(id) ON DELETE CASCADE,
      user_id INT REFERENCES users(id) ON DELETE CASCADE,
      PRIMARY KEY(room_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      room_id INT REFERENCES dm_rooms(id) ON DELETE CASCADE,
      sender_id INT REFERENCES users(id) ON DELETE CASCADE,
      content TEXT DEFAULT '',
      image_url TEXT,
      deleted BOOLEAN DEFAULT FALSE,
      reply_to_id INT REFERENCES messages(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id SERIAL PRIMARY KEY,
      user_id INT REFERENCES users(id) ON DELETE CASCADE,
      type VARCHAR(40) NOT NULL DEFAULT 'info',
      title TEXT,
      content TEXT,
      is_read BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS groups (
      id SERIAL PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      owner_id INT REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS group_members (
      group_id INT REFERENCES groups(id) ON DELETE CASCADE,
      user_id INT REFERENCES users(id) ON DELETE CASCADE,
      role VARCHAR(20) DEFAULT 'member',
      PRIMARY KEY(group_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS communities (
      id SERIAL PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      description TEXT DEFAULT '',
      owner_id INT REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS channels (
      id SERIAL PRIMARY KEY,
      community_id INT REFERENCES communities(id) ON DELETE CASCADE,
      name VARCHAR(50) NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS channel_messages (
      id SERIAL PRIMARY KEY,
      channel_id INT REFERENCES channels(id) ON DELETE CASCADE,
      sender_id INT REFERENCES users(id) ON DELETE CASCADE,
      content TEXT DEFAULT '',
      image_url TEXT,
      deleted BOOLEAN DEFAULT FALSE,
      reply_to_id INT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS reactions (
      id SERIAL PRIMARY KEY,
      message_id INT REFERENCES messages(id) ON DELETE CASCADE,
      user_id INT REFERENCES users(id) ON DELETE CASCADE,
      image_url TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(message_id, user_id, image_url)
    );

    CREATE TABLE IF NOT EXISTS rooms (
      id SERIAL PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      owner_id INT REFERENCES users(id) ON DELETE SET NULL,
      is_private BOOLEAN NOT NULL DEFAULT FALSE,
      require_join_code BOOLEAN NOT NULL DEFAULT FALSE,
      join_code TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS room_members (
      room_id INT REFERENCES rooms(id) ON DELETE CASCADE,
      user_id INT REFERENCES users(id) ON DELETE CASCADE,
      joined_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY(room_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS room_bans (
      id SERIAL PRIMARY KEY,
      room_id INT REFERENCES rooms(id) ON DELETE CASCADE,
      user_id INT REFERENCES users(id) ON DELETE CASCADE,
      banned_by INT REFERENCES users(id) ON DELETE SET NULL,
      reason TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(room_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS admin_logs (
      id SERIAL PRIMARY KEY,
      admin_id INT REFERENCES users(id) ON DELETE SET NULL,
      action VARCHAR(50) NOT NULL,
      room_id INT REFERENCES rooms(id) ON DELETE SET NULL,
      target_user_id INT REFERENCES users(id) ON DELETE SET NULL,
      message_id INT,
      detail TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS reports (
      id SERIAL PRIMARY KEY,
      reporter_id INT REFERENCES users(id) ON DELETE SET NULL,
      target_user_id INT REFERENCES users(id) ON DELETE SET NULL,
      room_id INT REFERENCES rooms(id) ON DELETE SET NULL,
      message_id INT,
      reason TEXT NOT NULL,
      status VARCHAR(20) DEFAULT 'open',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await pool.query(`
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS avatar_url TEXT,
      ADD COLUMN IF NOT EXISTS bio TEXT DEFAULT '',
      ADD COLUMN IF NOT EXISTS is_admin BOOLEAN DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS is_banned BOOLEAN DEFAULT FALSE;

    ALTER TABLE messages
      ADD COLUMN IF NOT EXISTS deleted BOOLEAN DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS reply_to_id INT REFERENCES messages(id) ON DELETE SET NULL;

    ALTER TABLE channel_messages
      ADD COLUMN IF NOT EXISTS deleted BOOLEAN DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS reply_to_id INT;

    ALTER TABLE rooms
      ADD COLUMN IF NOT EXISTS is_private BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS require_join_code BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS join_code TEXT;
  `);
}

/* ----------------------------------------
   Health
----------------------------------------- */

app.get('/healthz', (req, res) => {
  res.json({ ok: true, service: 'cloud-cat' });
});

/* ----------------------------------------
   Auth / account
----------------------------------------- */

app.post('/api/auth/signup', async (req, res) => {
  try {
    const username = String(req.body.username || '').trim().toLowerCase();
    const displayName = String(req.body.displayName || username).trim();
    const password = String(req.body.password || '');

    if (!/^[a-z0-9_]{3,32}$/.test(username)) {
      return res.status(400).json({
        error: 'ユーザー名は英数字と _ の3〜32文字です'
      });
    }

    if (password.length < 8) {
      return res.status(400).json({
        error: 'パスワードは8文字以上です'
      });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const result = await pool.query(
      `INSERT INTO users(username, display_name, password_hash)
       VALUES($1, $2, $3)
       RETURNING id, username, display_name, avatar_url, bio, is_admin`,
      [username, displayName || username, passwordHash]
    );

    req.session.userId = result.rows[0].id;

    res.json({ user: result.rows[0] });
  } catch (error) {
    console.error(error);

    if (error.code === '23505') {
      return res.status(409).json({
        error: 'そのユーザー名はすでに使用されています'
      });
    }

    res.status(500).json({ error: '登録に失敗しました' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const username = String(req.body.username || '').trim().toLowerCase();
    const password = String(req.body.password || '');

    const result = await pool.query(
      'SELECT * FROM users WHERE username = $1',
      [username]
    );

    if (!result.rowCount) {
      return res.status(401).json({ error: 'ログイン情報が違います' });
    }

    const user = result.rows[0];

    if (user.is_banned) {
      return res.status(403).json({ error: 'このアカウントは停止されています' });
    }

    if (!(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ error: 'ログイン情報が違います' });
    }

    req.session.userId = user.id;

    await pool.query(
      'UPDATE users SET last_online = NOW() WHERE id = $1',
      [user.id]
    );

    const admin = await isAdminUser(user.id);

    res.json({
      user: {
        id: user.id,
        username: user.username,
        display_name: user.display_name,
        avatar_url: user.avatar_url,
        bio: user.bio,
        is_admin: admin
      }
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'ログインに失敗しました' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ ok: true });
  });
});

app.get('/api/me', auth, async (req, res) => {
  const result = await pool.query(
    `SELECT id, username, display_name, avatar_url, bio, created_at,
            last_online, is_banned
     FROM users WHERE id = $1`,
    [req.session.userId]
  );

  if (!result.rowCount) {
    return res.status(404).json({ error: 'ユーザーが見つかりません' });
  }

  const user = result.rows[0];
  user.is_admin = await isAdminUser(user.id);

  res.json(user);
});

app.patch('/api/me', auth, async (req, res) => {
  const displayName = String(req.body.displayName ?? '').trim();
  const bio = String(req.body.bio ?? '').trim();

  if (displayName.length > 64) {
    return res.status(400).json({ error: '表示名が長すぎます' });
  }

  await pool.query(
    'UPDATE users SET display_name = $1, bio = $2 WHERE id = $3',
    [displayName || 'User', bio, req.session.userId]
  );

  res.json({ ok: true });
});

app.post('/api/me/password', auth, async (req, res) => {
  const password = String(req.body.password || '');

  if (password.length < 8) {
    return res.status(400).json({ error: 'パスワードは8文字以上です' });
  }

  const hash = await bcrypt.hash(password, 12);

  await pool.query(
    'UPDATE users SET password_hash = $1 WHERE id = $2',
    [hash, req.session.userId]
  );

  res.json({ ok: true });
});

app.post('/api/me/icon', auth, upload.single('image'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: '画像を選択してください' });
  }

  const imageUrl = `/uploads/${req.file.filename}`;

  await pool.query(
    'UPDATE users SET avatar_url = $1 WHERE id = $2',
    [imageUrl, req.session.userId]
  );

  res.json({ ok: true, avatar_url: imageUrl });
});

/* ----------------------------------------
   Friends
----------------------------------------- */

app.get('/api/users/search', auth, async (req, res) => {
  const q = `%${String(req.query.q || '').trim()}%`;

  const result = await pool.query(
    `SELECT id, username, display_name, avatar_url
     FROM users
     WHERE id <> $1
       AND is_banned = FALSE
       AND (username ILIKE $2 OR display_name ILIKE $2)
     ORDER BY display_name
     LIMIT 20`,
    [req.session.userId, q]
  );

  res.json(result.rows);
});

app.post('/api/friends/request', auth, async (req, res) => {
  const targetUserId = Number(req.body.userId);

  if (!targetUserId || targetUserId === req.session.userId) {
    return res.status(400).json({ error: 'ユーザーが不正です' });
  }

  try {
    const target = await pool.query(
      'SELECT id, is_banned FROM users WHERE id = $1',
      [targetUserId]
    );

    if (!target.rowCount || target.rows[0].is_banned) {
      return res.status(404).json({ error: 'ユーザーが見つかりません' });
    }

    await pool.query(
      `INSERT INTO friendships(requester_id, addressee_id)
       VALUES($1, $2)`,
      [req.session.userId, targetUserId]
    );

    await pool.query(
      `INSERT INTO notifications(user_id, type, title, content)
       VALUES($1, 'friend_request', 'フレンド申請', 'フレンド申請が届きました')`,
      [targetUserId]
    );

    io.to(`u:${targetUserId}`).emit('notification');

    res.json({ ok: true });
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({ error: '申請はすでに存在します' });
    }

    console.error(error);
    res.status(500).json({ error: '申請に失敗しました' });
  }
});

app.get('/api/friends', auth, async (req, res) => {
  const result = await pool.query(
    `SELECT
       f.id,
       f.status,
       f.requester_id,
       u.id AS user_id,
       u.username,
       u.display_name,
       u.avatar_url
     FROM friendships f
     JOIN users u
       ON u.id = CASE
         WHEN f.requester_id = $1 THEN f.addressee_id
         ELSE f.requester_id
       END
     WHERE f.requester_id = $1 OR f.addressee_id = $1
     ORDER BY u.display_name`,
    [req.session.userId]
  );

  res.json(result.rows);
});

app.post('/api/friends/accept', auth, async (req, res) => {
  const friendshipId = Number(req.body.friendshipId);

  const result = await pool.query(
    `UPDATE friendships
     SET status = 'accepted'
     WHERE id = $1
       AND addressee_id = $2
       AND status = 'pending'
     RETURNING requester_id`,
    [friendshipId, req.session.userId]
  );

  if (!result.rowCount) {
    return res.status(404).json({ error: '申請がありません' });
  }

  const requesterId = result.rows[0].requester_id;

  await pool.query(
    `INSERT INTO notifications(user_id, type, title, content)
     VALUES($1, 'friend_accept', 'フレンド承認', 'フレンド申請が承認されました')`,
    [requesterId]
  );

  io.to(`u:${requesterId}`).emit('notification');

  res.json({ ok: true });
});

/* ----------------------------------------
   DM
----------------------------------------- */

app.post('/api/dm/open', auth, async (req, res) => {
  const otherUserId = Number(req.body.userId);

  const result = await pool.query(
    `SELECT r.id
     FROM dm_rooms r
     JOIN dm_members a ON a.room_id = r.id
     JOIN dm_members b ON b.room_id = r.id
     WHERE a.user_id = $1
       AND b.user_id = $2
       AND (
         SELECT COUNT(*) FROM dm_members m
         WHERE m.room_id = r.id
       ) = 2
     LIMIT 1`,
    [req.session.userId, otherUserId]
  );

  if (result.rowCount) {
    return res.json({ roomId: result.rows[0].id });
  }

  const room = await pool.query(
    'INSERT INTO dm_rooms DEFAULT VALUES RETURNING id'
  );

  await pool.query(
    `INSERT INTO dm_members(room_id, user_id)
     VALUES($1, $2), ($1, $3)`,
    [room.rows[0].id, req.session.userId, otherUserId]
  );

  res.json({ roomId: room.rows[0].id });
});

app.get('/api/dm/rooms', auth, async (req, res) => {
  const result = await pool.query(
    `SELECT
       r.id AS room_id,
       u.id AS user_id,
       u.username,
       u.display_name,
       u.avatar_url,
       (
         SELECT content
         FROM messages
         WHERE room_id = r.id
         ORDER BY created_at DESC
         LIMIT 1
       ) AS last_message
     FROM dm_rooms r
     JOIN dm_members a
       ON a.room_id = r.id
      AND a.user_id = $1
     JOIN dm_members b
       ON b.room_id = r.id
      AND b.user_id <> $1
     JOIN users u ON u.id = b.user_id
     ORDER BY r.id DESC`,
    [req.session.userId]
  );

  res.json(result.rows);
});

app.get('/api/dm/:id', auth, async (req, res) => {
  const roomId = Number(req.params.id);

  const member = await pool.query(
    'SELECT 1 FROM dm_members WHERE room_id = $1 AND user_id = $2',
    [roomId, req.session.userId]
  );

  if (!member.rowCount) {
    return res.status(403).json({ error: 'アクセスできません' });
  }

  const result = await pool.query(
    `SELECT
       m.id,
       m.sender_id,
       m.content,
       m.image_url,
       m.deleted,
       m.reply_to_id,
       m.created_at,
       u.display_name,
       u.username
     FROM messages m
     JOIN users u ON u.id = m.sender_id
     WHERE m.room_id = $1
     ORDER BY m.created_at`,
    [roomId]
  );

  res.json(result.rows);
});

app.post('/api/dm/:id', auth, upload.single('image'), async (req, res) => {
  const roomId = Number(req.params.id);
  const text = String(req.body.content || '');
  const replyToId = req.body.replyToId ? Number(req.body.replyToId) : null;
  const imageUrl = req.file ? `/uploads/${req.file.filename}` : null;

  const member = await pool.query(
    'SELECT 1 FROM dm_members WHERE room_id = $1 AND user_id = $2',
    [roomId, req.session.userId]
  );

  if (!member.rowCount) {
    return res.status(403).json({ error: 'アクセスできません' });
  }

  if (!text.trim() && !imageUrl) {
    return res.status(400).json({ error: '空のメッセージです' });
  }

  const result = await pool.query(
    `INSERT INTO messages(room_id, sender_id, content, image_url, reply_to_id)
     VALUES($1, $2, $3, $4, $5)
     RETURNING *`,
    [roomId, req.session.userId, text, imageUrl, replyToId]
  );

  await writeChatLog({
    roomId,
    senderId: req.session.userId,
    messageId: result.rows[0].id,
    content: text,
    imageUrl
  });

  io.to(`r:${roomId}`).emit('message', result.rows[0]);

  res.json(result.rows[0]);
});

app.delete('/api/dm/messages/:messageId', auth, async (req, res) => {
  const messageId = Number(req.params.messageId);

  const result = await pool.query(
    `SELECT m.id, m.room_id, m.sender_id
     FROM messages m
     WHERE m.id = $1`,
    [messageId]
  );

  if (!result.rowCount) {
    return res.status(404).json({ error: 'メッセージがありません' });
  }

  const message = result.rows[0];

  const admin = await isAdminUser(req.session.userId);
  const owner = await isRoomOwner(req.session.userId, message.room_id);

  if (message.sender_id !== req.session.userId && !admin && !owner) {
    return res.status(403).json({ error: '削除権限がありません' });
  }

  await pool.query(
    `UPDATE messages
     SET deleted = TRUE, content = '', image_url = NULL
     WHERE id = $1`,
    [messageId]
  );

  await writeAdminLog({
    adminId: req.session.userId,
    action: 'DELETE_MESSAGE',
    roomId: message.room_id,
    targetUserId: message.sender_id,
    messageId,
    detail: 'DMメッセージ削除'
  });

  await writeChatLog({
    roomId: message.room_id,
    senderId: req.session.userId,
    messageId,
    content: '',
    action: 'DELETE_MESSAGE'
  });

  io.to(`r:${message.room_id}`).emit('messageDeleted', { messageId });

  res.json({ ok: true });
});

app.post('/api/messages/:messageId/reaction', auth, async (req, res) => {
  const messageId = Number(req.params.messageId);
  const imageUrl = String(req.body.imageUrl || '').trim();

  if (!imageUrl) {
    return res.status(400).json({ error: 'リアクション画像がありません' });
  }

  const message = await pool.query(
    `SELECT id, room_id FROM messages WHERE id = $1`,
    [messageId]
  );

  if (!message.rowCount) {
    return res.status(404).json({ error: 'メッセージがありません' });
  }

  const member = await isRoomMember(req.session.userId, message.rows[0].room_id);

  if (!member) {
    return res.status(403).json({ error: 'アクセスできません' });
  }

  const result = await pool.query(
    `INSERT INTO reactions(message_id, user_id, image_url)
     VALUES($1, $2, $3)
     ON CONFLICT DO NOTHING
     RETURNING *`,
    [messageId, req.session.userId, imageUrl]
  );

  if (result.rowCount) {
    io.to(`r:${message.rows[0].room_id}`).emit('reaction', result.rows[0]);
  }

  res.json({ ok: true, reaction: result.rows[0] || null });
});

app.delete('/api/messages/:messageId/reaction', auth, async (req, res) => {
  const messageId = Number(req.params.messageId);
  const imageUrl = String(req.body.imageUrl || '').trim();

  const message = await pool.query(
    'SELECT room_id FROM messages WHERE id = $1',
    [messageId]
  );

  if (!message.rowCount) {
    return res.status(404).json({ error: 'メッセージがありません' });
  }

  await pool.query(
    `DELETE FROM reactions
     WHERE message_id = $1
       AND user_id = $2
       AND image_url = $3`,
    [messageId, req.session.userId, imageUrl]
  );

  io.to(`r:${message.rows[0].room_id}`).emit('reactionRemoved', {
    messageId,
    userId: req.session.userId,
    imageUrl
  });

  res.json({ ok: true });
});

/* ----------------------------------------
   Notifications
----------------------------------------- */

app.get('/api/notifications', auth, async (req, res) => {
  const result = await pool.query(
    `SELECT *
     FROM notifications
     WHERE user_id = $1
     ORDER BY created_at DESC
     LIMIT 50`,
    [req.session.userId]
  );

  res.json(result.rows);
});

app.post('/api/notifications/read', auth, async (req, res) => {
  await pool.query(
    'UPDATE notifications SET is_read = TRUE WHERE user_id = $1',
    [req.session.userId]
  );

  res.json({ ok: true });
});

/* ----------------------------------------
   Groups / Communities
----------------------------------------- */

app.post('/api/groups', auth, async (req, res) => {
  const name = String(req.body.name || '').trim();

  if (!name) {
    return res.status(400).json({ error: 'グループ名を入力してください' });
  }

  const result = await pool.query(
    'INSERT INTO groups(name, owner_id) VALUES($1, $2) RETURNING *',
    [name, req.session.userId]
  );

  await pool.query(
    `INSERT INTO group_members(group_id, user_id, role)
     VALUES($1, $2, 'owner')`,
    [result.rows[0].id, req.session.userId]
  );

  res.json(result.rows[0]);
});

app.get('/api/groups', auth, async (req, res) => {
  const result = await pool.query(
    `SELECT g.id, g.name, g.owner_id, g.created_at, gm.role
     FROM groups g
     JOIN group_members gm ON gm.group_id = g.id
     WHERE gm.user_id = $1
     ORDER BY g.id DESC`,
    [req.session.userId]
  );

  res.json(result.rows);
});

app.post('/api/communities', auth, async (req, res) => {
  const name = String(req.body.name || '').trim();
  const description = String(req.body.description || '').trim();

  if (!name) {
    return res.status(400).json({ error: 'コミュニティ名を入力してください' });
  }

  const result = await pool.query(
    `INSERT INTO communities(name, description, owner_id)
     VALUES($1, $2, $3)
     RETURNING *`,
    [name, description, req.session.userId]
  );

  await pool.query(
    `INSERT INTO channels(community_id, name)
     VALUES($1, 'general')`,
    [result.rows[0].id]
  );

  res.json(result.rows[0]);
});

app.get('/api/communities', auth, async (req, res) => {
  const result = await pool.query(
    `SELECT id, name, description, owner_id, created_at
     FROM communities
     ORDER BY id DESC`
  );

  res.json(result.rows);
});

/* ----------------------------------------
   Rooms
----------------------------------------- */

app.post('/api/rooms', auth, async (req, res) => {
  const name = String(req.body.name || '').trim();
  const isPrivate = Boolean(req.body.isPrivate);
  const requireJoinCode = Boolean(req.body.requireJoinCode);
  const joinCode = requireJoinCode ? String(req.body.joinCode || '').trim() : null;

  if (!name) {
    return res.status(400).json({ error: 'ルーム名を入力してください' });
  }

  if (name.length > 100) {
    return res.status(400).json({ error: 'ルーム名が長すぎます' });
  }

  if (requireJoinCode && (!joinCode || joinCode.length < 4 || joinCode.length > 32)) {
    return res.status(400).json({
      error: '参加コードは4〜32文字で設定してください'
    });
  }

  const result = await pool.query(
    `INSERT INTO rooms(name, owner_id, is_private, require_join_code, join_code)
     VALUES($1, $2, $3, $4, $5)
     RETURNING id, name, owner_id, is_private, require_join_code, created_at`,
    [name, req.session.userId, isPrivate, requireJoinCode, joinCode]
  );

  const room = result.rows[0];

  await pool.query(
    `INSERT INTO room_members(room_id, user_id)
     VALUES($1, $2)`,
    [room.id, req.session.userId]
  );

  res.json(room);
});

app.get('/api/rooms/public', auth, async (req, res) => {
  const result = await pool.query(
    `SELECT
       r.id,
       r.name,
       r.owner_id,
       u.username AS owner_username,
       u.display_name AS owner_display_name,
       COUNT(rm.user_id)::int AS member_count
     FROM rooms r
     JOIN users u ON u.id = r.owner_id
     LEFT JOIN room_members rm ON rm.room_id = r.id
     WHERE r.is_private = FALSE
     GROUP BY r.id, u.username, u.display_name
     ORDER BY r.created_at DESC
     LIMIT 100`
  );

  res.json(result.rows);
});

app.get('/api/rooms/mine', auth, async (req, res) => {
  const admin = await isAdminUser(req.session.userId);

  if (admin) {
    const result = await pool.query(
      `SELECT
         r.id,
         r.name,
         r.owner_id,
         r.is_private,
         r.require_join_code,
         COUNT(rm.user_id)::int AS member_count
       FROM rooms r
       LEFT JOIN room_members rm ON rm.room_id = r.id
       GROUP BY r.id
       ORDER BY r.created_at DESC`
    );

    return res.json(result.rows);
  }

  const result = await pool.query(
    `SELECT
       r.id,
       r.name,
       r.owner_id,
       r.is_private,
       r.require_join_code,
       COUNT(rm.user_id)::int AS member_count
     FROM rooms r
     JOIN room_members mine
       ON mine.room_id = r.id
      AND mine.user_id = $1
     LEFT JOIN room_members rm ON rm.room_id = r.id
     GROUP BY r.id
     ORDER BY r.created_at DESC`,
    [req.session.userId]
  );

  res.json(result.rows);
});

app.get('/api/rooms/:id', auth, async (req, res) => {
  const roomId = Number(req.params.id);

  const result = await pool.query(
    `SELECT
       r.id,
       r.name,
       r.owner_id,
       r.is_private,
       r.require_join_code,
       u.username AS owner_username,
       u.display_name AS owner_display_name
     FROM rooms r
     LEFT JOIN users u ON u.id = r.owner_id
     WHERE r.id = $1`,
    [roomId]
  );

  if (!result.rowCount) {
    return res.status(404).json({ error: 'ルームがありません' });
  }

  const room = result.rows[0];
  room.is_member = await isRoomMember(req.session.userId, roomId);
  room.is_owner = room.owner_id === req.session.userId;
  room.is_admin = await isAdminUser(req.session.userId);

  res.json(room);
});

app.post('/api/rooms/join', auth, async (req, res) => {
  const roomId = Number(req.body.roomId);
  const joinCode = String(req.body.joinCode || '');

  const result = await pool.query(
    `SELECT id, name, owner_id, is_private, require_join_code, join_code
     FROM rooms WHERE id = $1`,
    [roomId]
  );

  if (!result.rowCount) {
    return res.status(404).json({ error: 'ルームがありません' });
  }

  const room = result.rows[0];

  if (room.owner_id === req.session.userId || await isAdminUser(req.session.userId)) {
    await pool.query(
      `INSERT INTO room_members(room_id, user_id)
       VALUES($1, $2)
       ON CONFLICT DO NOTHING`,
      [roomId, req.session.userId]
    );

    return res.json({ ok: true, roomId });
  }

  if (await isRoomBanned(req.session.userId, roomId)) {
    return res.status(403).json({ error: 'このルームからBANされています' });
  }

  if (room.is_private && !joinCode) {
    return res.status(403).json({ error: '参加コードが必要です' });
  }

  if (room.require_join_code && joinCode !== room.join_code) {
    return res.status(403).json({ error: '参加コードが違います' });
  }

  await pool.query(
    `INSERT INTO room_members(room_id, user_id)
     VALUES($1, $2)
     ON CONFLICT DO NOTHING`,
    [roomId, req.session.userId]
  );

  res.json({ ok: true, roomId });
});

app.post('/api/rooms/:id/leave', auth, async (req, res) => {
  const roomId = Number(req.params.id);

  if (await isRoomOwner(req.session.userId, roomId)) {
    return res.status(400).json({
      error: 'ルーム管理者は退室ではなくルーム削除を使用してください'
    });
  }

  await pool.query(
    'DELETE FROM room_members WHERE room_id = $1 AND user_id = $2',
    [roomId, req.session.userId]
  );

  res.json({ ok: true });
});

/* ----------------------------------------
   Room messages
----------------------------------------- */

app.get('/api/rooms/:id/messages', auth, async (req, res) => {
  const roomId = Number(req.params.id);
  const admin = await isAdminUser(req.session.userId);

  if (!admin && !(await isRoomMember(req.session.userId, roomId))) {
    return res.status(403).json({ error: 'ルームに参加していません' });
  }

  const result = await pool.query(
    `SELECT
       m.id,
       m.room_id,
       m.sender_id,
       m.content,
       m.image_url,
       m.deleted,
       m.reply_to_id,
       m.created_at,
       u.username,
       u.display_name,
       u.avatar_url
     FROM messages m
     JOIN users u ON u.id = m.sender_id
     WHERE m.room_id = $1
     ORDER BY m.created_at ASC
     LIMIT 500`,
    [roomId]
  );

  res.json(result.rows);
});

app.post('/api/rooms/:id/messages', auth, upload.single('image'), async (req, res) => {
  const roomId = Number(req.params.id);
  const text = String(req.body.content || '');
  const replyToId = req.body.replyToId ? Number(req.body.replyToId) : null;
  const imageUrl = req.file ? `/uploads/${req.file.filename}` : null;

  const admin = await isAdminUser(req.session.userId);

  if (!admin && !(await isRoomMember(req.session.userId, roomId))) {
    return res.status(403).json({ error: 'ルームに参加していません' });
  }

  if (await isRoomBanned(req.session.userId, roomId) && !admin) {
    return res.status(403).json({ error: 'このルームからBANされています' });
  }

  if (!text.trim() && !imageUrl) {
    return res.status(400).json({ error: '空のメッセージです' });
  }

  if (replyToId) {
    const reply = await pool.query(
      `SELECT id FROM messages
       WHERE id = $1 AND room_id = $2`,
      [replyToId, roomId]
    );

    if (!reply.rowCount) {
      return res.status(400).json({ error: '返信先メッセージが見つかりません' });
    }
  }

  const result = await pool.query(
    `INSERT INTO messages(room_id, sender_id, content, image_url, reply_to_id)
     VALUES($1, $2, $3, $4, $5)
     RETURNING *`,
    [roomId, req.session.userId, text, imageUrl, replyToId]
  );

  await writeChatLog({
    roomId,
    senderId: req.session.userId,
    messageId: result.rows[0].id,
    content: text,
    imageUrl
  });

  io.to(`r:${roomId}`).emit('message', result.rows[0]);

  res.json(result.rows[0]);
});

/* ----------------------------------------
   Room moderation
----------------------------------------- */

app.post('/api/rooms/:id/kick', auth, async (req, res) => {
  const roomId = Number(req.params.id);
  const targetUserId = Number(req.body.userId);
  const reason = String(req.body.reason || '').trim();

  if (!(await isRoomOwner(req.session.userId, roomId)) &&
      !(await isAdminUser(req.session.userId))) {
    return res.status(403).json({ error: '権限がありません' });
  }

  const targetAdmin = await isAdminUser(targetUserId);

  if (targetAdmin) {
    return res.status(403).json({
      error: 'Adminはルーム管理者からKickできません'
    });
  }

  await pool.query(
    `DELETE FROM room_members
     WHERE room_id = $1 AND user_id = $2`,
    [roomId, targetUserId]
  );

  await writeAdminLog({
    adminId: req.session.userId,
    action: 'KICK',
    roomId,
    targetUserId,
    detail: reason
  });

  await pool.query(
    `INSERT INTO notifications(user_id, type, title, content)
     VALUES($1, 'room_kick', 'ルームからKickされました', $2)`,
    [targetUserId, reason || 'ルーム管理者によるKick']
  );

  io.to(`u:${targetUserId}`).emit('roomKicked', { roomId });

  res.json({ ok: true });
});

app.post('/api/rooms/:id/ban', auth, async (req, res) => {
  const roomId = Number(req.params.id);
  const targetUserId = Number(req.body.userId);
  const reason = String(req.body.reason || '').trim();

  if (!(await isRoomOwner(req.session.userId, roomId)) &&
      !(await isAdminUser(req.session.userId))) {
    return res.status(403).json({ error: '権限がありません' });
  }

  if (targetUserId === req.session.userId) {
    return res.status(400).json({ error: '自分自身をBANできません' });
  }

  const targetAdmin = await isAdminUser(targetUserId);

  if (targetAdmin) {
    return res.status(403).json({
      error: 'AdminはBANできません'
    });
  }

  await pool.query(
    `INSERT INTO room_bans(room_id, user_id, banned_by, reason)
     VALUES($1, $2, $3, $4)
     ON CONFLICT(room_id, user_id)
     DO UPDATE SET banned_by = EXCLUDED.banned_by,
                   reason = EXCLUDED.reason,
                   created_at = NOW()`,
    [roomId, targetUserId, req.session.userId, reason]
  );

  await pool.query(
    `DELETE FROM room_members
     WHERE room_id = $1 AND user_id = $2`,
    [roomId, targetUserId]
  );

  await writeAdminLog({
    adminId: req.session.userId,
    action: 'BAN',
    roomId,
    targetUserId,
    detail: reason
  });

  await pool.query(
    `INSERT INTO notifications(user_id, type, title, content)
     VALUES($1, 'room_ban', 'ルームからBANされました', $2)`,
    [targetUserId, reason || 'ルーム管理者によるBAN']
  );

  io.to(`u:${targetUserId}`).emit('roomBanned', { roomId });

  res.json({ ok: true });
});

app.get('/api/rooms/:id/bans', auth, async (req, res) => {
  const roomId = Number(req.params.id);
  const admin = await isAdminUser(req.session.userId);

  if (!admin && !(await isRoomOwner(req.session.userId, roomId))) {
    return res.status(403).json({ error: '権限がありません' });
  }

  const result = await pool.query(
    `SELECT
       b.id,
       b.room_id,
       b.user_id,
       b.banned_by,
       b.reason,
       b.created_at,
       u.username,
       u.display_name,
       a.username AS banned_by_username
     FROM room_bans b
     JOIN users u ON u.id = b.user_id
     LEFT JOIN users a ON a.id = b.banned_by
     WHERE b.room_id = $1
     ORDER BY b.created_at DESC`,
    [roomId]
  );

  res.json(result.rows);
});

app.delete('/api/rooms/:id/bans/:userId', auth, async (req, res) => {
  const roomId = Number(req.params.id);
  const targetUserId = Number(req.params.userId);
  const admin = await isAdminUser(req.session.userId);

  if (!admin && !(await isRoomOwner(req.session.userId, roomId))) {
    return res.status(403).json({ error: '権限がありません' });
  }

  await pool.query(
    `DELETE FROM room_bans
     WHERE room_id = $1 AND user_id = $2`,
    [roomId, targetUserId]
  );

  await writeAdminLog({
    adminId: req.session.userId,
    action: 'UNBAN',
    roomId,
    targetUserId,
    detail: 'Room BAN解除'
  });

  res.json({ ok: true });
});

app.get('/api/rooms/:id/members', auth, async (req, res) => {
  const roomId = Number(req.params.id);
  const admin = await isAdminUser(req.session.userId);

  if (!admin && !(await isRoomMember(req.session.userId, roomId))) {
    return res.status(403).json({ error: 'アクセスできません' });
  }

  const result = await pool.query(
    `SELECT
       u.id,
       u.username,
       u.display_name,
       u.avatar_url,
       rm.joined_at,
       (r.owner_id = u.id) AS is_owner,
       u.is_admin
     FROM room_members rm
     JOIN users u ON u.id = rm.user_id
     JOIN rooms r ON r.id = rm.room_id
     WHERE rm.room_id = $1
     ORDER BY is_owner DESC, u.display_name`,
    [roomId]
  );

  for (const row of result.rows) {
    row.is_admin = await isAdminUser(row.id);
  }

  res.json(result.rows);
});

app.delete('/api/rooms/:id', auth, async (req, res) => {
  const roomId = Number(req.params.id);
  const owner = await isRoomOwner(req.session.userId, roomId);
  const admin = await isAdminUser(req.session.userId);

  if (!owner && !admin) {
    return res.status(403).json({ error: 'ルーム削除権限がありません' });
  }

  await writeAdminLog({
    adminId: req.session.userId,
    action: 'DELETE_ROOM',
    roomId,
    detail: admin && !owner ? 'Adminによるルーム削除' : 'ルーム管理者によるルーム削除'
  });

  await pool.query('DELETE FROM rooms WHERE id = $1', [roomId]);

  io.to(`r:${roomId}`).emit('roomDeleted', { roomId });

  res.json({ ok: true });
});

/* ----------------------------------------
   Global admin management
----------------------------------------- */

app.get('/api/admin/logs', requireAdmin, async (req, res) => {
  const result = await pool.query(
    `SELECT
       l.*,
       a.username AS admin_username,
       t.username AS target_username,
       r.name AS room_name
     FROM admin_logs l
     LEFT JOIN users a ON a.id = l.admin_id
     LEFT JOIN users t ON t.id = l.target_user_id
     LEFT JOIN rooms r ON r.id = l.room_id
     ORDER BY l.created_at DESC
     LIMIT 500`
  );

  res.json(result.rows);
});

app.get('/api/admin/rooms', requireAdmin, async (req, res) => {
  const result = await pool.query(
    `SELECT
       r.*,
       u.username AS owner_username,
       u.display_name AS owner_display_name,
       COUNT(rm.user_id)::int AS member_count
     FROM rooms r
     LEFT JOIN users u ON u.id = r.owner_id
     LEFT JOIN room_members rm ON rm.room_id = r.id
     GROUP BY r.id, u.username, u.display_name
     ORDER BY r.created_at DESC`
  );

  res.json(result.rows);
});

app.post('/api/admin/join-room', requireAdmin, async (req, res) => {
  const roomId = Number(req.body.roomId);

  if (!(await roomExists(roomId))) {
    return res.status(404).json({ error: 'ルームがありません' });
  }

  await pool.query(
    `INSERT INTO room_members(room_id, user_id)
     VALUES($1, $2)
     ON CONFLICT DO NOTHING`,
    [roomId, req.session.userId]
  );

  await writeAdminLog({
    adminId: req.session.userId,
    action: 'ADMIN_JOIN_ROOM',
    roomId,
    detail: 'Adminによる管理目的の参加'
  });

  res.json({ ok: true, roomId });
});

app.get('/api/admin/users', requireAdmin, async (req, res) => {
  const result = await pool.query(
    `SELECT
       id,
       username,
       display_name,
       avatar_url,
       is_admin,
       is_banned,
       created_at,
       last_online
     FROM users
     ORDER BY id DESC
     LIMIT 500`
  );

  for (const row of result.rows) {
    row.is_admin = await isAdminUser(row.id);
  }

  res.json(result.rows);
});

app.post('/api/admin/users/:id/ban', requireAdmin, async (req, res) => {
  const targetUserId = Number(req.params.id);
  const reason = String(req.body.reason || '').trim();

  if (targetUserId === req.session.userId) {
    return res.status(400).json({ error: '自分自身をBANできません' });
  }

  if (await isAdminUser(targetUserId)) {
    return res.status(403).json({ error: 'AdminはAdminからのみ変更できます' });
  }

  const result = await pool.query(
    `UPDATE users
     SET is_banned = TRUE
     WHERE id = $1
     RETURNING id`,
    [targetUserId]
  );

  if (!result.rowCount) {
    return res.status(404).json({ error: 'ユーザーが見つかりません' });
  }

  await writeAdminLog({
    adminId: req.session.userId,
    action: 'ACCOUNT_BAN',
    targetUserId,
    detail: reason
  });

  await pool.query(
    `INSERT INTO notifications(user_id, type, title, content)
     VALUES($1, 'account_ban', 'アカウント停止', $2)`,
    [targetUserId, reason || '管理者によるアカウント停止']
  );

  io.to(`u:${targetUserId}`).emit('accountBanned');

  res.json({ ok: true });
});

app.delete('/api/admin/users/:id/ban', requireAdmin, async (req, res) => {
  const targetUserId = Number(req.params.id);

  if (await isAdminUser(targetUserId)) {
    return res.status(403).json({ error: 'AdminのBAN状態はこの方法では変更できません' });
  }

  await pool.query(
    `UPDATE users
     SET is_banned = FALSE
     WHERE id = $1`,
    [targetUserId]
  );

  await writeAdminLog({
    adminId: req.session.userId,
    action: 'ACCOUNT_UNBAN',
    targetUserId,
    detail: 'アカウントBAN解除'
  });

  res.json({ ok: true });
});

app.get('/api/admin/reports', requireAdmin, async (req, res) => {
  const result = await pool.query(
    `SELECT
       r.*,
       reporter.username AS reporter_username,
       target.username AS target_username,
       rooms.name AS room_name
     FROM reports r
     LEFT JOIN users reporter ON reporter.id = r.reporter_id
     LEFT JOIN users target ON target.id = r.target_user_id
     LEFT JOIN rooms ON rooms.id = r.room_id
     ORDER BY r.created_at DESC
     LIMIT 500`
  );

  res.json(result.rows);
});

app.post('/api/reports', auth, async (req, res) => {
  const targetUserId = req.body.targetUserId ? Number(req.body.targetUserId) : null;
  const roomId = req.body.roomId ? Number(req.body.roomId) : null;
  const messageId = req.body.messageId ? Number(req.body.messageId) : null;
  const reason = String(req.body.reason || '').trim();

  if (!reason) {
    return res.status(400).json({ error: '通報理由を入力してください' });
  }

  await pool.query(
    `INSERT INTO reports(
       reporter_id, target_user_id, room_id, message_id, reason
     )
     VALUES($1, $2, $3, $4, $5)`,
    [req.session.userId, targetUserId, roomId, messageId, reason]
  );

  res.json({ ok: true });
});

app.post('/api/admin/reports/:id/resolve', requireAdmin, async (req, res) => {
  const reportId = Number(req.params.id);

  await pool.query(
    `UPDATE reports
     SET status = 'resolved'
     WHERE id = $1`,
    [reportId]
  );

  await writeAdminLog({
    adminId: req.session.userId,
    action: 'RESOLVE_REPORT',
    detail: `reportId=${reportId}`
  });

  res.json({ ok: true });
});

/* ----------------------------------------
   Static files
----------------------------------------- */

app.use(express.static(path.join(__dirname, 'public')));

/* ----------------------------------------
   Socket.IO
----------------------------------------- */

io.engine.use(sessionMiddleware);

io.use(async (socket, next) => {
  try {
    const userId = socket.request.session.userId;

    if (!userId) {
      return next(new Error('unauthorized'));
    }

    const result = await pool.query(
      'SELECT is_banned FROM users WHERE id = $1',
      [userId]
    );

    if (!result.rowCount || result.rows[0].is_banned) {
      return next(new Error('banned'));
    }

    next();
  } catch (error) {
    next(error);
  }
});

io.on('connection', socket => {
  const userId = socket.request.session.userId;

  socket.join(`u:${userId}`);

  socket.on('join', async roomId => {
    const id = Number(roomId);

    if (!(await roomExists(id))) return;

    const admin = await isAdminUser(userId);
    const member = await isRoomMember(userId, id);

    if (admin || member) {
      socket.join(`r:${id}`);
    }
  });

  socket.on('leave', roomId => {
    socket.leave(`r:${Number(roomId)}`);
  });
});

/* ----------------------------------------
   Start
----------------------------------------- */

async function startServer() {
  try {
    await db();

    server.listen(PORT, () => {
      console.log(`Cloud Cat running on port ${PORT}`);
      console.log('PostgreSQL connected and tables are ready.');
    });
  } catch (error) {
    console.error('データベース初期化エラー:', error);
    process.exit(1);
  }
}

startServer();
