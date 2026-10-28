const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Chess } = require('chess.js');
const axios = require('axios');

const PORT = process.env.PORT || 3000;
const RENDER_EXTERNAL_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;

// URL Raw của GitHub Gist chứa giao diện HTML của bạn
const GIST_HTML_URL = 'https://gist.githubusercontent.com/opfkdr-gif/493574c699b41d7f35d5ce1da158a7db/raw/94b35dd5d9b47b85ac89c3d5fa493d2ceece12cb/gistfile1.txt';

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
// 2. MATCHMAKING & SOCKET.IO REALTIME
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

    socket.on('make_move', (data) => {
        const { roomId, move } = data;
        const room = rooms.get(roomId);

        if (!room) return socket.emit('error_message', 'Phòng chơi không hợp lệ!');

        const game = room.game;
        const currentTurnColor = game.turn() === 'w' ? 'white' : 'black';

        if (room.players[currentTurnColor] !== socket.id) {
            return socket.emit('error_message', 'Chưa tới lượt của bạn!');
        }

        let moveResult = null;
        try {
            moveResult = game.move(move);
        } catch (e) {
            moveResult = null;
        }

        if (!moveResult) {
            return socket.emit('invalid_move', { message: 'Nước đi không hợp lệ!', currentFen: game.fen() });
        }

        // Bắn thông báo nước đi thành công kèm theo FEN hiện tại để client tự chấm điểm
        io.to(roomId).emit('move_made', {
            move: moveResult,
            fen: game.fen(),
            turn: game.turn(),
            isCheck: game.inCheck(),
            isGameOver: game.isGameOver()
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
