const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Chess } = require('chess.js');
const stockfish = require('stockfish');
const axios = require('axios');

const PORT = process.env.PORT || 3000;
const RENDER_EXTERNAL_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;

// URL Raw của GitHub Gist chứa giao diện HTML của bạn
const GIST_HTML_URL = 'https://gist.githubusercontent.com/opfkdr-gif/493574c699b41d7f35d5ce1da158a7db/raw/5ef6f4ea7399ee2265dd245b01b926300c8fa322/gistfile1.txt';

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use(express.json());

// ==========================================
// 0. TRANG DEFAULT: TẢI HTML TRỰC TIẾP TỪ GIST
// ==========================================
app.get('/', async (req, res) => {
    try {
        const response = await axios.get(GIST_HTML_URL);
        res.setHeader('Content-Type', 'text/html');
        res.status(200).send(response.data);
    } catch (err) {
        console.error('[Gist Loader Error]:', err.message);
        res.status(500).send(`
            <h2>Không thể tải giao diện từ GitHub Gist!</h2>
            <p>Lỗi: ${err.message}</p>
        `);
    }
});

// ==========================================
// 1. AUTO PING ĐỂ CHỐNG SLEEP TRÊN RENDER
// ==========================================
app.get('/ping', (req, res) => {
    res.status(200).send('OK - Server Active');
});

setInterval(async () => {
    try {
        await axios.get(`${RENDER_EXTERNAL_URL}/ping`);
        console.log(`[Self-Ping] Successfully pinged: ${RENDER_EXTERNAL_URL}/ping`);
    } catch (err) {
        console.error('[Self-Ping] Error:', err.message);
    }
}, 10 * 60 * 1000); // Mỗi 10 phút

// ==========================================
// 2. KHỞI TẠO STOCKFISH AN TOÀN (CHỐNG LỖI TYPEERROR)
// ==========================================
let engine = null;
try {
    engine = typeof stockfish === 'function' ? stockfish() : stockfish;
    if (engine && typeof engine.postMessage === 'function') {
        engine.postMessage('uci');
        engine.postMessage('setoption name Threads value 1');
        engine.postMessage('setoption name Hash value 8');
        engine.postMessage('isready');
        console.log('[Stockfish] Initialized successfully.');
    }
} catch (e) {
    console.warn('[Stockfish Warning] Engine could not be initialized:', e.message);
}

// Hàm đánh giá FEN an toàn (Không làm sập server nếu engine gặp sự cố)
function getFenScore(fen) {
    return new Promise((resolve) => {
        if (!engine || typeof engine.postMessage !== 'function') {
            return resolve(0); // Trả về điểm trung lập nếu không dùng được engine
        }

        let lastScore = 0;
        let resolved = false;

        const onMessage = (event) => {
            const line = typeof event === 'object' ? event.data : event;
            if (typeof line === 'string') {
                if (line.includes('score cp')) {
                    const match = line.match(/score cp (-?\d+)/);
                    if (match) lastScore = parseInt(match[1], 10);
                } else if (line.includes('score mate')) {
                    const match = line.match(/score mate (-?\d+)/);
                    if (match) {
                        const mateIn = parseInt(match[1], 10);
                        lastScore = mateIn > 0 ? 10000 - mateIn : -10000 - mateIn;
                    }
                } else if (line.startsWith('bestmove')) {
                    cleanup();
                    resolve(lastScore);
                }
            }
        };

        const cleanup = () => {
            if (!resolved) {
                resolved = true;
                if (engine.removeListener) engine.removeListener('message', onMessage);
            }
        };

        if (engine.on) engine.on('message', onMessage);
        else if (engine.onmessage !== undefined) engine.onmessage = onMessage;

        try {
            engine.postMessage(`position fen ${fen}`);
            engine.postMessage(`go depth 6`);
        } catch (err) {
            cleanup();
            resolve(0);
        }

        // Timeout phòng hờ trường hợp engine phản hồi chậm
        setTimeout(() => {
            cleanup();
            resolve(lastScore);
        }, 1500);
    });
}

// Phân loại nước đi theo chuẩn Chess.com
async function classifyMove(gameBefore, moveObject, plyCount) {
    if (plyCount <= 8) {
        return { classification: "Book", description: "Nước đi khai cuộc chuẩn" };
    }

    const fenBefore = gameBefore.fen();
    const tempGame = new Chess(fenBefore);
    const turn = tempGame.turn();

    const prevScore = await getFenScore(fenBefore);
    tempGame.move(moveObject);
    const fenAfter = tempGame.fen();
    const newScore = await getFenScore(fenAfter);

    let diff = (turn === 'w') ? (newScore - prevScore) : (prevScore - newScore);

    let classification = "Good";
    if (diff >= 150 && (moveObject.captured || moveObject.san.includes('+'))) {
        classification = "Brilliant";
    } else if (diff >= 50) {
        classification = "Great Find";
    } else if (diff >= -20) {
        classification = "Best";
    } else if (diff >= -80) {
        classification = "Inaccuracy";
    } else if (diff >= -200) {
        classification = "Mistake";
    } else {
        classification = "Blunder";
    }

    return { classification, centipawnChange: diff };
}

// ==========================================
// 3. MATCHMAKING & SOCKET.IO REALTIME
// ==========================================
let waitingPlayer = null;
const rooms = new Map();

io.on('connection', (socket) => {
    console.log(`[Socket] Connected: ${socket.id}`);

    socket.on('find_match', () => {
        if (waitingPlayer && waitingPlayer.id !== socket.id) {
            const roomId = `room_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
            const player1 = waitingPlayer;
            const player2 = socket;

            waitingPlayer = null;

            const newGame = new Chess();
            rooms.set(roomId, { game: newGame, players: { white: player1.id, black: player2.id } });

            player1.join(roomId);
            player2.join(roomId);

            io.to(player1.id).emit('match_found', { roomId, color: 'white', fen: newGame.fen() });
            io.to(player2.id).emit('match_found', { roomId, color: 'black', fen: newGame.fen() });
        } else {
            waitingPlayer = socket;
            socket.emit('waiting_for_match', { message: 'Đang tìm đối thủ...' });
        }
    });

    socket.on('create_custom_room', () => {
        const roomId = `custom_${Math.floor(1000 + Math.random() * 9000)}`;
        rooms.set(roomId, { game: new Chess(), players: { white: socket.id, black: null } });
        socket.join(roomId);
        socket.emit('custom_room_created', { roomId, color: 'white' });
    });

    socket.on('join_custom_room', (data) => {
        const { roomId } = data;
        const room = rooms.get(roomId);

        if (room && !room.players.black) {
            room.players.black = socket.id;
            socket.join(roomId);

            io.to(room.players.white).emit('match_found', { roomId, color: 'white', fen: room.game.fen() });
            io.to(socket.id).emit('match_found', { roomId, color: 'black', fen: room.game.fen() });
        } else {
            socket.emit('error_message', 'Phòng không tồn tại hoặc đã đủ người!');
        }
    });

    socket.on('make_move', async (data) => {
        const { roomId, move } = data;
        const room = rooms.get(roomId);

        if (!room) return socket.emit('error_message', 'Phòng chơi không hợp lệ!');

        const game = room.game;
        const currentTurnColor = game.turn() === 'w' ? 'white' : 'black';

        if (room.players[currentTurnColor] !== socket.id) {
            return socket.emit('error_message', 'Chưa tới lượt của bạn!');
        }

        const gameBefore = new Chess(game.fen());

        let moveResult = null;
        try {
            moveResult = game.move(move);
        } catch (e) {
            moveResult = null;
        }

        if (!moveResult) {
            return socket.emit('invalid_move', { message: 'Nước đi không hợp lệ!', currentFen: game.fen() });
        }

        const plyCount = game.history().length;
        const evaluation = await classifyMove(gameBefore, moveResult, plyCount);

        io.to(roomId).emit('move_made', {
            move: moveResult,
            fen: game.fen(),
            turn: game.turn(),
            isCheck: game.inCheck(),
            isGameOver: game.isGameOver(),
            evaluation
        });

        if (game.isGameOver()) {
            let reason = "Game Over";
            if (game.isCheckmate()) reason = "Checkmate";
            else if (game.isDraw()) reason = "Draw";

            io.to(roomId).emit('game_over', { reason, winner: currentTurnColor });
            rooms.delete(roomId);
        }
    });

    socket.on('disconnect', () => {
        if (waitingPlayer && waitingPlayer.id === socket.id) {
            waitingPlayer = null;
        }
    });
});

server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
