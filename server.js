const express = require('express');
const { Pool } = require('pg');
const axios = require('axios');
const path = require('path');

const app = express();
const PORT = 3000;

// PostgreSQL connection
const pool = new Pool({
    user: 'postgres',
    password: '123',
    host: 'localhost',
    port: 5432,
    database: 'goanime'
});

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Get all animes
app.get('/api/animes', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT a.id, a.title, COUNT(r.id) as episode_count 
            FROM animes a 
            LEFT JOIN releases r ON a.id = r.anime_id 
            GROUP BY a.id, a.title 
            ORDER BY a.title
        `);
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// Get releases for an anime (prioriza convertidos)
app.get('/api/animes/:id/releases', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT 
                r.id, 
                r.original_filename, 
                COALESCE(cv.gofile_url, r.gofile_url) as gofile_url,
                r.resolution,
                CASE WHEN cv.id IS NOT NULL THEN true ELSE false END as is_converted
            FROM releases r
            LEFT JOIN converted_videos cv ON r.id = cv.release_id
            WHERE r.anime_id = $1 
            ORDER BY r.original_filename
        `, [req.params.id]);
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// Get direct video URL from GoFile using X-Website-Token
app.get('/api/gofile/:contentId', async (req, res) => {
    try {
        const contentId = req.params.contentId;
        
        // Create a guest account
        const accountResponse = await axios.post('https://api.gofile.io/accounts');
        const token = accountResponse.data.data.token;
        
        // Get content with X-Website-Token header (this is the key!)
        const contentResponse = await axios.get(
            `https://api.gofile.io/contents/${contentId}`,
            {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'X-Website-Token': '4fd6sg89d7s6'
                }
            }
        );
        
        if (contentResponse.data.status === 'ok') {
            const data = contentResponse.data.data;
            const children = data.children || {};
            
            const files = Object.values(children).filter(f => 
                f.type === 'file' && 
                (f.mimetype?.startsWith('video/') || f.name?.match(/\.(mp4|mkv|avi|webm)$/i))
            );
            
            if (files.length > 0) {
                res.json({
                    success: true,
                    files: files.map(f => ({
                        name: f.name,
                        url: f.link,
                        size: f.size,
                        mimetype: f.mimetype,
                        thumbnail: f.thumbnail,
                        id: f.id
                    })),
                    token: token
                });
            } else {
                // Return all files if no video found
                const allFiles = Object.values(children).filter(f => f.type === 'file');
                res.json({ 
                    success: true, 
                    files: allFiles.map(f => ({
                        name: f.name,
                        url: f.link,
                        size: f.size,
                        mimetype: f.mimetype,
                        id: f.id
                    })),
                    token: token
                });
            }
        } else {
            res.json({ 
                success: false, 
                error: contentResponse.data.status
            });
        }
    } catch (err) {
        console.error('GoFile Error:', err.response?.data || err.message);
        res.json({ 
            success: false, 
            error: err.response?.data?.status || err.message
        });
    }
});

// Proxy para streaming do vídeo
app.get('/api/stream/:contentId', async (req, res) => {
    try {
        const contentId = req.params.contentId;
        
        // Cria conta guest
        const accountResponse = await axios.post('https://api.gofile.io/accounts');
        const token = accountResponse.data.data.token;
        
        // Get content info
        const contentResponse = await axios.get(
            `https://api.gofile.io/contents/${contentId}`,
            {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'X-Website-Token': '4fd6sg89d7s6'
                }
            }
        );
        
        if (contentResponse.data.status === 'ok') {
            const children = contentResponse.data.data.children || {};
            const file = Object.values(children).find(f => f.type === 'file');
            
            if (file) {
                const videoUrl = file.link;
                
                const headers = {
                    'Cookie': `accountToken=${token}`,
                    'User-Agent': 'Mozilla/5.0',
                    'Referer': 'https://gofile.io/'
                };
                
                if (req.headers.range) {
                    headers['Range'] = req.headers.range;
                }
                
                const videoResponse = await axios({
                    method: 'get',
                    url: videoUrl,
                    headers: headers,
                    responseType: 'stream',
                    maxRedirects: 5
                });
                
                res.setHeader('Content-Type', 'video/mp4');
                if (videoResponse.headers['content-length']) {
                    res.setHeader('Content-Length', videoResponse.headers['content-length']);
                }
                if (videoResponse.headers['content-range']) {
                    res.setHeader('Content-Range', videoResponse.headers['content-range']);
                }
                res.setHeader('Accept-Ranges', 'bytes');
                
                res.status(videoResponse.status);
                videoResponse.data.pipe(res);
            } else {
                res.status(404).json({ error: 'Video not found' });
            }
        } else {
            res.status(400).json({ error: contentResponse.data.status });
        }
    } catch (err) {
        console.error('Stream Error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Stats de conversão com detalhes
app.get('/api/stats', async (req, res) => {
    try {
        const total = await pool.query('SELECT COUNT(*) FROM releases WHERE gofile_url IS NOT NULL');
        const converted = await pool.query('SELECT COUNT(*) FROM converted_videos');
        const recent = await pool.query(`
            SELECT cv.id, cv.release_id, cv.original_filename, cv.converted_at, a.title as anime_title,
                   (SELECT COUNT(*) FROM subtitles s WHERE s.release_id = cv.release_id) as subtitle_count
            FROM converted_videos cv
            JOIN releases r ON cv.release_id = r.id
            JOIN animes a ON r.anime_id = a.id
            ORDER BY cv.converted_at DESC
            LIMIT 10
        `);
        res.json({
            total: parseInt(total.rows[0].count),
            converted: parseInt(converted.rows[0].count),
            pending: parseInt(total.rows[0].count) - parseInt(converted.rows[0].count),
            recent: recent.rows
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Lista vídeos já convertidos (prontos para assistir)
app.get('/api/converted', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT 
                cv.id, 
                cv.release_id,
                cv.gofile_url,
                cv.original_filename,
                cv.converted_at,
                a.id as anime_id,
                a.title as anime_title,
                r.resolution,
                (SELECT COUNT(*) FROM subtitles s WHERE s.release_id = cv.release_id) as subtitle_count
            FROM converted_videos cv
            JOIN releases r ON cv.release_id = r.id
            JOIN animes a ON r.anime_id = a.id
            ORDER BY cv.converted_at DESC
            LIMIT 100
        `);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Search animes
app.get('/api/search', async (req, res) => {
    try {
        const query = req.query.q || '';
        const result = await pool.query(`
            SELECT a.id, a.title, COUNT(r.id) as episode_count 
            FROM animes a 
            LEFT JOIN releases r ON a.id = r.anime_id 
            WHERE a.title ILIKE $1
            GROUP BY a.id, a.title 
            ORDER BY a.title
            LIMIT 50
        `, [`%${query}%`]);
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// Get subtitles for a release
app.get('/api/subtitles/:releaseId', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT id, language, format, gofile_url, source
            FROM subtitles
            WHERE release_id = $1
            ORDER BY language
        `, [req.params.releaseId]);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Stream subtitle file (convert GoFile VTT to direct stream)
app.get('/api/subtitle-stream/:contentId', async (req, res) => {
    try {
        const contentId = req.params.contentId;
        
        const accountResponse = await axios.post('https://api.gofile.io/accounts');
        const token = accountResponse.data.data.token;
        
        const contentResponse = await axios.get(
            `https://api.gofile.io/contents/${contentId}`,
            {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'X-Website-Token': '4fd6sg89d7s6'
                }
            }
        );
        
        if (contentResponse.data.status === 'ok') {
            const children = contentResponse.data.data.children || {};
            const file = Object.values(children).find(f => f.type === 'file');
            
            if (file) {
                const subResponse = await axios({
                    method: 'GET',
                    url: file.link,
                    headers: {
                        'Cookie': `accountToken=${token}`,
                        'User-Agent': 'Mozilla/5.0'
                    },
                    responseType: 'text'
                });
                
                res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
                res.setHeader('Access-Control-Allow-Origin', '*');
                res.send(subResponse.data);
            } else {
                res.status(404).send('Subtitle not found');
            }
        } else {
            res.status(400).json({ error: contentResponse.data.status });
        }
    } catch (err) {
        console.error('Subtitle Error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});
