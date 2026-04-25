require('dotenv').config();
const express = require('express');
const session = require('express-session');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const passport = require('passport');
const SteamStrategy = require('passport-steam').Strategy;
const path = require('path');

const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;

// Supabase клиент
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

console.log('✅ Supabase подключен');

// ========== ФУНКЦИИ РАБОТЫ С БД ==========
async function saveUser(profile) {
    const { data, error } = await supabase
        .from('users')
        .upsert({
            steam_id: profile.id,
            username: profile.displayName,
            avatar_url: profile._json?.avatarfull || '',
            last_login: new Date().toISOString()
        })
        .select()
        .single();
    
    if (error) throw error;
    return data;
}

async function getUserById(steamId) {
    const { data, error } = await supabase
        .from('users')
        .select('*')
        .eq('steam_id', steamId)
        .single();
    
    if (error && error.code !== 'PGRST116') throw error;
    return data;
}

async function saveDrop(steamId, dropData) {
    const { data, error } = await supabase
        .from('weekly_drops')
        .insert({
            steam_id: steamId,
            week_start: dropData.weekStart || null,
            week_end: dropData.weekEnd || null,
            date_range: dropData.dateRange || '',
            accounts: dropData.accounts || 0,
            total_price: dropData.totalPrice || 0,
            total_cases: dropData.totalCases || 0,
            cases_data: dropData.cases || [],
            skins_data: dropData.skins || []
        })
        .select();
    
    if (error) {
        console.error('Ошибка Supabase:', error);
        throw error;
    }
    return data[0];
}

async function getUserDrops(steamId) {
    const { data, error } = await supabase
        .from('weekly_drops')
        .select('*')
        .eq('steam_id', steamId)
        .order('created_at', { ascending: false });
    
    if (error) throw error;
    
    return data.map(row => ({
        ...row,
        cases: row.cases_data,
        skins: row.skins_data
    }));
}

async function deleteDrop(dropId, steamId) {
    const { error } = await supabase
        .from('weekly_drops')
        .delete()
        .eq('id', dropId)
        .eq('steam_id', steamId);
    
    if (error) throw error;
    return true;
}

// ========== ПОЛУЧЕНИЕ КАРТИНКИ СКИНА ЧЕРЕЗ STEAM API ==========
const imageCache = new Map();

app.get('/api/skin-image/:name', async (req, res) => {
    const skinName = decodeURIComponent(req.params.name);
    
    if (imageCache.has(skinName)) {
        return res.json({ url: imageCache.get(skinName) });
    }
    
    try {
        // 1. Получаем market_hash_name
        const searchUrl = `https://steamcommunity.com/market/priceoverview/?appid=730&currency=1&market_hash_name=${encodeURIComponent(skinName)}`;
        const searchRes = await fetch(searchUrl);
        const searchData = await searchRes.json();
        
        if (!searchData.success) {
            return res.json({ url: null, error: 'Скин не найден' });
        }
        
        // 2. Получаем classid через страницу предмета
        const classUrl = `https://steamcommunity.com/market/listings/730/${encodeURIComponent(skinName)}`;
        const classPage = await fetch(classUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });
        const classHtml = await classPage.text();
        
        // Ищем classid в HTML
        const classidMatch = classHtml.match(/Market_LoadOrderSpread\((\d+),/);
        if (!classidMatch) {
            return res.json({ url: null, error: 'ClassID не найден' });
        }
        const classid = classidMatch[1];
        
        // 3. Дёргаем официальное Steam API
        const apiUrl = `https://api.steampowered.com/ISteamEconomy/GetAssetClassInfo/v1/?appid=730&key=${process.env.STEAM_API_KEY}&class_count=1&classid0=${classid}`;
        const apiRes = await fetch(apiUrl);
        const apiData = await apiRes.json();
        
        const iconUrl = apiData.result?.assets?.[classid]?.icon_url;
        if (!iconUrl) {
            return res.json({ url: null, error: 'Иконка не найдена' });
        }
        
        // 4. Формируем полную ссылку на картинку
        const fullImageUrl = `https://steamcommunity-a.akamaihd.net/economy/image/${iconUrl}/512fx512f`;
        
        imageCache.set(skinName, fullImageUrl);
        res.json({ url: fullImageUrl });
        
    } catch (error) {
        console.error('Ошибка получения картинки:', error);
        res.status(500).json({ url: null, error: error.message });
    }
});

// ========== STEAM AUTH ==========
passport.use(new SteamStrategy({
    returnURL: `${process.env.STEAM_REALM}/auth/steam/callback`,
    realm: process.env.STEAM_REALM,
    apiKey: process.env.STEAM_API_KEY
}, async (identifier, profile, done) => {
    try {
        const user = await saveUser(profile);
        return done(null, user);
    } catch (err) {
        return done(err, null);
    }
}));

passport.serializeUser((user, done) => done(null, user.steam_id));
passport.deserializeUser(async (id, done) => {
    try {
        const user = await getUserById(id);
        done(null, user);
    } catch (err) {
        done(err, null);
    }
});

// ========== MIDDLEWARE ==========
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

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

// ========== API РОУТЫ ==========
app.get('/api/me', async (req, res) => {
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

app.get('/api/drops', async (req, res) => {
    if (!req.isAuthenticated()) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    try {
        const drops = await getUserDrops(req.user.steam_id);
        res.json({ success: true, data: drops });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/drops', async (req, res) => {
    if (!req.isAuthenticated()) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    try {
        const result = await saveDrop(req.user.steam_id, req.body);
        res.json({ success: true, id: result.id });
    } catch (err) {
        console.error('Ошибка при сохранении:', err);
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/drops/:id', async (req, res) => {
    if (!req.isAuthenticated()) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    try {
        await deleteDrop(req.params.id, req.user.steam_id);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ========== СТАТИКА (ФРОНТЕНД) ==========
app.use(express.static(path.join(__dirname, 'public')));

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
    console.log(`🚀 Сервер запущен на порту ${PORT}`);
});