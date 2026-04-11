require('dotenv').config();
const express = require('express');
const session = require('express-session');
const cors = require('cors');
const Database = require('better-sqlite3');
const passport = require('passport');
const SteamStrategy = require('passport-steam').Strategy;
const path = require('path');

const app = express();
app.set('trust proxy', 1);

const PORT = process.env.PORT || 3000;

// База данных
const db = new Database('fsm_panel.db');

db.exec(`
    CREATE TABLE IF NOT EXISTS users (
        steam_id TEXT PRIMARY KEY,
        username TEXT,
        avatar_url TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_login DATETIME
    );

    CREATE TABLE IF NOT EXISTS weekly_drops (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        steam_id TEXT NOT NULL,
        week_start TEXT,
        week_end TEXT,
        date_range TEXT,
        accounts INTEGER,
        total_price REAL,
        total_cases INTEGER,
        cases_data TEXT,
        skins_data TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
`);

console.log('✅ База данных готова');

// Функции БД
function saveUser(profile) {
    const stmt = db.prepare(`
        INSERT INTO users (steam_id, username, avatar_url, last_login)
        VALUES (?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(steam_id) DO UPDATE SET
            username = excluded.username,
            avatar_url = excluded.avatar_url,
            last_login = CURRENT_TIMESTAMP
    `);
    stmt.run(profile.id, profile.displayName, profile._json?.avatarfull || '');
    return getUserById(profile.id);
}

function getUserById(steamId) {
    const stmt = db.prepare('SELECT * FROM users WHERE steam_id = ?');
    return stmt.get(steamId);
}

function saveDrop(steamId, data) {
    const stmt = db.prepare(`
        INSERT INTO weekly_drops (steam_id, week_start, week_end, date_range, accounts, total_price, total_cases, cases_data, skins_data)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    return stmt.run(
        steamId,
        data.weekStart || '',
        data.weekEnd || '',
        data.dateRange,
        data.accounts || 0,
        data.totalPrice || 0,
        data.totalCases || 0,
        JSON.stringify(data.cases || []),
        JSON.stringify(data.skins || [])
    );
}

function getUserDrops(steamId) {
    const stmt = db.prepare('SELECT * FROM weekly_drops WHERE steam_id = ? ORDER BY created_at DESC');
    const rows = stmt.all(steamId);
    return rows.map(row => ({
        ...row,
        cases: JSON.parse(row.cases_data),
        skins: JSON.parse(row.skins_data)
    }));
}

// Passport Steam
passport.use(new SteamStrategy({
    returnURL: `${process.env.STEAM_REALM}/auth/steam/callback`,
    realm: process.env.STEAM_REALM,
    apiKey: process.env.STEAM_API_KEY
}, (identifier, profile, done) => {
    const user = saveUser(profile);
    return done(null, user);
}));

passport.serializeUser((user, done) => done(null, user.steam_id));
passport.deserializeUser((id, done) => done(null, getUserById(id)));

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

// Сессии
app.use(session({
    secret: process.env.SESSION_SECRET || 'secretkey123',
    resave: false,
    saveUninitialized: false,
    name: 'fsm_session',
    proxy: true,
    cookie: { 
        secure: true,
        httpOnly: false,
        maxAge: 30 * 24 * 60 * 60 * 1000,
        sameSite: 'lax'
    }
}));

app.use(passport.initialize());
app.use(passport.session());

// API Роуты
app.get('/api/me', (req, res) => {
    if (req.isAuthenticated()) {
        res.json({ success: true, user: req.user });
    } else {
        res.json({ success: false, user: null });
    }
});

app.get('/auth/steam', passport.authenticate('steam'));

app.get('/auth/steam/callback',
    passport.authenticate('steam', { 
        successRedirect: '/',
        failureRedirect: '/'
    })
);

app.get('/auth/logout', (req, res) => {
    req.logout(() => {});
    res.redirect('/');
});

app.get('/api/drops', (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).json({ error: 'Unauthorized' });
    const drops = getUserDrops(req.user.steam_id);
    res.json({ success: true, data: drops });
});

app.post('/api/drops', (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).json({ error: 'Unauthorized' });
    const result = saveDrop(req.user.steam_id, req.body);
    res.json({ success: true, id: result.lastInsertRowid });
});

// Раздаём статику (фронтенд)
app.use(express.static(path.join(__dirname, 'public')));

// Все остальные роуты отдаём index.html
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
    console.log(`🚀 Сервер запущен на порту ${PORT}`);
});