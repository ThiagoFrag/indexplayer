const { Pool } = require('pg');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');
const FormData = require('form-data');
const { SocksProxyAgent } = require('socks-proxy-agent');

// ========== CONFIGURAÇÕES ==========
const CONFIG = {
    PARALLEL_WORKERS: 3,
    BATCH_SIZE: 50,
    PROXY_PORT: '1080',
    PROXY_FILE: './socks5-proxies.txt',
    TEMP_DIR: './temp',
    GOFILE_TOKEN: '4fd6sg89d7s6',
    DOWNLOAD_TIMEOUT: 10 * 60 * 1000,
    UPLOAD_TIMEOUT: 15 * 60 * 1000,
    API_TIMEOUT: 30000,
    CONTINUOUS: true,
    LOOP_DELAY: 30000,
    EXTRACT_SUBS: true,      // Extrair legendas
    EXTRACT_AUDIO: true,     // Manter múltiplos áudios
};

const pool = new Pool({
    user: 'postgres',
    host: 'localhost',
    database: 'goanime',
    password: '123',
    port: 5432,
    max: 10,
});

// ========== PROXY MANAGER ==========
class ProxyManager {
    constructor(filePath, port) {
        this.proxies = [];
        this.port = port;
        this.currentIdx = 0;
        
        if (fs.existsSync(filePath)) {
            const content = fs.readFileSync(filePath, 'utf-8');
            this.proxies = content.split('\n')
                .map(line => line.trim())
                .filter(line => line && !line.startsWith('#'));
            
            for (let i = this.proxies.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [this.proxies[i], this.proxies[j]] = [this.proxies[j], this.proxies[i]];
            }
            console.log(`📡 ${this.proxies.length} proxies SOCKS5`);
        }
    }
    
    createAgent() {
        if (this.proxies.length === 0) return null;
        const ip = this.proxies[this.currentIdx];
        this.currentIdx = (this.currentIdx + 1) % this.proxies.length;
        return new SocksProxyAgent(`socks5://${ip}:${this.port}`);
    }
}

// ========== GOFILE ==========
async function createGoFileAccount(proxyManager) {
    const agent = proxyManager?.createAgent();
    const config = agent ? { httpsAgent: agent, httpAgent: agent, timeout: CONFIG.API_TIMEOUT } : { timeout: CONFIG.API_TIMEOUT };
    const response = await axios.post('https://api.gofile.io/accounts', null, config);
    if (response.data.status === 'ok') return response.data.data.token;
    throw new Error('Falha ao criar conta GoFile');
}

async function getGoFileContent(contentId, token, proxyManager) {
    const agent = proxyManager?.createAgent();
    const config = agent ? { httpsAgent: agent, httpAgent: agent, timeout: CONFIG.API_TIMEOUT } : { timeout: CONFIG.API_TIMEOUT };
    const response = await axios.get(`https://api.gofile.io/contents/${contentId}`, {
        ...config,
        headers: { 'Authorization': `Bearer ${token}`, 'X-Website-Token': CONFIG.GOFILE_TOKEN }
    });
    if (response.data.status === 'ok') return response.data.data;
    throw new Error(response.data.status || 'Falha');
}

async function uploadToGoFile(filePath, proxyManager) {
    const agent1 = proxyManager?.createAgent();
    const config1 = agent1 ? { httpsAgent: agent1, httpAgent: agent1, timeout: CONFIG.API_TIMEOUT } : { timeout: CONFIG.API_TIMEOUT };
    const serversRes = await axios.get('https://api.gofile.io/servers', config1);
    const server = serversRes.data.data.servers[0].name;
    
    const form = new FormData();
    form.append('file', fs.createReadStream(filePath));
    
    const agent2 = proxyManager?.createAgent();
    const config2 = agent2 ? { httpsAgent: agent2, httpAgent: agent2 } : {};
    const uploadRes = await axios.post(`https://${server}.gofile.io/contents/uploadfile`, form, {
        ...config2,
        headers: form.getHeaders(),
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
        timeout: CONFIG.UPLOAD_TIMEOUT
    });
    
    if (uploadRes.data.status === 'ok') return uploadRes.data.data;
    throw new Error('Upload falhou');
}

// ========== FFPROBE/FFMPEG ==========
function getMediaInfo(inputPath) {
    return new Promise((resolve) => {
        const ffprobe = spawn('ffprobe', [
            '-v', 'quiet', '-print_format', 'json',
            '-show_streams', '-show_format', inputPath
        ]);
        
        let output = '';
        ffprobe.stdout.on('data', (d) => output += d.toString());
        ffprobe.on('close', () => {
            try {
                resolve(JSON.parse(output));
            } catch (e) {
                resolve({ streams: [] });
            }
        });
        ffprobe.on('error', () => resolve({ streams: [] }));
        setTimeout(() => { try { ffprobe.kill(); } catch(e){} resolve({ streams: [] }); }, 30000);
    });
}

function extractSubtitles(inputPath, outputDir, releaseId) {
    return new Promise(async (resolve) => {
        const info = await getMediaInfo(inputPath);
        const subStreams = info.streams?.filter(s => s.codec_type === 'subtitle') || [];
        
        if (subStreams.length === 0) {
            resolve([]);
            return;
        }
        
        const subtitles = [];
        
        for (let i = 0; i < subStreams.length; i++) {
            const stream = subStreams[i];
            const lang = stream.tags?.language || `sub${i}`;
            const title = stream.tags?.title || '';
            const codec = stream.codec_name;
            
            // Converter para VTT (formato web)
            const vttPath = path.join(outputDir, `${releaseId}_${lang}_${i}.vtt`);
            
            try {
                execSync(`ffmpeg -i "${inputPath}" -map 0:s:${i} -c:s webvtt -y "${vttPath}"`, {
                    timeout: 60000,
                    stdio: 'pipe'
                });
                
                if (fs.existsSync(vttPath) && fs.statSync(vttPath).size > 0) {
                    subtitles.push({
                        index: i,
                        language: lang,
                        title: title,
                        codec: codec,
                        path: vttPath
                    });
                }
            } catch (e) {
                // Algumas legendas podem não ser convertíveis
            }
        }
        
        resolve(subtitles);
    });
}

function getAudioTracks(inputPath) {
    return new Promise(async (resolve) => {
        const info = await getMediaInfo(inputPath);
        const audioStreams = info.streams?.filter(s => s.codec_type === 'audio') || [];
        
        resolve(audioStreams.map((s, i) => ({
            index: i,
            language: s.tags?.language || 'und',
            title: s.tags?.title || `Audio ${i + 1}`,
            codec: s.codec_name,
            channels: s.channels
        })));
    });
}

function convertToMp4WithTracks(inputPath, outputPath, audioTracks) {
    return new Promise(async (resolve, reject) => {
        const info = await getMediaInfo(inputPath);
        const videoStream = info.streams?.find(s => s.codec_type === 'video');
        const isHevc = videoStream?.codec_name?.includes('hevc') || videoStream?.codec_name?.includes('265');
        
        // Mapear vídeo + todos os áudios
        let args = ['-i', inputPath, '-map', '0:v:0'];
        
        // Adicionar todas as faixas de áudio
        for (let i = 0; i < Math.min(audioTracks.length, 8); i++) {
            args.push('-map', `0:a:${i}`);
        }
        
        // Codec de vídeo
        if (isHevc) {
            args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23');
        } else {
            args.push('-c:v', 'copy');
        }
        
        // Codec de áudio (AAC para compatibilidade)
        args.push('-c:a', 'aac', '-b:a', '192k');
        
        // Metadados das faixas de áudio
        audioTracks.forEach((track, i) => {
            if (track.language) args.push(`-metadata:s:a:${i}`, `language=${track.language}`);
            if (track.title) args.push(`-metadata:s:a:${i}`, `title=${track.title}`);
        });
        
        args.push('-movflags', '+faststart', '-y', outputPath);
        
        if (isHevc) console.log('      ⚠️ HEVC → H.264');
        if (audioTracks.length > 1) console.log(`      🔊 ${audioTracks.length} faixas de áudio`);
        
        const ffmpeg = spawn('ffmpeg', args);
        
        const timeout = setTimeout(() => {
            try { ffmpeg.kill('SIGKILL'); } catch(e){}
            reject(new Error('FFmpeg timeout'));
        }, 45 * 60 * 1000);
        
        ffmpeg.on('close', (code) => {
            clearTimeout(timeout);
            if (code === 0) resolve(true);
            else reject(new Error(`FFmpeg code ${code}`));
        });
        
        ffmpeg.on('error', (err) => {
            clearTimeout(timeout);
            reject(err);
        });
    });
}

// ========== DOWNLOAD ==========
async function downloadFile(url, outputPath, token, proxyManager) {
    const agent = proxyManager?.createAgent();
    const config = agent ? { httpsAgent: agent, httpAgent: agent } : {};
    
    const response = await axios({
        method: 'GET', url, responseType: 'stream', ...config,
        headers: { 'Cookie': `accountToken=${token}`, 'User-Agent': 'Mozilla/5.0' },
        timeout: CONFIG.DOWNLOAD_TIMEOUT
    });
    
    const writer = fs.createWriteStream(outputPath);
    response.data.pipe(writer);
    
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { writer.destroy(); reject(new Error('Download timeout')); }, CONFIG.DOWNLOAD_TIMEOUT);
        writer.on('finish', () => { clearTimeout(timeout); resolve(); });
        writer.on('error', (err) => { clearTimeout(timeout); reject(err); });
    });
}

// ========== UTILS ==========
const sleep = ms => new Promise(r => setTimeout(r, ms));
const formatBytes = b => b === 0 ? '0 B' : `${(b / 1024 / 1024).toFixed(1)} MB`;
function cleanupFiles(...files) {
    files.forEach(f => { try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch(e){} });
}

// ========== WORKER ==========
async function processVideo(video, workerId, proxyManager) {
    const { release_id, gofile_url, anime_title, release_name, anime_id } = video;
    const contentId = gofile_url.split('/').pop();
    const shortName = release_name?.substring(0, 40) || contentId;
    
    const inputPath = path.join(CONFIG.TEMP_DIR, `w${workerId}_${release_id}.mkv`);
    const outputPath = path.join(CONFIG.TEMP_DIR, `w${workerId}_${release_id}.mp4`);
    
    try {
        console.log(`[W${workerId}] 🎬 ${shortName}`);
        
        const token = await createGoFileAccount(proxyManager);
        const content = await getGoFileContent(contentId, token, proxyManager);
        
        const children = Object.values(content.children || {});
        const videoFile = children.find(c => c.type === 'file' && /\.(mkv|mp4|avi)$/i.test(c.name));
        
        if (!videoFile) {
            console.log(`[W${workerId}]    ⚠️ Sem vídeo`);
            return false;
        }
        
        const isMkv = /\.mkv$/i.test(videoFile.name);
        console.log(`[W${workerId}]    📁 ${formatBytes(videoFile.size)} ${isMkv ? 'MKV' : 'MP4'}`);
        
        // Se já é MP4
        if (!isMkv) {
            await pool.query(`
                INSERT INTO converted_videos (release_id, anime_title, original_filename, gofile_url, gofile_content_id)
                VALUES ($1, $2, $3, $4, $5) ON CONFLICT (release_id) DO NOTHING
            `, [release_id, anime_title, videoFile.name, gofile_url, contentId]);
            console.log(`[W${workerId}]    ✅ MP4 registrado`);
            return true;
        }
        
        // Download
        console.log(`[W${workerId}]    ⬇️ Baixando...`);
        await downloadFile(videoFile.link, inputPath, token, proxyManager);
        
        // Extrair legendas
        let subtitles = [];
        if (CONFIG.EXTRACT_SUBS) {
            console.log(`[W${workerId}]    📝 Extraindo legendas...`);
            subtitles = await extractSubtitles(inputPath, CONFIG.TEMP_DIR, release_id);
            if (subtitles.length > 0) {
                console.log(`[W${workerId}]    📝 ${subtitles.length} legendas encontradas`);
            }
        }
        
        // Obter faixas de áudio
        const audioTracks = await getAudioTracks(inputPath);
        
        // Converter
        console.log(`[W${workerId}]    🔄 Convertendo...`);
        await convertToMp4WithTracks(inputPath, outputPath, audioTracks);
        
        cleanupFiles(inputPath);
        
        // Upload vídeo
        console.log(`[W${workerId}]    ⬆️ Enviando vídeo...`);
        const uploadResult = await uploadToGoFile(outputPath, proxyManager);
        const newUrl = uploadResult.downloadPage;
        
        // Salvar vídeo no banco
        const mp4Name = videoFile.name.replace(/\.mkv$/i, '.mp4');
        const audioInfo = JSON.stringify(audioTracks);
        
        await pool.query(`
            INSERT INTO converted_videos (release_id, anime_title, original_filename, gofile_url, gofile_content_id)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (release_id) DO UPDATE SET gofile_url = EXCLUDED.gofile_url, converted_at = NOW()
        `, [release_id, anime_title, mp4Name, newUrl, uploadResult.fileId]);
        
        // Upload e salvar legendas
        for (const sub of subtitles) {
            try {
                console.log(`[W${workerId}]    📝 Enviando legenda ${sub.language}...`);
                const subUpload = await uploadToGoFile(sub.path, proxyManager);
                
                await pool.query(`
                    INSERT INTO subtitles (release_id, anime_id, language, format, gofile_url, source)
                    VALUES ($1, $2, $3, $4, $5, $6)
                    ON CONFLICT DO NOTHING
                `, [release_id, anime_id, sub.language, 'vtt', subUpload.downloadPage, sub.title || 'extracted']);
                
                cleanupFiles(sub.path);
            } catch (e) {
                console.log(`[W${workerId}]    ⚠️ Erro legenda: ${e.message}`);
            }
        }
        
        cleanupFiles(outputPath);
        console.log(`[W${workerId}]    ✅ Pronto! ${subtitles.length} legendas`);
        return true;
        
    } catch (error) {
        console.log(`[W${workerId}]    ❌ ${error.message.substring(0, 50)}`);
        cleanupFiles(inputPath, outputPath);
        return false;
    }
}

// ========== MAIN ==========
async function runBatch(proxyManager) {
    const result = await pool.query(`
        SELECT r.id as release_id, r.gofile_url, a.title as anime_title, 
               r.original_filename as release_name, a.id as anime_id
        FROM releases r
        JOIN animes a ON r.anime_id = a.id
        LEFT JOIN converted_videos cv ON r.id = cv.release_id
        WHERE r.gofile_url IS NOT NULL AND r.gofile_url != '' AND cv.id IS NULL
        ORDER BY RANDOM() LIMIT $1
    `, [CONFIG.BATCH_SIZE]);
    
    const videos = result.rows;
    if (videos.length === 0) {
        console.log('✅ Nenhum vídeo pendente!');
        return 0;
    }
    
    console.log(`\n📋 ${videos.length} vídeos...\n`);
    
    let completed = 0, errors = 0;
    const semaphore = { current: 0, max: CONFIG.PARALLEL_WORKERS };
    
    const processWithLimit = async (video, idx) => {
        while (semaphore.current >= semaphore.max) await sleep(500);
        semaphore.current++;
        try {
            if (await processVideo(video, (idx % CONFIG.PARALLEL_WORKERS) + 1, proxyManager)) completed++;
            else errors++;
        } finally {
            semaphore.current--;
        }
    };
    
    await Promise.all(videos.map((v, i) => processWithLimit(v, i)));
    console.log(`\n📊 ${completed} OK / ${errors} erros`);
    return videos.length;
}

async function main() {
    console.log('🎬 Conversor v3.0 (Legendas + Multi-Áudio)');
    console.log('==========================================\n');
    
    if (!fs.existsSync(CONFIG.TEMP_DIR)) fs.mkdirSync(CONFIG.TEMP_DIR, { recursive: true });
    
    const proxyManager = new ProxyManager(CONFIG.PROXY_FILE, CONFIG.PROXY_PORT);
    
    if (CONFIG.CONTINUOUS) {
        console.log('🔄 Modo contínuo\n');
        while (true) {
            try {
                const processed = await runBatch(proxyManager);
                if (processed === 0) {
                    console.log('💤 Aguardando 60s...');
                    await sleep(60000);
                } else {
                    console.log(`⏳ Próximo lote em ${CONFIG.LOOP_DELAY/1000}s...`);
                    await sleep(CONFIG.LOOP_DELAY);
                }
            } catch (error) {
                console.error('❌ Erro:', error.message);
                await sleep(10000);
            }
        }
    } else {
        await runBatch(proxyManager);
        await pool.end();
    }
}

process.on('SIGINT', async () => {
    console.log('\n🛑 Encerrando...');
    await pool.end();
    process.exit(0);
});

main().catch(console.error);
