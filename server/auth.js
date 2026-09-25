import crypto from 'node:crypto';
import express from 'express';
import { db } from './db.js';
import { ApiError } from './repo.js';

const SCRYPT_KEYLEN = 64;
const SALT_LEN = 32;
const TOKEN_BYTES = 48;
const RECOVERY_KEY_BYTES = 32;
const TOKEN_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000;

function hashPassword(password) {
  const salt = crypto.randomBytes(SALT_LEN);
  const derived = crypto.scryptSync(password, salt, SCRYPT_KEYLEN);
  return salt.toString('hex') + ':' + derived.toString('hex');
}

function verifyPassword(password, stored) {
  const [saltHex, keyHex] = stored.split(':');
  const salt = Buffer.from(saltHex, 'hex');
  const storedKey = Buffer.from(keyHex, 'hex');
  const derived = crypto.scryptSync(password, salt, SCRYPT_KEYLEN);
  return crypto.timingSafeEqual(derived, storedKey);
}

function generateToken() {
  return crypto.randomBytes(TOKEN_BYTES).toString('hex');
}

function generateRecoveryKey() {
  return crypto.randomBytes(RECOVERY_KEY_BYTES).toString('hex');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

const tokens = new Map();

function storeToken(token, userId) {
  const hashed = hashToken(token);
  tokens.set(hashed, { userId, expiresAt: Date.now() + TOKEN_EXPIRY_MS });
}

function validateToken(token) {
  const hashed = hashToken(token);
  const entry = tokens.get(hashed);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    tokens.delete(hashed);
    return null;
  }
  return entry.userId;
}

function revokeToken(token) {
  const hashed = hashToken(token);
  tokens.delete(hashed);
}

function revokeAllTokens() {
  tokens.clear();
}

export function hasUsers() {
  const row = db.prepare('SELECT COUNT(*) AS cnt FROM users').get();
  return row.cnt > 0;
}

export function authMiddleware(req, res, next) {
  if (!hasUsers()) return next();

  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentification requise.' });
  }

  const token = header.slice(7);
  const userId = validateToken(token);
  if (!userId) {
    return res.status(401).json({ error: 'Session expirée. Reconnectez-vous.' });
  }

  req.userId = userId;
  next();
}

function handle(fn) {
  return async (req, res) => {
    try {
      const result = await fn(req, res);
      if (result !== undefined && !res.headersSent) res.json(result);
    } catch (error) {
      if (error instanceof ApiError) {
        res.status(error.status).json({ error: error.message });
        return;
      }
      console.error('[auth]', error);
      res.status(500).json({ error: 'Erreur interne du serveur.' });
    }
  };
}

export function createAuthApi() {
  const router = express.Router();
  router.use(express.json());

  router.get('/status', handle(() => ({
    needsSetup: !hasUsers(),
  })));

  router.post('/setup', handle((req) => {
    if (hasUsers()) {
      throw new ApiError(400, 'Un compte existe déjà.');
    }

    const { username, password } = req.body;
    if (!username || typeof username !== 'string' || username.trim().length < 2) {
      throw new ApiError(400, "Le nom d'utilisateur doit contenir au moins 2 caractères.");
    }
    if (!password || typeof password !== 'string' || password.length < 6) {
      throw new ApiError(400, 'Le mot de passe doit contenir au moins 6 caractères.');
    }

    const recoveryKey = generateRecoveryKey();
    const passwordHash = hashPassword(password);
    const recoveryKeyHash = hashPassword(recoveryKey);
    const now = new Date().toISOString();

    db.prepare(
      'INSERT INTO users (username, password_hash, recovery_key_hash, created_at) VALUES (?, ?, ?, ?)'
    ).run(username.trim(), passwordHash, recoveryKeyHash, now);

    const user = db.prepare('SELECT id FROM users WHERE username = ?').get(username.trim());
    const token = generateToken();
    storeToken(token, user.id);

    return {
      ok: true,
      token,
      username: username.trim(),
      recoveryKey,
    };
  }));

  router.post('/login', handle((req) => {
    const { username, password } = req.body;
    if (!username || !password) {
      throw new ApiError(400, "Nom d'utilisateur et mot de passe requis.");
    }

    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username.trim());
    if (!user || !verifyPassword(password, user.password_hash)) {
      throw new ApiError(401, 'Identifiants incorrects.');
    }

    const token = generateToken();
    storeToken(token, user.id);

    return { ok: true, token, username: user.username };
  }));

  router.post('/logout', handle((req) => {
    const header = req.headers.authorization;
    if (header && header.startsWith('Bearer ')) {
      revokeToken(header.slice(7));
    }
    return { ok: true };
  }));

  router.post('/change-password', handle((req) => {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      throw new ApiError(401, 'Authentification requise.');
    }

    const token = header.slice(7);
    const userId = validateToken(token);
    if (!userId) {
      throw new ApiError(401, 'Session expirée.');
    }

    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      throw new ApiError(400, 'Mot de passe actuel et nouveau mot de passe requis.');
    }
    if (typeof newPassword !== 'string' || newPassword.length < 6) {
      throw new ApiError(400, 'Le nouveau mot de passe doit contenir au moins 6 caractères.');
    }

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    if (!user || !verifyPassword(currentPassword, user.password_hash)) {
      throw new ApiError(401, 'Mot de passe actuel incorrect.');
    }

    const recoveryKey = generateRecoveryKey();
    const newHash = hashPassword(newPassword);
    const newRecoveryHash = hashPassword(recoveryKey);

    db.prepare('UPDATE users SET password_hash = ?, recovery_key_hash = ? WHERE id = ?')
      .run(newHash, newRecoveryHash, userId);

    revokeAllTokens();
    const newToken = generateToken();
    storeToken(newToken, userId);

    return { ok: true, token: newToken, recoveryKey };
  }));

  router.post('/reset-password', handle((req) => {
    const { username, recoveryKey, newPassword } = req.body;
    if (!username || !recoveryKey || !newPassword) {
      throw new ApiError(400, 'Tous les champs sont requis.');
    }
    if (typeof newPassword !== 'string' || newPassword.length < 6) {
      throw new ApiError(400, 'Le nouveau mot de passe doit contenir au moins 6 caractères.');
    }

    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username.trim());
    if (!user || !verifyPassword(recoveryKey, user.recovery_key_hash)) {
      throw new ApiError(401, 'Clé de récupération invalide.');
    }

    const newRecoveryKey = generateRecoveryKey();
    const newHash = hashPassword(newPassword);
    const newRecoveryHash = hashPassword(newRecoveryKey);

    db.prepare('UPDATE users SET password_hash = ?, recovery_key_hash = ? WHERE id = ?')
      .run(newHash, newRecoveryHash, user.id);

    revokeAllTokens();
    const token = generateToken();
    storeToken(token, user.id);

    return { ok: true, token, username: user.username, recoveryKey: newRecoveryKey };
  }));

  return router;
}
