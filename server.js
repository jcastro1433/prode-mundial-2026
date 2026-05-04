require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Database connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

const SECRET_KEY = process.env.SECRET_KEY || 'prode-secret-2026';

// Rutas de autenticación
app.post('/api/auth/login', async (req, res) => {
  const { name, code } = req.body;

  if (code !== 'POLIGSA26') {
    return res.status(401).json({ error: 'Código inválido' });
  }

  if (!name || name.trim() === '') {
    return res.status(400).json({ error: 'Nombre requerido' });
  }

  try {
    // Buscar o crear usuario
    const userResult = await pool.query(
      'SELECT id, name FROM users WHERE LOWER(name) = LOWER($1)',
      [name]
    );

    let userId;
    if (userResult.rows.length === 0) {
      // Crear nuevo usuario
      const createResult = await pool.query(
        'INSERT INTO users (name) VALUES ($1) RETURNING id, name',
        [name]
      );
      userId = createResult.rows[0].id;
    } else {
      userId = userResult.rows[0].id;
    }

    const token = jwt.sign({ userId, name }, SECRET_KEY, { expiresIn: '30d' });
    res.json({ token, userId, name });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Error en login' });
  }
});

// Middleware para verificar token
function verifyToken(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) {
    return res.status(401).json({ error: 'Token requerido' });
  }
  try {
    const decoded = jwt.verify(token, SECRET_KEY);
    req.userId = decoded.userId;
    req.userName = decoded.name;
    next();
  } catch (error) {
    res.status(401).json({ error: 'Token inválido' });
  }
}

// Get all matches
app.get('/api/matches', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM matches ORDER BY date ASC');
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching matches:', error);
    res.status(500).json({ error: 'Error fetching matches' });
  }
});

// Get user predictions
app.get('/api/predictions', verifyToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM predictions WHERE user_id = $1 ORDER BY match_id ASC',
      [req.userId]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching predictions:', error);
    res.status(500).json({ error: 'Error fetching predictions' });
  }
});

// Save prediction
app.post('/api/predictions', verifyToken, async (req, res) => {
  const { matchId, prediction, exactScore } = req.body;

  try {
    // Upsert prediction
    const result = await pool.query(
      `INSERT INTO predictions (user_id, match_id, prediction, exact_score)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, match_id)
       DO UPDATE SET prediction = $3, exact_score = $4, updated_at = NOW()
       RETURNING *`,
      [req.userId, matchId, prediction, exactScore]
    );
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error saving prediction:', error);
    res.status(500).json({ error: 'Error saving prediction' });
  }
});

// Get ranking
app.get('/api/ranking', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        u.id,
        u.name,
        COALESCE(SUM(
          CASE 
            WHEN p.prediction = CASE 
              WHEN m.score_home > m.score_away THEN 'local'
              WHEN m.score_home < m.score_away THEN 'visitante'
              ELSE 'empate'
            END THEN 1
            ELSE 0
          END
        ), 0) +
        COALESCE(SUM(
          CASE 
            WHEN m.score_home IS NOT NULL AND m.score_away IS NOT NULL
            AND p.exact_score = m.score_home || '-' || m.score_away THEN 1
            ELSE 0
          END
        ), 0) as points
      FROM users u
      LEFT JOIN predictions p ON u.id = p.user_id
      LEFT JOIN matches m ON p.match_id = m.id AND m.score_home IS NOT NULL
      GROUP BY u.id, u.name
      ORDER BY points DESC, u.name ASC
    `);
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching ranking:', error);
    res.status(500).json({ error: 'Error fetching ranking' });
  }
});

// ADMIN: Add/Update match result
app.post('/api/admin/matches/:matchId/result', async (req, res) => {
  const adminPassword = req.headers['x-admin-password'];
  const { scoreHome, scoreAway } = req.body;
  const { matchId } = req.params;

  if (adminPassword !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Admin password invalid' });
  }

  try {
    const result = await pool.query(
      `UPDATE matches 
       SET score_home = $1, score_away = $2, updated_at = NOW()
       WHERE id = $3
       RETURNING *`,
      [scoreHome, scoreAway, matchId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Match not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error updating match:', error);
    res.status(500).json({ error: 'Error updating match' });
  }
});

// ADMIN: Get all users (for admin panel)
app.get('/api/admin/users', async (req, res) => {
  const adminPassword = req.headers['x-admin-password'];

  if (adminPassword !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Admin password invalid' });
  }

  try {
    const result = await pool.query('SELECT id, name, created_at FROM users ORDER BY name ASC');
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching users:', error);
    res.status(500).json({ error: 'Error fetching users' });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
